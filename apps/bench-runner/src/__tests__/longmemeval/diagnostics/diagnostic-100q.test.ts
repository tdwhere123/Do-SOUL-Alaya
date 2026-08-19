import { describe, expect, it } from "vitest";
import {
  DIAGNOSTIC_500Q_CLOSED,
  compareF0F2VsCachedF3,
  mapQuestionToDiagnosticStage
} from "../../../bench/diagnostics/stage-attribution/diagnostic-100q.js";
import { buildTreatmentExposureReceipts } from
  "../../../bench/diagnostics/stage-attribution/exposure/build-receipts.js";
import { sealTreatmentExposureReceipt } from
  "../../../bench/diagnostics/stage-attribution/exposure/contract.js";
import { assertTreatmentExposureReceipt } from
  "../../../bench/diagnostics/stage-attribution/exposure/contract.js";
import { readDiagnostic100QComparisonArtifact } from
  "../../../bench/diagnostics/stage-attribution/exposure/comparison-artifact.js";
import type { QuestionStageRow } from "../../../bench/diagnostics/stage-attribution/types.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestRecallFieldIdentity } from "@do-soul/alaya-core";
import { OpenSemanticFactorCandidateActivationsSchema } from
  "../../../bench/diagnostics/schema/field/open-semantic-candidate-activation-schema.js";

describe("diagnostic 100Q stage map", () => {
  it("maps the earliest failed stage and keeps 500Q closed", () => {
    expect(DIAGNOSTIC_500Q_CLOSED).toBe(true);
    expect(mapQuestionToDiagnosticStage(row({
      stage: 1, proof: "empty_gold_or_write_loss", miss_taxonomy: "evaluation_or_gold_issue"
    }))).toBe("S0");
    expect(mapQuestionToDiagnosticStage(row({
      stage: 1, proof: "extraction_materialization_drop"
    }))).toBe("S1");
    expect(mapQuestionToDiagnosticStage(row({
      stage: 2, proof: "semantic_factor_formation_rejected"
    }))).toBe("S2");
    expect(mapQuestionToDiagnosticStage(row({
      stage: 2, proof: "semantic_factor_formation_unavailable"
    }))).toBe("S3");
    expect(mapQuestionToDiagnosticStage(row({
      stage: 2, proof: "miss_taxonomy.candidate_absent_with_emitted_gold"
    }))).toBe("S3");
    expect(mapQuestionToDiagnosticStage(row({
      stage: 5, proof: "miss_taxonomy.budget_drop"
    }))).toBe("S4");
    expect(mapQuestionToDiagnosticStage(row({
      stage: 7, hit_at_5: true, proof: "hit_at_5"
    }))).toBe("S5");
  });

  it("compares F0-F2 control with cached-F3 treatment without provider calls", () => {
    const comparison = compareF0F2VsCachedF3({
      control: [
        row({ question_id: "q-improved", stage: 2, proof: "candidate_absent" }),
        row({ question_id: "q-still", stage: 5, proof: "budget_drop" })
      ],
      treatment: [
        row({ question_id: "q-improved", stage: 7, hit_at_5: true, proof: "hit_at_5" }),
        row({ question_id: "q-still", stage: 5, proof: "budget_drop" })
      ],
      treatmentExposure: [
        exposure("q-improved", "exposed", true, {
          control: { stage: "S3", hit_at_5: false },
          treatment: { stage: "S5", hit_at_5: true }
        }),
        exposure("q-still", "exposed", false)
      ]
    });
    expect(comparison.physical_calls).toBe(0);
    expect(comparison.five_hundred_q_closed).toBe(true);
    expect(comparison.membership_improved).toEqual(["q-improved"]);
    expect(comparison.still_missing).toEqual(["q-still"]);
    expect(comparison.not_exercised).toEqual([]);
    expect(comparison.inconclusive).toEqual([]);
    expect(comparison.exposed_denominator_gate).toMatchObject({
      declared_minimum_rate: 1,
      exposed_count: 2,
      evaluated_count: 2,
      passed: true
    });
    expect(comparison.causal_comparison_status).toBe("eligible");
    expect(comparison.control_misses.S3).toBe(1);
    expect(comparison.treatment_misses.S4).toBe(1);
  });

  it("does not call an unexposed treatment miss still_missing", () => {
    const comparison = compareF0F2VsCachedF3({
      control: [row({ question_id: "q-unexposed", stage: 5, proof: "budget_drop" })],
      treatment: [row({ question_id: "q-unexposed", stage: 5, proof: "budget_drop" })],
      treatmentExposure: [exposure("q-unexposed", "not_exercised", false)]
    });

    expect(comparison.still_missing).toEqual([]);
    expect(comparison.not_exercised).toEqual(["q-unexposed"]);
    expect(comparison.exposed_denominator_gate.passed).toBe(false);
    expect(comparison.causal_comparison_status).toBe("inconclusive");
  });

  it("requires formation through activation and records membership delta", () => {
    const receipts = buildTreatmentExposureReceipts({
      control: [diagnostic("q1", [])],
      treatment: [diagnostic("q1", ["candidate:f3"], true)],
      controlStages: [row({ question_id: "q1", stage: 5, proof: "budget_drop" })],
      treatmentStages: [row({ question_id: "q1", stage: 5, proof: "budget_drop" })]
    });

    expect(receipts[0]).toMatchObject({
      question_id: "q1",
      exposure_status: "exposed",
      formation: { status: "formed" },
      compatible_evidence: { compatible_count: 1 },
      composition: { solution_count: 1 },
      activation: { activated_evidence_count: 1 },
      membership_delta: { added_candidate_keys: ["candidate:f3"], changed: true }
    });
  });

  it("classifies formed treatment with no compatible evidence as not_exercised", () => {
    const base = diagnostic("q-no-compatible", [], true) as Record<string, unknown>;
    const compatibility = {
      ...(base.open_semantic_factor_compatibility_trace as Record<string, unknown>),
      matchable_evidence_count: 0,
      entries: []
    };
    const composition = {
      ...(base.open_semantic_factor_composition as Record<string, unknown>),
      status: "no_match",
      solution_count: 0,
      solutions: []
    };
    const treatment = {
      ...base,
      open_semantic_factor_compatibility_trace: compatibility,
      open_semantic_factor_composition: composition,
      open_semantic_factor_activation: {
        ...(base.open_semantic_factor_activation as Record<string, unknown>),
        status: "no_match",
        entries: []
      },
      open_semantic_factor_candidate_activations: []
    };
    const receipts = buildTreatmentExposureReceipts({
      control: [diagnostic("q-no-compatible", [])],
      treatment: [treatment as never],
      controlStages: [row({ question_id: "q-no-compatible", stage: 5, proof: "budget_drop" })],
      treatmentStages: [row({ question_id: "q-no-compatible", stage: 5, proof: "budget_drop" })]
    });
    const comparison = compareF0F2VsCachedF3({
      control: [row({ question_id: "q-no-compatible", stage: 5, proof: "budget_drop" })],
      treatment: [row({ question_id: "q-no-compatible", stage: 5, proof: "budget_drop" })],
      treatmentExposure: receipts
    });

    expect(receipts[0]?.exposure_status).toBe("not_exercised");
    expect(comparison.not_exercised).toEqual(["q-no-compatible"]);
    expect(comparison.still_missing).toEqual([]);
  });

  it("does not treat a zero activation entry as exercised", () => {
    const treatment = diagnostic("q-zero-activation", ["candidate:f3"], true) as Record<string, unknown>;
    treatment.open_semantic_factor_activation = {
      ...(treatment.open_semantic_factor_activation as Record<string, unknown>),
      entries: [{ evidence_id: "e1", activation: 0 }]
    };
    treatment.open_semantic_factor_candidate_activations = [];
    const [receipt] = buildTreatmentExposureReceipts({
      control: [diagnostic("q-zero-activation", [])],
      treatment: [treatment as never],
      controlStages: [row({ question_id: "q-zero-activation", stage: 5, proof: "budget_drop" })],
      treatmentStages: [row({ question_id: "q-zero-activation", stage: 5, proof: "budget_drop" })]
    });

    expect(receipt?.activation.activated_evidence_count).toBe(0);
    expect(receipt?.exposure_status).toBe("not_exercised");
    expect(() => assertTreatmentExposureReceipt(receipt!)).not.toThrow();
  });

  it("does not treat a membership delta without candidate attribution as exposure", () => {
    const treatment = diagnostic("q-no-attribution", ["candidate:f3"], true) as Record<string, unknown>;
    treatment.open_semantic_factor_candidate_activations = [];
    const [receipt] = buildTreatmentExposureReceipts({
      control: [diagnostic("q-no-attribution", [])], treatment: [treatment as never],
      controlStages: [row({ question_id: "q-no-attribution", stage: 5, proof: "budget_drop" })],
      treatmentStages: [row({ question_id: "q-no-attribution", stage: 5, proof: "budget_drop" })]
    });
    expect(receipt?.membership_delta.changed).toBe(true);
    expect(receipt?.candidate_attribution.entries).toEqual([]);
    expect(receipt?.exposure_status).toBe("not_exercised");
  });

  it("makes dual-arm F3 exposure inconclusive", () => {
    const [receipt] = buildTreatmentExposureReceipts({
      control: [diagnostic("q-dual", ["candidate:f3"], true)],
      treatment: [diagnostic("q-dual", ["candidate:f3"], true)],
      controlStages: [row({ question_id: "q-dual", stage: 5, proof: "budget_drop" })],
      treatmentStages: [row({ question_id: "q-dual", stage: 5, proof: "budget_drop" })]
    });
    expect(receipt?.control_non_exposure).toMatchObject({ observed: true, pure: false });
    expect(receipt?.exposure_status).toBe("inconclusive");
  });

  it.each([
    ["nonexistent candidate", () => diagnostic("q-cross", ["candidate:real"], true)],
    ["unrelated evidence", () => replaceCandidateReceipt(
      diagnostic("q-cross", ["candidate:f3"], true), { evidence_ids: ["other"] }
    )],
    ["mismatched score and counts", () => replaceCandidateReceipt(
      diagnostic("q-cross", ["candidate:f3"], true), {
        score: 0.5, solution_count: 2, proposition_match_count: 2
      }
    )]
  ] as const)("makes %s candidate attribution inconclusive", (_name, treatment) => {
    const [receipt] = buildTreatmentExposureReceipts({
      control: [diagnostic("q-cross", [])], treatment: [treatment()],
      controlStages: [row({ question_id: "q-cross", stage: 5, proof: "budget_drop" })],
      treatmentStages: [row({ question_id: "q-cross", stage: 5, proof: "budget_drop" })]
    });
    expect(receipt?.evidence_chain.linked).toBe(false);
    expect(receipt?.exposure_status).toBe("inconclusive");
  });

  it("uses code-unit ordering for Unicode candidate activation keys", () => {
    const zEntry = candidateAttribution(true).entries[0]!;
    const umlautEntry = { ...zEntry, candidate_key: "ä" };
    const asciiEntry = { ...zEntry, candidate_key: "z" };
    expect(OpenSemanticFactorCandidateActivationsSchema.safeParse(
      [asciiEntry, umlautEntry]
    ).success).toBe(true);
    expect(OpenSemanticFactorCandidateActivationsSchema.safeParse(
      [umlautEntry, asciiEntry]
    ).success).toBe(false);
  });

  it.each([
    ["derived status", (receipt: ReturnType<typeof exposure>) => ({
      ...receipt,
      exposure_status: "not_exercised" as const
    })],
    ["status enum", (receipt: ReturnType<typeof exposure>) => ({
      ...receipt,
      formation: { status: "invented" }
    })],
    ["count", (receipt: ReturnType<typeof exposure>) => ({
      ...receipt,
      compatible_evidence: { compatible_count: -1 }
    })],
    ["membership keys", (receipt: ReturnType<typeof exposure>) => ({
      ...receipt,
      membership_delta: {
        ...receipt.membership_delta,
        changed: true,
        added_candidate_keys: ["z", "a", "a"]
      }
    })],
    ["shape", (receipt: ReturnType<typeof exposure>) => ({
      ...receipt,
      unexpected: true
    })]
  ] as const)("rejects a re-sealed receipt with invalid %s", (_name, mutate) => {
    const original = exposure("q-invalid", "exposed", false);
    const { receipt_digest: _digest, ...body } = mutate(original);
    const resealed = sealTreatmentExposureReceipt(body as never);
    expect(() => assertTreatmentExposureReceipt(resealed)).toThrow(/treatment exposure receipt/u);
  });

  it("rejects legacy and tampered persisted comparisons", async () => {
    const root = await mkdtemp(join(tmpdir(), "diagnostic-100q-exposure-"));
    const path = join(root, "comparison.json");
    await writeFile(path, JSON.stringify({
      schema_version: 1,
      kind: "diagnostic_100q_f0f2_vs_cached_f3"
    }));
    await expect(readDiagnostic100QComparisonArtifact(path)).rejects.toThrow(
      /lacks the cached F3 exposure contract/u
    );

    const comparison = compareF0F2VsCachedF3({
      control: [row({ question_id: "q1", stage: 5, proof: "budget_drop" })],
      treatment: [row({ question_id: "q1", stage: 5, proof: "budget_drop" })],
      treatmentExposure: [exposure("q1", "exposed", false)]
    });
    const [receipt] = comparison.treatment_exposure_receipts;
    await writeFile(path, JSON.stringify({
      ...comparison,
      treatment_exposure_receipts: [{ ...receipt, receipt_digest: "0".repeat(64) }]
    }));
    await expect(readDiagnostic100QComparisonArtifact(path)).rejects.toThrow(
      /treatment exposure receipt/u
    );
  });

  it.each([
    ["deleted classification", (comparison: ReturnType<typeof compareF0F2VsCachedF3>) => ({
      ...comparison, still_missing: []
    })],
    ["duplicate classification", (comparison: ReturnType<typeof compareF0F2VsCachedF3>) => ({
      ...comparison, still_missing: ["q1", "q1"]
    })],
    ["wrong classification", (comparison: ReturnType<typeof compareF0F2VsCachedF3>) => ({
      ...comparison, still_missing: [], membership_improved: ["q1"]
    })],
    ["wrong stage counts", (comparison: ReturnType<typeof compareF0F2VsCachedF3>) => ({
      ...comparison, control_misses: { ...comparison.control_misses, S4: 99 }
    })],
    ["wrong treatment counts", (comparison: ReturnType<typeof compareF0F2VsCachedF3>) => ({
      ...comparison, treatment_misses: { ...comparison.treatment_misses, S4: 99 }
    })],
    ["physical calls", (comparison: ReturnType<typeof compareF0F2VsCachedF3>) => ({
      ...comparison, physical_calls: 1
    })],
    ["500Q closure", (comparison: ReturnType<typeof compareF0F2VsCachedF3>) => ({
      ...comparison, five_hundred_q_closed: false
    })]
  ] as const)("rejects persisted comparison with %s", async (_name, mutate) => {
    const root = await mkdtemp(join(tmpdir(), "diagnostic-100q-classification-"));
    const path = join(root, "comparison.json");
    const comparison = compareF0F2VsCachedF3({
      control: [row({ question_id: "q1", stage: 5, proof: "budget_drop" })],
      treatment: [row({ question_id: "q1", stage: 5, proof: "budget_drop" })],
      treatmentExposure: [exposure("q1", "exposed", false)]
    });
    await writeFile(path, JSON.stringify(mutate(comparison)));
    await expect(readDiagnostic100QComparisonArtifact(path)).rejects.toThrow(/diagnostic 100Q/u);
  });

  it("fails closed when a treatment question lacks an exposure receipt", () => {
    expect(() => compareF0F2VsCachedF3({
      control: [row({ question_id: "q1", stage: 5, proof: "budget_drop" })],
      treatment: [row({ question_id: "q1", stage: 5, proof: "budget_drop" })],
      treatmentExposure: []
    })).toThrow(/exposure receipts do not match/u);
  });
});

function exposure(
  questionId: string,
  exposureStatus: "exposed" | "not_exercised" | "inconclusive",
  changed: boolean,
  outcome = {
    control: { stage: "S4" as const, hit_at_5: false },
    treatment: { stage: "S4" as const, hit_at_5: false }
  }
) {
  return sealTreatmentExposureReceipt({
    schema_version: 3 as const,
    kind: "cached_f3_treatment_exposure" as const,
    question_id: questionId,
    evidence_chain: { linked: exposureStatus !== "inconclusive" },
    control_non_exposure: {
      observed: true,
      formation_status: "unavailable",
      compatible_count: 0,
      composition_status: null,
      activation_status: null,
      activated_evidence_count: 0,
      candidate_attribution_count: 0,
      pure: true
    },
    formation: { status: exposureStatus === "exposed" ? "formed" : "unavailable" },
    compatible_evidence: { compatible_count: exposureStatus === "exposed" ? 1 : 0 },
    composition: { status: exposureStatus === "exposed" ? "composed" : "unavailable", solution_count: exposureStatus === "exposed" ? 1 : 0, binding_count: 0 },
    activation: { status: exposureStatus === "exposed" ? "composed" : "unavailable", activated_evidence_count: exposureStatus === "exposed" ? 1 : 0 },
    candidate_attribution: candidateAttribution(exposureStatus === "exposed"),
    membership_delta: { observed: true, changed, added_candidate_keys: changed ? ["candidate:f3"] : [], removed_candidate_keys: [] },
    outcome,
    exposure_status: exposureStatus
  });
}

function diagnostic(questionId: string, candidateKeys: readonly string[], exposed = false) {
  const digest = (seed: string) => `sha256:${seed.repeat(64)}`;
  const formation = {
    status: exposed ? "formed" : "unavailable",
    capture_digest: digest("1")
  };
  return {
    question_id: questionId,
    candidate_pool_complete: true,
    candidates: candidateKeys.map((candidate_key, index) => ({
      candidate_key,
      final_rank: index + 1
    })),
    query_open_semantic_factor_formation: formation,
    open_semantic_factor_compatibility_trace: exposed ? {
      query_capture_digest: formation.capture_digest,
      matchable_evidence_count: 1,
      entries: [{ receipt: { status: "compatible" } }],
      trace_digest: digest("2")
    } : null,
    open_semantic_factor_composition: exposed ? {
      status: "composed",
      query_capture_digest: formation.capture_digest,
      compatibility_trace_digest: digest("2"),
      solution_count: 1,
      observed_binding_count: 0,
      bindings: [],
      receipt_digest: digest("3")
    } : null,
    open_semantic_factor_activation: exposed ? {
      status: "composed",
      composition_receipt_digest: digest("3"),
      entries: [{
        evidence_id: "e1", state: "observed", activation: 1,
        solution_count: 1, proposition_match_count: 1
      }]
    } : null,
    open_semantic_factor_candidate_activations: exposed ? candidateAttribution(true).entries : []
  } as never;
}

function replaceCandidateReceipt(
  diagnosticValue: ReturnType<typeof diagnostic>,
  changes: Partial<ReturnType<typeof candidateAttribution>["entries"][number]["receipt"]>
) {
  const diagnosticRecord = diagnosticValue as Record<string, unknown>;
  const attribution = candidateAttribution(true);
  const receipt = { ...attribution.entries[0]!.receipt, ...changes };
  const { receipt_digest: _digest, ...body } = receipt;
  diagnosticRecord.open_semantic_factor_candidate_activations = [{
    candidate_key: "candidate:f3",
    receipt: { ...body, receipt_digest: digestRecallFieldIdentity(body) }
  }];
  return diagnosticRecord as never;
}

function candidateAttribution(exposed: boolean) {
  if (!exposed) return { entries: [], candidate_keys: [], activated_evidence_ids: [] };
  const body = {
    schema_version: 1 as const,
    operator_id: "open_semantic_factor_candidate_activation_v1" as const,
    state: "observed" as const,
    score: 1,
    evidence_ids: ["e1"],
    solution_count: 1,
    proposition_match_count: 1
  };
  return {
    entries: [{
      candidate_key: "candidate:f3",
      receipt: { ...body, receipt_digest: digestRecallFieldIdentity(body) }
    }],
    candidate_keys: ["candidate:f3"],
    activated_evidence_ids: ["e1"]
  };
}

function row(overrides: Partial<QuestionStageRow> & {
  readonly stage: QuestionStageRow["stage"];
  readonly proof: string;
}): QuestionStageRow {
  return {
    question_id: overrides.question_id ?? "q1",
    stage: overrides.stage,
    mechanism: overrides.mechanism ?? null,
    opportunity_pre_budget_6_10: false,
    miss_taxonomy: overrides.miss_taxonomy ?? null,
    best_pool_rank: null,
    hit_at_5: overrides.hit_at_5 ?? false,
    proof: overrides.proof
  };
}
