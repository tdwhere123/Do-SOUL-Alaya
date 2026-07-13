import { readOptionalTreatmentBoolean } from "./strict-treatment-config.js";

interface EmbeddingTreatmentDiagnostics {
  readonly embedding_provider_status: string;
  readonly provider_degradation_reason: string | null;
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
  if (enabled) assertBiEncoderTreatmentActive(toActivationEvidence(diagnostics));
  else assertControlInactive(diagnostics);
}

export function requiresEmbeddingTreatmentDiagnostics(
  env: Readonly<Record<string, string | undefined>>
): boolean {
  return readOptionalTreatmentBoolean(
    env.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT,
    "ALAYA_ENABLE_EMBEDDING_SUPPLEMENT"
  ) !== null || readOptionalTreatmentBoolean(
    env.ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK,
    "ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK"
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
  const scoredCandidates = evidence.embeddingSimilarities.filter(
    (similarity) => (similarity ?? 0) > 0
  ).length;
  const workspaceScanActive = (evidence.workspaceScannedCount ?? 0) > 0 &&
    evidence.workspaceTruncated === false && evidence.workspaceProviderKind !== undefined &&
    evidence.workspaceModelId !== undefined && evidence.workspaceSchemaVersion !== undefined;
  const active = evidence.providerState === "provider_returned" &&
    evidence.providerDegradationReason === null && (scoredCandidates > 0 || workspaceScanActive);
  if (!active) {
    throw new Error(
      "bi-encoder treatment activation failed: " +
      `status=${evidence.providerState} ` +
      `degraded=${evidence.providerDegradationReason ?? "none"} ` +
      `scored_candidates=${scoredCandidates} ` +
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
    diagnostics.candidates.every(
      (candidate) => (candidate.score_factors.embedding_similarity ?? 0) === 0
    ) &&
    diagnostics.embedding_workspace_scanned_count === undefined &&
    diagnostics.embedding_workspace_provider_kind === undefined &&
    diagnostics.embedding_workspace_model_id === undefined &&
    diagnostics.embedding_workspace_schema_version === undefined;
  if (!inactive) {
    throw new Error("bi-encoder control activation failed: embedding work was observed");
  }
}
