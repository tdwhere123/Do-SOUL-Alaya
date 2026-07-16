import { assertBiEncoderTreatmentActive } from
  "../../harness/embedding-treatment-activation.js";
import type {
  RecallEvalDiagnosticsEvidenceV2
} from "../provenance/recall-eval-diagnostics.js";
import type { LongMemEvalMatrixTreatment } from "./contract.js";

type DiagnosticsRow = RecallEvalDiagnosticsEvidenceV2["questions"][number];
type DiagnosticsRuntime = RecallEvalDiagnosticsEvidenceV2["runtime"];
type DiagnosticsSummary = RecallEvalDiagnosticsEvidenceV2["summary"];

export interface DiagnosticsTreatmentState {
  readonly cross: Record<
    "returned" | "not_applicable" | "not_requested" | "failed" | "unavailable",
    number
  >;
  readonly warmupIdentities: Set<string>;
  readonly workspaceIdentities: Set<string>;
  documentExpected: number;
  documentReady: number;
  queryRequested: number;
  queryReady: number;
  crossExpected: number;
  crossScored: number;
}

export function createDiagnosticsTreatmentState(): DiagnosticsTreatmentState {
  return {
    cross: {
      returned: 0,
      not_applicable: 0,
      not_requested: 0,
      failed: 0,
      unavailable: 0
    },
    warmupIdentities: new Set(),
    workspaceIdentities: new Set(),
    documentExpected: 0,
    documentReady: 0,
    queryRequested: 0,
    queryReady: 0,
    crossExpected: 0,
    crossScored: 0
  };
}

export function verifyDiagnosticsTreatmentQuestion(
  state: DiagnosticsTreatmentState,
  row: DiagnosticsRow,
  treatment: LongMemEvalMatrixTreatment
): void {
  assertTreatmentActive(row, treatment);
  recordReadiness(state, row);
  const status = row.diagnostics.answer_rerank_status;
  state.cross[status ?? "unavailable"] += 1;
  state.crossExpected += row.diagnostics.answer_rerank_expected_count ?? 0;
  state.crossScored += row.diagnostics.answer_rerank_scored_count ?? 0;
}

export function assertDiagnosticsTreatmentComplete(
  runtime: DiagnosticsRuntime,
  treatment: LongMemEvalMatrixTreatment,
  state: DiagnosticsTreatmentState
): void {
  if (runtime.embedding_supplement.enabled !== treatment.embedding_supplement ||
      runtime.answer_rerank.enabled !== treatment.answer_rerank) {
    throw new Error("recall-eval diagnostics runtime differs from matrix treatment");
  }
  assertEmbeddingComplete(runtime, state);
  assertCrossComplete(runtime, state);
}

export function buildDiagnosticsTreatmentSummary(
  runtime: DiagnosticsRuntime,
  state: DiagnosticsTreatmentState
): Omit<DiagnosticsSummary, "question_count" | "provider_states"> {
  const embedding = runtime.embedding_supplement;
  return {
    document_embedding_cache: {
      expected_count: state.documentExpected,
      ready_count: state.documentReady,
      not_ready_count: state.documentExpected - state.documentReady
    },
    query_embedding_cache: {
      expected_count: state.queryRequested,
      requested_count: state.queryRequested,
      ready_count: state.queryReady,
      not_ready_count: state.queryRequested - state.queryReady
    },
    answer_rerank_status_counts: state.cross,
    answer_rerank_scores: {
      expected_count: state.crossExpected,
      scored_count: state.crossScored
    },
    embedding_identity: {
      provider_kind: embedding.enabled ? embedding.provider_kind : null,
      model_id: embedding.enabled ? embedding.effective_model_id : null,
      schema_version: embedding.enabled ? embedding.effective_schema_version : null,
      consistent: true
    }
  };
}

function assertTreatmentActive(
  row: DiagnosticsRow,
  treatment: LongMemEvalMatrixTreatment
): void {
  const diagnostics = row.diagnostics;
  const inferenceCalls = row.recall_token_economy?.embedding_inference_calls;
  const expectedInferenceCalls = treatment.embedding_supplement ? 1 : 0;
  if (inferenceCalls !== expectedInferenceCalls) {
    throw new Error(
      `promotion v1 embedding inference count differs for ${row.question_id}: ` +
      `expected=${expectedInferenceCalls} actual=${inferenceCalls ?? "missing"}`
    );
  }
  if (!treatment.embedding_supplement) {
    assertBiEncoderControlInactive(row);
  } else {
    assertBiEncoderActive(row);
  }
  const crossStatus = diagnostics.answer_rerank_status;
  const scoredCandidates = diagnostics.candidates.filter(
    (candidate) => candidate.answer_relevance_score !== null
  ).length;
  const crossValid = treatment.answer_rerank
    ? crossStatus === "returned"
      ? scoredCandidates > 0 &&
        diagnostics.answer_rerank_expected_count === scoredCandidates &&
        diagnostics.answer_rerank_scored_count === scoredCandidates
      : crossStatus === "not_applicable" && scoredCandidates === 0 &&
        diagnostics.answer_rerank_expected_count === 0 &&
        diagnostics.answer_rerank_scored_count === 0
    : crossStatus === "not_requested" &&
      scoredCandidates === 0 &&
      (diagnostics.answer_rerank_expected_count ?? 0) === 0 &&
      (diagnostics.answer_rerank_scored_count ?? 0) === 0;
  if (!crossValid) {
    throw new Error(`cross-encoder treatment activation drift for ${row.question_id}`);
  }
}

function assertBiEncoderControlInactive(row: DiagnosticsRow): void {
  const diagnostics = row.diagnostics;
  const workspaceWork = diagnostics.embedding_workspace_scanned_count !== undefined ||
    diagnostics.embedding_workspace_truncated !== undefined ||
    diagnostics.embedding_workspace_provider_kind !== undefined ||
    diagnostics.embedding_workspace_model_id !== undefined ||
    diagnostics.embedding_workspace_schema_version !== undefined;
  const embeddingEvidence = diagnostics.candidates.some(
    (candidate) => "embedding_similarity" in candidate.score_factors
  );
  if (row.document_embedding_warmup !== null || row.query_embedding_warmup !== null ||
      workspaceWork || embeddingEvidence ||
      diagnostics.provider_state !== "provider_not_requested") {
    throw new Error(`disabled bi-encoder cell produced work for ${row.question_id}`);
  }
}

function assertBiEncoderActive(row: DiagnosticsRow): void {
  const document = row.document_embedding_warmup;
  if (document === null || document.status !== "ready" ||
      document.ready_count !== document.expected_count) {
    throw new Error(`bi-encoder document warmup incomplete for ${row.question_id}`);
  }
  const query = row.query_embedding_warmup;
  if (query !== null) {
    throw new Error(`bi-encoder query must execute inside recall for ${row.question_id}`);
  }
  const diagnostics = row.diagnostics;
  try {
    assertBiEncoderTreatmentActive({
      providerState: diagnostics.provider_state,
      providerDegradationReason: diagnostics.provider_degradation_reason,
      embeddingSimilarities: diagnostics.candidates.map(
        (candidate) => readEmbeddingSimilarity(candidate.score_factors)
      ),
      workspaceScannedCount: diagnostics.embedding_workspace_scanned_count,
      workspaceTruncated: diagnostics.embedding_workspace_truncated,
      workspaceProviderKind: diagnostics.embedding_workspace_provider_kind,
      workspaceModelId: diagnostics.embedding_workspace_model_id,
      workspaceSchemaVersion: diagnostics.embedding_workspace_schema_version
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `promotion v1 bi-encoder activation failed for ${row.question_id}: ${detail}`,
      { cause: error }
    );
  }
}

function readEmbeddingSimilarity(
  scoreFactors: Readonly<Record<string, unknown>>
): number | undefined {
  const value = scoreFactors.embedding_similarity;
  return typeof value === "number" ? value : undefined;
}

function recordReadiness(
  state: DiagnosticsTreatmentState,
  row: DiagnosticsRow
): void {
  const document = row.document_embedding_warmup;
  if (document !== null) {
    state.documentExpected += document.expected_count;
    state.documentReady += document.ready_count;
    state.warmupIdentities.add(warmupIdentity(document));
  }
  const query = row.query_embedding_warmup;
  if (query !== null) {
    state.queryRequested += query.requested_count;
    state.queryReady += query.ready_count;
    state.warmupIdentities.add(warmupIdentity(query));
  }
  const diagnostics = row.diagnostics;
  if (diagnostics.embedding_workspace_provider_kind !== undefined ||
      diagnostics.embedding_workspace_model_id !== undefined ||
      diagnostics.embedding_workspace_schema_version !== undefined) {
    state.workspaceIdentities.add(JSON.stringify([
      diagnostics.embedding_workspace_provider_kind,
      diagnostics.embedding_workspace_model_id,
      diagnostics.embedding_workspace_schema_version
    ]));
  }
}

function warmupIdentity(input: {
  readonly provider_kind: string | null;
  readonly model_id: string | null;
  readonly schema_version: number | null;
  readonly d2q_input: string | null;
}): string {
  return JSON.stringify([
    input.provider_kind,
    input.model_id,
    input.schema_version,
    input.d2q_input
  ]);
}

function assertEmbeddingComplete(
  runtime: DiagnosticsRuntime,
  state: DiagnosticsTreatmentState
): void {
  const embedding = runtime.embedding_supplement;
  if (embedding.enabled) {
    const expectedWarmup = JSON.stringify([
      embedding.provider_kind,
      embedding.effective_model_id,
      embedding.effective_schema_version,
      embedding.d2q_input
    ]);
    const expectedWorkspace = JSON.stringify([
      embedding.provider_kind,
      embedding.effective_model_id,
      embedding.effective_schema_version
    ]);
    if (state.warmupIdentities.size !== 1 ||
        !state.warmupIdentities.has(expectedWarmup) ||
        (state.workspaceIdentities.size > 0 &&
          (state.workspaceIdentities.size !== 1 ||
            !state.workspaceIdentities.has(expectedWorkspace)))) {
      throw new Error("bi-encoder warmup/workspace identity differs from runtime");
    }
  } else if (state.warmupIdentities.size !== 0 || state.workspaceIdentities.size !== 0) {
    throw new Error("disabled bi-encoder cell persisted an embedding identity");
  }
}

function assertCrossComplete(
  runtime: DiagnosticsRuntime,
  state: DiagnosticsTreatmentState
): void {
  if (runtime.answer_rerank.enabled &&
      (state.crossExpected === 0 || state.crossExpected !== state.crossScored)) {
    throw new Error("cross-encoder treatment did not produce complete scores");
  }
  if (!runtime.answer_rerank.enabled &&
      (state.crossExpected !== 0 || state.crossScored !== 0)) {
    throw new Error("disabled cross-encoder cell produced scores");
  }
}
