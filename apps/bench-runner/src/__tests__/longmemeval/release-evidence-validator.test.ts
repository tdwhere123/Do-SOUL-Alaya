import { gzipSync } from "node:zlib";
import {
  KpiPayloadSchema,
  type KpiPayload
} from "@do-soul/alaya-eval";
import { describe, expect, it } from "vitest";
import {
  buildFullLongMemEvalPayload,
  selectionContractForRows
} from "../../../../../packages/eval/src/__tests__/history/history-fixture.js";
import { summarizeProviderStates } from
  "../../longmemeval/diagnostics-question.js";
import type { LongMemEvalQuestionDiagnostic } from
  "../../longmemeval/diagnostics-types.js";
import { validateLongMemEvalReleaseDiagnostics } from
  "../../longmemeval/diagnostics/release-evidence-validator.js";
import { measurementDiagnostic } from
  "./specialized-answerable-recall-fixture.js";

describe("LongMemEval release diagnostics acceptance and identity", () => {
  it("accepts a schema-valid 500-question 470+30 artifact", async () => {
    const fixture = releaseFixture();

    expect(fixture.payload).toMatchObject({
      evaluated_count: 500,
      answerable_evaluated_count: 470
    });
    await expect(validateLongMemEvalReleaseDiagnostics(fixture)).resolves.toBeUndefined();
  });

  it.each(identityDrifts())("rejects %s identity drift", async (_label, mutate) => {
    await expect(validateLongMemEvalReleaseDiagnostics(
      releaseFixture(mutate)
    )).rejects.toThrow(/identity/u);
  });
});

describe("LongMemEval release diagnostics question binding", () => {
  it.each(questionDrifts())("rejects %s question drift", async (_label, mutate) => {
    await expect(validateLongMemEvalReleaseDiagnostics(
      releaseFixture(mutate)
    )).rejects.toThrow();
  });
});

describe("LongMemEval release diagnostics provider binding", () => {
  it("rejects a KPI overall aggregate drift", async () => {
    const fixture = releaseFixture(undefined, (payload) => ({
      ...payload,
      kpi: { ...payload.kpi, r_at_5_overall: 0.93 }
    }));

    await expect(validateLongMemEvalReleaseDiagnostics(fixture)).rejects.toThrow(/provider rates/u);
  });

  it("rejects a KPI provider-rate drift", async () => {
    const fixture = releaseFixture(undefined, (payload) => ({
      ...payload,
      kpi: { ...payload.kpi, provider_not_requested_rate: 0.99 }
    }));

    await expect(validateLongMemEvalReleaseDiagnostics(fixture)).rejects.toThrow(/provider rates/u);
  });

  it("rejects a missing provider summary", async () => {
    const fixture = releaseFixture((sidecar) => {
      delete sidecar.provider_state_summary;
    });

    await expect(validateLongMemEvalReleaseDiagnostics(fixture)).rejects.toThrow();
  });

  it("rejects a self-consistent provider request in disabled mode", async () => {
    const fixture = releaseFixture((sidecar) => {
      sidecar.questions[0]!.provider_state = "unknown";
      sidecar.provider_state_summary = summarizeProviderStates(sidecar.questions);
    });

    await expect(validateLongMemEvalReleaseDiagnostics(fixture)).rejects.toThrow(/disabled/u);
  });

  it("allows an honest unknown provider state in env mode", async () => {
    const fixture = releaseFixture((sidecar) => {
      for (const question of sidecar.questions) question.provider_state = "unknown";
      sidecar.provider_state_summary = summarizeProviderStates(sidecar.questions);
    }, (payload) => ({ ...payload, embedding_provider: "openai:test" }));

    await expect(validateLongMemEvalReleaseDiagnostics(fixture)).resolves.toBeUndefined();
  });
});

type MutableQuestion = LongMemEvalQuestionDiagnostic & {
  question_id: string;
  hit_at_1: boolean;
  hit_at_5: boolean;
  hit_at_10: boolean;
  recall_diagnostics_present: boolean;
  candidate_pool_complete: boolean;
  provider_state: LongMemEvalQuestionDiagnostic["provider_state"];
  cohort_ledger: NonNullable<LongMemEvalQuestionDiagnostic["cohort_ledger"]> & {
    measurement_status?: "scorable" | "abstention_unscorable" |
      "evaluator_identity_unscorable";
    dataset_cohort: "answerable" | "abstention" | "adjudicated_invalid";
    evidence_status: "complete" | "partial" | "missing";
    candidate_pool_complete: boolean;
    retrieval_status: "hit_at_5" | "miss_at_5" | "not_applicable";
    evaluation_issue_reason: string | null;
    final_verdict: string;
  };
};

interface MutableSidecar {
  bench_name: "public" | "public-multiturn" | "public-crossquestion" | "public-locomo";
  split: string;
  run_at: string;
  alaya_commit: string;
  recall_pipeline_version?: string;
  embedding_provider: string;
  embedding_mode: "disabled" | "env";
  policy_shape?: "stress" | "chat";
  simulate_report?: "none" | "always-used" | "gold-only" | "mixed";
  seed_extraction_path?: NonNullable<KpiPayload["kpi"]["seed_extraction_path"]>;
  report_usage?: { mode: "none" | "always-used" | "gold-only" | "mixed" };
  provider_state_summary?: ReturnType<typeof summarizeProviderStates>;
  questions: MutableQuestion[];
}

type SidecarMutation = (sidecar: MutableSidecar) => void;
type PayloadMutation = (payload: KpiPayload) => KpiPayload;

function identityDrifts(): readonly [string, SidecarMutation][] {
  return [
    ["bench_name", (sidecar) => { sidecar.bench_name = "public-multiturn"; }],
    ["split", (sidecar) => { sidecar.split = "longmemeval-m"; }],
    ["run_at", (sidecar) => { sidecar.run_at = "2099-01-01T00:00:00Z"; }],
    ["commit", (sidecar) => { sidecar.alaya_commit = "forged1"; }],
    ["provider", (sidecar) => { sidecar.embedding_provider = "forged"; }],
    ["policy_shape", (sidecar) => { sidecar.policy_shape = "chat"; }],
    ["simulate_report", (sidecar) => { sidecar.simulate_report = "mixed"; }],
    ["report_usage", (sidecar) => { sidecar.report_usage!.mode = "mixed"; }],
    ["pipeline", (sidecar) => { sidecar.recall_pipeline_version = "forged"; }],
    ["embedding_mode", (sidecar) => { sidecar.embedding_mode = "env"; }],
    ["seed path", (sidecar) => { sidecar.seed_extraction_path!.cache_hits += 1; }]
  ];
}

function questionDrifts(): readonly [string, SidecarMutation][] {
  return [
    ["question id", (sidecar) => { sidecar.questions[0]!.question_id = "forged"; }],
    ["question order", swapFirstQuestions],
    ["question count", (sidecar) => { sidecar.questions.pop(); }],
    ["hit_at_1", (sidecar) => { sidecar.questions[0]!.hit_at_1 = false; }],
    ["hit_at_5", (sidecar) => { sidecar.questions[0]!.hit_at_5 = false; }],
    ["hit_at_10", (sidecar) => { sidecar.questions[0]!.hit_at_10 = false; }],
    ["measurement status", (sidecar) => makeIdentityUnscorable(sidecar.questions[0]!)],
    ["top-level candidate pool", (sidecar) => {
      sidecar.questions[0]!.candidate_pool_complete = false;
    }],
    ["ledger candidate pool", (sidecar) => {
      sidecar.questions[0]!.cohort_ledger.candidate_pool_complete = false;
    }],
    ["ledger evidence", (sidecar) => {
      sidecar.questions[0]!.cohort_ledger.evidence_status = "partial";
    }],
    ["recall diagnostics", (sidecar) => {
      sidecar.questions[0]!.recall_diagnostics_present = false;
    }],
    ["provider summary", (sidecar) => {
      const summary = sidecar.provider_state_summary! as { provider_not_requested: number };
      summary.provider_not_requested -= 1;
    }]
  ];
}

function swapFirstQuestions(sidecar: MutableSidecar): void {
  const first = sidecar.questions[0]!;
  sidecar.questions[0] = sidecar.questions[1]!;
  sidecar.questions[1] = first;
}

function makeIdentityUnscorable(question: MutableQuestion): void {
  question.cohort_ledger.measurement_status = "evaluator_identity_unscorable";
  question.cohort_ledger.retrieval_status = "not_applicable";
  question.cohort_ledger.evaluation_issue_reason =
    "evaluator_data_identity_inconsistency";
  question.cohort_ledger.final_verdict = "evaluator_data_identity_inconsistency";
}

function releaseFixture(
  mutateSidecar?: SidecarMutation,
  mutatePayload?: PayloadMutation
) {
  const base = releasePayload();
  const payload = KpiPayloadSchema.parse(mutatePayload?.(base) ?? base);
  const sidecar = releaseSidecar(payload) as unknown as MutableSidecar;
  mutateSidecar?.(sidecar);
  return { contents: gzipSync(`${JSON.stringify(sidecar)}\n`), payload };
}

function releasePayload(): KpiPayload {
  const base = buildFullLongMemEvalPayload("public", "abc1234", 1);
  const rows = releaseRows();
  return KpiPayloadSchema.parse({
    ...base,
    recall_pipeline_version: "recall-eval-v1",
    answerable_evaluated_count: 470,
    selection_contract: selectionContractForRows(rows),
    kpi: {
      ...base.kpi,
      r_at_1: 1,
      r_at_5: 1,
      r_at_10: 1,
      r_at_5_overall: 0.94,
      per_scenario: rows,
      quality_metrics: releaseQualityMetrics(base.kpi.quality_metrics!)
    }
  });
}

function releaseRows(): KpiPayload["kpi"]["per_scenario"] {
  return Array.from({ length: 500 }, (_, index) => ({
    id: index < 470 ? `question-${index + 1}` : `question-${index + 1}_abs`,
    version: 1,
    hit_at_5: index < 470,
    scorable: index < 470,
    measurement_cohort: index < 470
      ? "answerable" as const
      : "dataset_declared_abstention" as const,
    tier: "hot" as const
  }));
}

function releaseQualityMetrics(
  base: NonNullable<KpiPayload["kpi"]["quality_metrics"]>
) {
  return {
    ...base,
    measurement_cohort_counts: {
      evaluated: 500,
      non_abstention: 470,
      abstention: 30,
      scorable_answerable: 470,
      unscorable_answerable: 0,
      hit_at_5: 470,
      miss_at_5: 0
    },
    unscorable_reason_distribution: { abstention_uncalibrated: 30 },
    abstention: {
      schema_version: "bench-abstention.v2" as const,
      total: 30,
      scored: 0,
      unscorable: 30,
      method: "fused_margin_diagnostic_only" as const,
      calibration_status: "uncalibrated" as const,
      gate_eligible: false as const
    }
  };
}

function releaseSidecar(payload: KpiPayload) {
  const questions = payload.kpi.per_scenario.map((row) => ({
    ...measurementDiagnostic(
      row.id,
      row.scorable === true ? "scorable" : "abstention",
      row.hit_at_5
    ),
    provider_state: "provider_not_requested" as const
  }));
  return {
    schema_version: 1 as const,
    bench_name: payload.bench_name,
    split: payload.split,
    run_at: payload.run_at,
    alaya_commit: payload.alaya_commit,
    recall_pipeline_version: payload.recall_pipeline_version,
    embedding_provider: payload.embedding_provider,
    embedding_mode: payload.embedding_provider === "none" ? "disabled" as const : "env" as const,
    policy_shape: payload.policy_shape,
    simulate_report: payload.simulate_report,
    seed_extraction_path: payload.kpi.seed_extraction_path === undefined
      ? undefined
      : structuredClone(payload.kpi.seed_extraction_path),
    report_usage: {
      mode: payload.simulate_report,
      reports_attempted: 0,
      reports_used: 0,
      reports_skipped: 500,
      used_object_count: 0
    },
    provider_state_summary: summarizeProviderStates(questions),
    questions
  };
}
