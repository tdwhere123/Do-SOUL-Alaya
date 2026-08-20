import {
  readOptionalTreatmentBoolean,
  refuseRetiredLocalCrossEncoderTreatment
} from "../strict-treatment-config.js";

interface EmbeddingTreatmentDiagnostics {
  readonly embedding_provider_status: string;
  readonly provider_degradation_reason: string | null;
  readonly evidence_embedding_status?: string;
  readonly evidence_embedding_expected_count?: number;
  readonly evidence_embedding_scored_count?: number;
  readonly evidence_embedding_inference_calls?: number;
  readonly evidence_embedding_failure_class?: string | null;
  readonly embedding_workspace_scanned_count?: number;
  readonly embedding_workspace_truncated?: boolean;
  readonly embedding_workspace_provider_kind?: string;
  readonly embedding_workspace_model_id?: string;
  readonly embedding_workspace_schema_version?: number;
  readonly candidates: readonly Readonly<{
    readonly score_factors: Readonly<{ readonly embedding_similarity?: number }>;
  }>[];
}

export interface BiEncoderTreatmentActivationEvidence {
  readonly providerState: string;
  readonly providerDegradationReason: string | null;
  readonly embeddingSimilarities: readonly (number | undefined)[];
  readonly workspaceScannedCount?: number;
  readonly workspaceTruncated?: boolean;
  readonly workspaceProviderKind?: string;
  readonly workspaceModelId?: string;
  readonly workspaceSchemaVersion?: number;
}

export function assertBiEncoderRunActivation(
  diagnostics: EmbeddingTreatmentDiagnostics,
  env: Readonly<Record<string, string | undefined>>
): void {
  const enabled = readOptionalTreatmentBoolean(
    env.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT,
    "ALAYA_ENABLE_EMBEDDING_SUPPLEMENT"
  );
  if (enabled === null) return;
  if (enabled) {
    assertBiEncoderTreatmentActive(toActivationEvidence(diagnostics));
    assertEvidenceEmbeddingTreatmentActive(diagnostics);
  }
  else assertControlInactive(diagnostics);
}

export function requiresEmbeddingTreatmentDiagnostics(
  env: Readonly<Record<string, string | undefined>>
): boolean {
  refuseRetiredLocalCrossEncoderTreatment(env);
  return readOptionalTreatmentBoolean(
    env.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT,
    "ALAYA_ENABLE_EMBEDDING_SUPPLEMENT"
  ) !== null;
}

export function assertEmbeddingTreatmentDiagnosticsPresent(
  diagnostics: unknown,
  env: Readonly<Record<string, string | undefined>>
): void {
  if (diagnostics === undefined && requiresEmbeddingTreatmentDiagnostics(env)) {
    throw new Error("embedding treatment diagnostics missing for an explicit matrix arm");
  }
}

export function assertBiEncoderTreatmentActive(
  evidence: BiEncoderTreatmentActivationEvidence
): void {
  const observedCandidates = evidence.embeddingSimilarities.filter(
    (similarity) => similarity !== undefined && Number.isFinite(similarity)
  ).length;
  const active = evidence.providerState === "provider_returned" &&
    evidence.providerDegradationReason === null && observedCandidates > 0;
  if (!active) {
    throw new Error(
      "bi-encoder treatment activation failed: " +
      `status=${evidence.providerState} ` +
      `degraded=${evidence.providerDegradationReason ?? "none"} ` +
      `scored_candidates=${observedCandidates} ` +
      `scanned=${evidence.workspaceScannedCount ?? "missing"} ` +
      `truncated=${evidence.workspaceTruncated ?? "missing"} ` +
      `provider=${evidence.workspaceProviderKind ?? "missing"} ` +
      `model=${evidence.workspaceModelId ?? "missing"} ` +
      `schema=${evidence.workspaceSchemaVersion ?? "missing"}`
    );
  }
}

function toActivationEvidence(
  diagnostics: EmbeddingTreatmentDiagnostics
): BiEncoderTreatmentActivationEvidence {
  return {
    providerState: diagnostics.embedding_provider_status,
    providerDegradationReason: diagnostics.provider_degradation_reason,
    embeddingSimilarities: diagnostics.candidates.map(
      (candidate) => candidate.score_factors.embedding_similarity
    ),
    workspaceScannedCount: diagnostics.embedding_workspace_scanned_count,
    workspaceTruncated: diagnostics.embedding_workspace_truncated,
    workspaceProviderKind: diagnostics.embedding_workspace_provider_kind,
    workspaceModelId: diagnostics.embedding_workspace_model_id,
    workspaceSchemaVersion: diagnostics.embedding_workspace_schema_version
  };
}

function assertControlInactive(diagnostics: EmbeddingTreatmentDiagnostics): void {
  const inactive = diagnostics.embedding_provider_status === "provider_not_requested" &&
    isEvidenceEmbeddingInactive(diagnostics) &&
    diagnostics.candidates.every(
      (candidate) => !("embedding_similarity" in candidate.score_factors)
    ) &&
    diagnostics.embedding_workspace_scanned_count === undefined &&
    diagnostics.embedding_workspace_provider_kind === undefined &&
    diagnostics.embedding_workspace_model_id === undefined &&
    diagnostics.embedding_workspace_schema_version === undefined;
  if (!inactive) {
    throw new Error("bi-encoder control activation failed: embedding work was observed");
  }
}

function assertEvidenceEmbeddingTreatmentActive(
  diagnostics: EmbeddingTreatmentDiagnostics
): void {
  const expected = diagnostics.evidence_embedding_expected_count ?? 0;
  const scored = diagnostics.evidence_embedding_scored_count ?? 0;
  const complete = expected > 0 &&
    diagnostics.evidence_embedding_status === "returned" &&
    scored === expected &&
    diagnostics.evidence_embedding_failure_class === null;
  if (complete || isEvidenceEmbeddingNotApplicable(diagnostics)) return;
  throw new Error(
    "evidence embedding treatment activation failed: " +
    `status=${diagnostics.evidence_embedding_status ?? "missing"} ` +
    `expected=${expected} scored=${scored} ` +
    `inference_calls=${diagnostics.evidence_embedding_inference_calls ?? 0} ` +
    `failure=${diagnostics.evidence_embedding_failure_class ?? "none"}`
  );
}

function isEvidenceEmbeddingInactive(diagnostics: EmbeddingTreatmentDiagnostics): boolean {
  const status = diagnostics.evidence_embedding_status ?? "not_requested";
  return status === "not_requested" &&
    hasNoEvidenceEmbeddingWork(diagnostics);
}

function isEvidenceEmbeddingNotApplicable(
  diagnostics: EmbeddingTreatmentDiagnostics
): boolean {
  return diagnostics.evidence_embedding_status === "not_applicable" &&
    hasNoEvidenceEmbeddingWork(diagnostics);
}

function hasNoEvidenceEmbeddingWork(diagnostics: EmbeddingTreatmentDiagnostics): boolean {
  return (diagnostics.evidence_embedding_expected_count ?? 0) === 0 &&
    (diagnostics.evidence_embedding_scored_count ?? 0) === 0 &&
    (diagnostics.evidence_embedding_inference_calls ?? 0) === 0 &&
    (diagnostics.evidence_embedding_failure_class ?? null) === null;
}
