import { isDeepStrictEqual } from "node:util";
import type { LongMemEvalFullDiagnosticsValidationInput } from
  "@do-soul/alaya-eval/internal";
import {
  rAt5WithProviderReturned,
  summarizeProviderStates
} from "./diagnostics-question.js";
import type {
  LongMemEvalDiagnosticsSidecar,
  ProviderStateSummary
} from "./schema/diagnostics-types.js";
import {
  answerableRecallAt5,
  summarizeAnswerableRecall
} from "../measurement/answerable-recall.js";
import { classifyQuestionMeasurementStatus } from
  "../measurement/question-validity.js";
import { readDiagnosticsGzipBytes } from "./artifacts/artifact-gzip-reader.js";

const PROVIDER_SUMMARY_KEYS = [
  "total",
  "provider_returned",
  "provider_pending",
  "provider_failed",
  "provider_not_requested",
  "unknown",
  "provider_returned_rate",
  "provider_pending_rate",
  "provider_failed_rate",
  "provider_not_requested_rate",
  "unknown_rate"
] as const satisfies readonly (keyof ProviderStateSummary)[];

export async function validateLongMemEvalReleaseDiagnostics(
  input: LongMemEvalFullDiagnosticsValidationInput
): Promise<void> {
  const diagnostics = await readDiagnosticsGzipBytes(input.contents);
  assertSidecarIdentity(diagnostics, input.payload);
  assertQuestionBindings(diagnostics, input.payload);
  assertRecallAggregates(diagnostics, input.payload);
  assertProviderBinding(diagnostics, input.payload);
}

function assertSidecarIdentity(
  diagnostics: LongMemEvalDiagnosticsSidecar,
  payload: LongMemEvalFullDiagnosticsValidationInput["payload"]
): void {
  const expectedEmbeddingMode = payload.embedding_provider === "none" ? "disabled" : "env";
  if (diagnostics.bench_name !== payload.bench_name ||
      diagnostics.split !== payload.split ||
      diagnostics.run_at !== payload.run_at ||
      diagnostics.alaya_commit !== payload.alaya_commit ||
      diagnostics.embedding_provider !== payload.embedding_provider ||
      diagnostics.embedding_mode !== expectedEmbeddingMode ||
      diagnostics.policy_shape !== payload.policy_shape ||
      diagnostics.simulate_report !== payload.simulate_report ||
      diagnostics.recall_pipeline_version !== payload.recall_pipeline_version ||
      !isDeepStrictEqual(diagnostics.seed_extraction_path, payload.kpi.seed_extraction_path) ||
      (diagnostics.report_usage !== undefined &&
       diagnostics.report_usage.mode !== payload.simulate_report)) {
    throw new Error("full diagnostics run identity differs from verified KPI");
  }
}

function assertQuestionBindings(
  diagnostics: LongMemEvalDiagnosticsSidecar,
  payload: LongMemEvalFullDiagnosticsValidationInput["payload"]
): void {
  const expectedRows = payload.kpi.per_scenario;
  if (expectedRows.length !== payload.evaluated_count ||
      diagnostics.questions.length !== payload.evaluated_count) {
    throw new Error("full diagnostics question count differs from verified KPI");
  }
  for (const [index, diagnostic] of diagnostics.questions.entries()) {
    const expected = expectedRows[index]!;
    if (diagnostic.question_id !== expected.id) {
      throw new Error("full diagnostics question ids differ from verified KPI");
    }
    if (diagnostic.hit_at_5 !== expected.hit_at_5) {
      throw new Error("full diagnostics hit_at_5 differs from verified KPI");
    }
    if (diagnostic.cohort_ledger?.dataset_cohort !== expectedCohort(expected)) {
      throw new Error("full diagnostics cohort differs from verified KPI");
    }
    const scorable = classifyQuestionMeasurementStatus(diagnostic) === "scorable";
    if (expected.scorable !== scorable) {
      throw new Error("full diagnostics measurement status differs from verified KPI");
    }
    if (diagnostic.candidate_pool_complete !== true ||
        diagnostic.cohort_ledger?.candidate_pool_complete !== true ||
        diagnostic.cohort_ledger.evidence_status !== "complete" ||
        diagnostic.recall_diagnostics_present !== true) {
      throw new Error("full diagnostics question evidence is incomplete");
    }
  }
}

function expectedCohort(
  row: LongMemEvalFullDiagnosticsValidationInput["payload"]["kpi"]["per_scenario"][number]
): "answerable" | "abstention" {
  if (row.measurement_cohort === "answerable") return "answerable";
  if (row.measurement_cohort === "dataset_declared_abstention") return "abstention";
  throw new Error("verified KPI row is missing an explicit measurement cohort");
}

function assertRecallAggregates(
  diagnostics: LongMemEvalDiagnosticsSidecar,
  payload: LongMemEvalFullDiagnosticsValidationInput["payload"]
): void {
  const recall = summarizeAnswerableRecall(diagnostics.questions);
  if (payload.answerable_evaluated_count !== recall.scorableCount) {
    throw new Error("full diagnostics scorable denominator differs from verified KPI");
  }
  if (payload.kpi.r_at_1 !== recall.rAt1 || payload.kpi.r_at_5 !== recall.rAt5 ||
      payload.kpi.r_at_10 !== recall.rAt10) {
    throw new Error("full diagnostics recall aggregates differ from verified KPI");
  }
  assertSurfaceRecallAggregates(diagnostics, payload, recall.rAt5);
}

function assertSurfaceRecallAggregates(
  diagnostics: LongMemEvalDiagnosticsSidecar,
  payload: LongMemEvalFullDiagnosticsValidationInput["payload"],
  rAt5: number
): void {
  if (payload.bench_name === "public-multiturn" &&
      payload.kpi.r_at_5_round_n !== rAt5) {
    throw new Error("full diagnostics final-round recall differs from verified KPI");
  }
  if (payload.bench_name !== "public-crossquestion") return;
  const half = Math.floor(diagnostics.questions.length / 2);
  const first = diagnostics.questions.slice(0, half);
  const last = diagnostics.questions.slice(diagnostics.questions.length - half);
  if (half === 0 || payload.kpi.crossquestion_questions !== diagnostics.questions.length ||
      payload.kpi.r_at_5_first_half !== answerableRecallAt5(first) ||
      payload.kpi.r_at_5_last_half !== answerableRecallAt5(last)) {
    throw new Error("full diagnostics cross-question recall differs from verified KPI");
  }
}

function assertProviderBinding(
  diagnostics: LongMemEvalDiagnosticsSidecar,
  payload: LongMemEvalFullDiagnosticsValidationInput["payload"]
): void {
  const expected = summarizeProviderStates(diagnostics.questions);
  if (!sameProviderSummary(diagnostics.provider_state_summary, expected)) {
    throw new Error("full diagnostics provider summary differs from question rows");
  }
  if (diagnostics.embedding_mode === "disabled" && diagnostics.questions.some(
    (row) => row.provider_state !== "provider_not_requested"
  )) {
    throw new Error("disabled embedding diagnostics requested a provider");
  }
  const kpi = payload.kpi;
  const returnedRAt5 = rAt5WithProviderReturned(diagnostics.questions);
  const overallRAt5 = hitAt5Ratio(diagnostics.questions);
  if ((kpi.r_at_5_overall !== undefined && kpi.r_at_5_overall !== overallRAt5) ||
      (kpi.r_at_5_with_embedding_returned !== undefined &&
       kpi.r_at_5_with_embedding_returned !== returnedRAt5) ||
      (kpi.provider_returned_rate !== undefined &&
       kpi.provider_returned_rate !== expected.provider_returned_rate) ||
      (kpi.provider_pending_rate !== undefined &&
       kpi.provider_pending_rate !== expected.provider_pending_rate) ||
      (kpi.provider_failed_rate !== undefined &&
       kpi.provider_failed_rate !== expected.provider_failed_rate) ||
      (kpi.provider_not_requested_rate !== undefined &&
       kpi.provider_not_requested_rate !== expected.provider_not_requested_rate)) {
    throw new Error("full diagnostics provider rates differ from verified KPI");
  }
}

function sameProviderSummary(
  actual: unknown,
  expected: ProviderStateSummary
): boolean {
  if (actual === null || typeof actual !== "object") return false;
  const record = actual as Record<string, unknown>;
  return PROVIDER_SUMMARY_KEYS.every((key) => record[key] === expected[key]);
}

function hitAt5Ratio(rows: readonly { readonly hit_at_5: boolean }[]): number {
  return ratio(rows.filter((row) => row.hit_at_5).length, rows.length);
}

function ratio(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}
