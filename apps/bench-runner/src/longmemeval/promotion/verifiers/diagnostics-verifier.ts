import { isDeepStrictEqual } from "node:util";
import type { FileHandle } from "node:fs/promises";
import type { KpiPayload, QualityMetrics } from "@do-soul/alaya-eval";
import { DiagnosticsJsonStreamReader } from
  "../../diagnostics/artifacts/artifact-json-reader.js";
import { createArtifactReadStream, decodeArtifactUtf8 } from
  "../../diagnostics/artifacts/artifact-utf8.js";
import { createQualityMetricsState, recordQualityQuestion } from
  "../../diagnostics/quality/diagnostics-quality-state.js";
import { buildQualityMetricsFromState } from
  "../../diagnostics/quality/diagnostics-quality-render.js";
import { classifyQuestionMeasurementStatus } from
  "../../measurement/question-validity.js";
import { aggregateRecallTokenEconomy } from "../../qa/recall-token-economy.js";
import { percentile } from "../../kpi/recall-eval-aggregates.js";
import type { SnapshotMeasurementOracleAccessor } from
  "../../snapshot/measurement-oracle.js";
import {
  RecallEvalDiagnosticsEvidenceV2Schema,
  RecallEvalDiagnosticsQuestionSchema,
  type RecallEvalDiagnosticsEvidenceV2
} from "../../provenance/recall-eval/recall-eval-diagnostics.js";
import type { LongMemEvalMatrixTreatment } from "../schema/contract.js";
import type { RecallEvalRankIdentity } from "../schema/evidence-schema.js";
import {
  verifyPromotionQuestionMeasurement,
  type VerifiedPromotionQuestionMeasurement
} from "./measurement-verifier.js";
import {
  assertDiagnosticsTreatmentComplete,
  buildDiagnosticsTreatmentSummary,
  createDiagnosticsTreatmentState,
  verifyDiagnosticsTreatmentQuestion,
  type DiagnosticsTreatmentState
} from "./diagnostics-treatment-verifier.js";
import { verifyPromotionCandidatePoolClosure } from
  "./candidate-pool-verifier.js";
import {
  MAX_RECALL_EVAL_PROMOTION_QUESTIONS,
  MAX_RECALL_EVAL_PROMOTION_QUESTION_BYTES
} from "../artifacts/artifact-limits.js";

type DiagnosticsRow = RecallEvalDiagnosticsEvidenceV2["questions"][number];

export interface VerifiedRecallEvalDiagnostics {
  readonly runtime: RecallEvalDiagnosticsEvidenceV2["runtime"];
  readonly summary: RecallEvalDiagnosticsEvidenceV2["summary"];
  readonly qualityMetrics: QualityMetrics;
}

interface StreamState {
  readonly quality: ReturnType<typeof createQualityMetricsState>;
  readonly latencies: number[];
  readonly recallTokenEconomy: NonNullable<DiagnosticsRow["recall_token_economy"]>[];
  readonly tiers: Record<"hot" | "warm" | "cold", number>;
  readonly degradation: {
    none: number;
    warm_cascade_engaged: number;
    cold_cascade_engaged: number;
    recall_explainability_partial: number;
  };
  readonly provider: Record<
    "provider_returned" | "provider_pending" | "provider_failed" |
    "provider_not_requested" | "unknown",
    number
  >;
  readonly treatment: DiagnosticsTreatmentState;
  answerable: number;
  qualityAnswerable: number;
  hitAt1: number;
  hitAt5: number;
  hitAt10: number;
  providerReturnedHitsAt5: number;
  questionCount: number;
}

export async function verifyRecallEvalDiagnostics(input: {
  readonly handle: FileHandle;
  readonly payload: KpiPayload;
  readonly rankIdentity: RecallEvalRankIdentity;
  readonly treatment: LongMemEvalMatrixTreatment;
  readonly goldForQuestion: (questionId: string) => readonly string[] | undefined;
  readonly measurementForQuestion: SnapshotMeasurementOracleAccessor;
  readonly observeChunk: (chunk: Uint8Array) => void;
}): Promise<VerifiedRecallEvalDiagnostics> {
  const state = createStreamState();
  const expectedQuestionCount = resolveExpectedQuestionCount(input);
  const reader = new DiagnosticsJsonStreamReader<
    DiagnosticsRow,
    RecallEvalDiagnosticsEvidenceV2
  >(
    MAX_RECALL_EVAL_PROMOTION_QUESTION_BYTES,
    true,
    (value, index) => parseDiagnosticsRow(value, index, expectedQuestionCount),
    2
  );
  const source = createArtifactReadStream(input.handle);
  try {
    for await (const chunk of decodeArtifactUtf8(source, input.observeChunk)) {
      reader.consume(chunk);
      processRows(reader.takeQuestions(), input, state);
    }
    const document = RecallEvalDiagnosticsEvidenceV2Schema.parse(reader.finish());
    processRows(reader.takeQuestions(), input, state);
    assertQuestionCount(state, input.payload, input.rankIdentity);
    assertNoSilentDegradation(state);
    assertDiagnosticsTreatmentComplete(
      document.runtime,
      input.treatment,
      state.treatment
    );
    const summary = buildSummary(document.runtime, state);
    assertDeepEqual(document.summary, summary, "recall-eval diagnostics summary");
    const qualityMetrics = buildQualityMetricsFromState(
      state.quality,
      state.qualityAnswerable,
      state.questionCount
    );
    assertKpiReaggregation(input.payload, state, qualityMetrics);
    return { runtime: document.runtime, summary, qualityMetrics };
  } catch (error) {
    source.destroy();
    throw error;
  }
}

function createStreamState(): StreamState {
  return {
    quality: createQualityMetricsState(),
    latencies: [],
    recallTokenEconomy: [],
    tiers: { hot: 0, warm: 0, cold: 0 },
    degradation: {
      none: 0,
      warm_cascade_engaged: 0,
      cold_cascade_engaged: 0,
      recall_explainability_partial: 0
    },
    provider: {
      provider_returned: 0,
      provider_pending: 0,
      provider_failed: 0,
      provider_not_requested: 0,
      unknown: 0
    },
    treatment: createDiagnosticsTreatmentState(),
    answerable: 0,
    qualityAnswerable: 0,
    hitAt1: 0,
    hitAt5: 0,
    hitAt10: 0,
    providerReturnedHitsAt5: 0,
    questionCount: 0
  };
}

function parseDiagnosticsRow(
  value: unknown,
  index: number,
  expectedQuestionCount: number
): DiagnosticsRow {
  if (index >= expectedQuestionCount) {
    throw new Error("recall-eval diagnostics exceeds the bound evidence question count");
  }
  const parsed = RecallEvalDiagnosticsQuestionSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `recall-eval diagnostics question[${index}] failed v2 schema: ${parsed.error.message}`
    );
  }
  return parsed.data;
}

function resolveExpectedQuestionCount(
  input: Parameters<typeof verifyRecallEvalDiagnostics>[0]
): number {
  const expected = input.payload.evaluated_count;
  if (!Number.isSafeInteger(expected) || expected < 1 ||
      expected > MAX_RECALL_EVAL_PROMOTION_QUESTIONS) {
    throw new Error("recall-eval diagnostics question count exceeds the product limit");
  }
  if (input.rankIdentity.questions.length !== expected) {
    throw new Error("recall-eval bound evidence question count differs");
  }
  return expected;
}

function processRows(
  rows: readonly DiagnosticsRow[],
  input: Parameters<typeof verifyRecallEvalDiagnostics>[0],
  state: StreamState
): void {
  for (const row of rows) processRow(row, input, state);
}

function processRow(
  row: DiagnosticsRow,
  input: Parameters<typeof verifyRecallEvalDiagnostics>[0],
  state: StreamState
): void {
  const { kpiRow, rankRow } = bindRowEvidence(row, input, state.questionCount);
  assertPersistedRowEnvelope(row, kpiRow);
  const measurement = verifyRowMeasurement(row, input);
  assertKpiRow(row, kpiRow, measurement);
  assertRankRow(row, rankRow);
  if (row.recall_token_economy === null) {
    throw new Error(`recall-eval token economy missing for ${row.question_id}`);
  }
  assertLedgerVerdict(row, measurement.status, measurement.hits.hitAt5);
  verifyDiagnosticsTreatmentQuestion(state.treatment, row, input.treatment);
  recordVerifiedRow(state, row, measurement);
}

function bindRowEvidence(
  row: DiagnosticsRow,
  input: Parameters<typeof verifyRecallEvalDiagnostics>[0],
  index: number
) {
  const kpiRow = input.payload.kpi.per_scenario[index];
  const rankRow = input.rankIdentity.questions[index];
  if (kpiRow === undefined || rankRow === undefined ||
      row.question_id !== kpiRow.id || row.question_id !== rankRow.question_id ||
      row.question_id !== row.diagnostics.question_id) {
    throw new Error(`recall-eval question identity drift at index ${index}`);
  }
  if (row.diagnostics.candidate_pool_complete !== true ||
      row.diagnostics.cohort_ledger?.candidate_pool_complete !== true ||
      row.diagnostics.cohort_ledger.evidence_status !== "complete") {
    throw new Error(`recall-eval question ${row.question_id} has incomplete evidence`);
  }
  verifyPromotionCandidatePoolClosure(row.diagnostics);
  return { kpiRow, rankRow };
}

function verifyRowMeasurement(
  row: DiagnosticsRow,
  input: Parameters<typeof verifyRecallEvalDiagnostics>[0]
): VerifiedPromotionQuestionMeasurement {
  const oracle = input.measurementForQuestion(row.question_id);
  const expectedGold = input.goldForQuestion(row.question_id);
  if (oracle === undefined || expectedGold === undefined ||
      !isDeepStrictEqual(oracle.goldMemoryIds, expectedGold)) {
    throw new Error(`snapshot measurement oracle missing for ${row.question_id}`);
  }
  return verifyPromotionQuestionMeasurement({
    diagnostic: row.diagnostics,
    expectedGold,
    oracle
  });
}

function assertPersistedRowEnvelope(
  row: DiagnosticsRow,
  kpiRow: KpiPayload["kpi"]["per_scenario"][number]
): void {
  if (row.diagnostics.is_abstention !==
        (kpiRow.measurement_cohort === "dataset_declared_abstention") ||
      kpiRow.latency_ms !== row.latency_ms || kpiRow.tier !== row.first_tier ||
      row.degradation_reason !== row.diagnostics.degradation_reason) {
    throw new Error(`recall-eval KPI row differs from diagnostics for ${row.question_id}`);
  }
}

function assertKpiRow(
  row: DiagnosticsRow,
  kpiRow: KpiPayload["kpi"]["per_scenario"][number],
  measurement: VerifiedPromotionQuestionMeasurement
): void {
  if (kpiRow.scorable !== measurement.scorable ||
      kpiRow.measurement_cohort !== measurement.cohort ||
      row.diagnostics.is_abstention !==
        (kpiRow.measurement_cohort === "dataset_declared_abstention") ||
      kpiRow.hit_at_5 !== measurement.hits.hitAt5 ||
      kpiRow.latency_ms !== row.latency_ms || kpiRow.tier !== row.first_tier ||
      row.degradation_reason !== row.diagnostics.degradation_reason) {
    throw new Error(`recall-eval KPI row differs from diagnostics for ${row.question_id}`);
  }
}

function assertRankRow(
  row: DiagnosticsRow,
  rankRow: RecallEvalRankIdentity["questions"][number]
): void {
  const deliveredObjects = row.diagnostics.delivered_results.map((result) => ({
    object_id: result.object_id,
    object_kind: result.object_kind ?? "memory_entry"
  }));
  if (!isDeepStrictEqual(deliveredObjects, rankRow.delivered_objects)) {
    throw new Error(`recall-eval rank identity differs for ${row.question_id}`);
  }
}

function recordVerifiedRow(
  state: StreamState,
  row: DiagnosticsRow,
  measurement: VerifiedPromotionQuestionMeasurement
): void {
  recordQualityQuestion(state.quality, measurement.diagnostic);
  state.latencies.push(row.latency_ms);
  state.recallTokenEconomy.push(row.recall_token_economy!);
  state.tiers[row.first_tier] += 1;
  recordDegradation(state, row.degradation_reason);
  recordProvider(state, row);
  if (measurement.scorable) {
    state.answerable += 1;
    if (measurement.hits.hitAt1) state.hitAt1 += 1;
    if (measurement.hits.hitAt5) state.hitAt5 += 1;
    if (measurement.hits.hitAt10) state.hitAt10 += 1;
  }
  if (measurement.cohort === "answerable") state.qualityAnswerable += 1;
  state.questionCount += 1;
}

function assertLedgerVerdict(
  row: DiagnosticsRow,
  status: ReturnType<typeof classifyQuestionMeasurementStatus>,
  hitAt5: boolean
): void {
  const ledger = row.diagnostics.cohort_ledger!;
  const retrieval = status === "scorable"
    ? hitAt5 ? "hit_at_5" : "miss_at_5"
    : "not_applicable";
  let verdict: typeof ledger.final_verdict;
  if (ledger.dataset_cohort === "abstention") verdict = "abstention_uncalibrated";
  else if (ledger.dataset_cohort === "adjudicated_invalid") {
    verdict = ledger.evaluation_issue_reason === "evaluator_data_identity_inconsistency"
      ? "evaluator_data_identity_inconsistency"
      : ledger.evaluation_issue_reason === "evaluator_data_identity_indeterminate"
        ? "evaluator_data_identity_indeterminate"
        : "adjudicated_invalid";
  } else if (status === "scorable") verdict = hitAt5 ? "hit_at_5" : "miss_at_5";
  else verdict = ledger.evaluation_issue_reason === "evaluator_data_identity_inconsistency"
    ? "evaluator_data_identity_inconsistency"
    : ledger.evaluation_issue_reason === "evaluator_data_identity_indeterminate"
      ? "evaluator_data_identity_indeterminate"
      : "evaluation_unscorable";
  if (ledger.retrieval_status !== retrieval || ledger.final_verdict !== verdict) {
    throw new Error(`recall-eval ledger verdict differs from recomputed hit for ${row.question_id}`);
  }
}

function recordProvider(state: StreamState, row: DiagnosticsRow): void {
  state.provider[row.diagnostics.provider_state] += 1;
  if (row.diagnostics.provider_state === "provider_returned" && row.diagnostics.hit_at_5) {
    state.providerReturnedHitsAt5 += 1;
  }
}

function recordDegradation(state: StreamState, reason: string | null): void {
  if (reason === "warm_cascade_engaged") state.degradation.warm_cascade_engaged += 1;
  else if (reason === "cold_cascade_engaged") state.degradation.cold_cascade_engaged += 1;
  else if (reason === "recall_explainability_partial") {
    state.degradation.recall_explainability_partial += 1;
  } else if (reason === null) state.degradation.none += 1;
  else throw new Error(`unsupported recall degradation reason: ${reason}`);
}

function assertNoSilentDegradation(state: StreamState): void {
  const degraded = state.degradation.warm_cascade_engaged +
    state.degradation.cold_cascade_engaged +
    state.degradation.recall_explainability_partial;
  if (degraded !== 0 || state.degradation.none !== state.questionCount) {
    throw new Error("promotion refuses a silently degraded recall treatment");
  }
}

function assertQuestionCount(
  state: StreamState,
  payload: KpiPayload,
  rank: RecallEvalRankIdentity
): void {
  if (state.questionCount === 0 || state.questionCount !== payload.evaluated_count ||
      state.questionCount !== payload.kpi.per_scenario.length ||
      state.questionCount !== rank.questions.length) {
    throw new Error("recall-eval diagnostics question count differs from bound evidence");
  }
}

function buildSummary(
  runtime: RecallEvalDiagnosticsEvidenceV2["runtime"],
  state: StreamState
): RecallEvalDiagnosticsEvidenceV2["summary"] {
  return {
    question_count: state.questionCount,
    provider_states: { total: state.questionCount, ...state.provider },
    ...buildDiagnosticsTreatmentSummary(runtime, state.treatment)
  };
}

function assertKpiReaggregation(
  payload: KpiPayload,
  state: StreamState,
  qualityMetrics: QualityMetrics
): void {
  const ratio = (count: number, total: number): number => total === 0 ? 0 : count / total;
  const tokenEconomy = aggregateRecallTokenEconomy(state.recallTokenEconomy);
  const expected = {
    r_at_1: ratio(state.hitAt1, state.answerable),
    r_at_5: ratio(state.hitAt5, state.answerable),
    r_at_10: ratio(state.hitAt10, state.answerable),
    latency_ms_p50: percentile(state.latencies, 50),
    latency_ms_p95: percentile(state.latencies, 95),
    tier_distribution: state.tiers,
    degradation_reasons: state.degradation,
    recall_token_economy: tokenEconomy,
    quality_metrics: qualityMetrics
  };
  for (const [key, value] of Object.entries(expected)) {
    assertDeepEqual(payload.kpi[key as keyof KpiPayload["kpi"]], value, `kpi.${key}`);
  }
  if (payload.answerable_evaluated_count !== state.answerable) {
    throw new Error("answerable_evaluated_count differs from diagnostics");
  }
  const providerTotal = state.questionCount;
  const providerFields = {
    provider_returned_rate: ratio(state.provider.provider_returned, providerTotal),
    provider_pending_rate: ratio(state.provider.provider_pending, providerTotal),
    provider_failed_rate: ratio(state.provider.provider_failed, providerTotal),
    provider_not_requested_rate: ratio(state.provider.provider_not_requested, providerTotal),
    r_at_5_with_embedding_returned: state.provider.provider_returned === 0
      ? undefined
      : ratio(state.providerReturnedHitsAt5, state.provider.provider_returned),
    embedding_vector_cache_ready_rate: state.treatment.documentExpected === 0
      ? undefined
      : ratio(state.treatment.documentReady, state.treatment.documentExpected),
    query_embedding_cache_ready_rate: state.treatment.queryRequested === 0
      ? undefined
      : ratio(state.treatment.queryReady, state.treatment.queryRequested)
  };
  for (const [key, value] of Object.entries(providerFields)) {
    assertDeepEqual(payload.kpi[key as keyof KpiPayload["kpi"]], value, `kpi.${key}`);
  }
}

function assertDeepEqual(actual: unknown, expected: unknown, label: string): void {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`${label} differs from independently recomputed diagnostics`);
  }
}
