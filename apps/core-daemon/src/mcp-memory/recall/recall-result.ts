import type { RecallCandidate, SoulMemorySearchDegradationReason } from "@do-soul/alaya-protocol";
import { mapEmbeddingProviderDiagnosticToMcpReason, type RecallPageSourceMetadata } from "@do-soul/alaya-core";

/** Diagnostics slice needed for honest MCP degradation_reason. */
export type RecallMcpHonestyDiagnostics = Readonly<{
  readonly embedding_supplement_status?: string;
  readonly embedding_provider_status?: string;
  readonly provider_degradation_reason?: string | null;
}>;

export function sourceMetadataForRecallResult(result: Readonly<{
  readonly candidates: readonly Pick<RecallCandidate, "object_id" | "staged_warnings">[];
  readonly source_metadata?: RecallPageSourceMetadata;
}>): RecallPageSourceMetadata {
  const metadata = { ...result.source_metadata };
  for (const candidate of result.candidates) {
    if (candidate.staged_warnings === undefined) continue;
    const key = candidate.object_id;
    if (key === undefined) continue;
    metadata[key] = { staged_warnings: candidate.staged_warnings, ...metadata[key] };
  }
  return metadata;
}

export function selectRecallMcpHonestyDiagnostics(
  diagnostics: RecallMcpHonestyDiagnostics | null | undefined
): RecallMcpHonestyDiagnostics | null {
  if (diagnostics === undefined || diagnostics === null) return null;
  return {
    ...(diagnostics.embedding_supplement_status === undefined ? {} : { embedding_supplement_status: diagnostics.embedding_supplement_status }),
    ...(diagnostics.embedding_provider_status === undefined ? {} : { embedding_provider_status: diagnostics.embedding_provider_status }),
    ...(diagnostics.provider_degradation_reason === undefined ? {} : { provider_degradation_reason: diagnostics.provider_degradation_reason })
  };
}

export function resolveMcpDegradationReason(
  recallResult: Readonly<{
    readonly degradation_reason?: SoulMemorySearchDegradationReason | null;
    readonly diagnostics?: RecallMcpHonestyDiagnostics | null;
  }>,
  explainabilityPartial: boolean
): SoulMemorySearchDegradationReason | null {
  if (recallResult.degradation_reason !== undefined && recallResult.degradation_reason !== null) return recallResult.degradation_reason;
  const embeddingReason = mapEmbeddingDegradationReason(recallResult.diagnostics);
  return embeddingReason ?? (explainabilityPartial ? "recall_explainability_partial" : null);
}

function mapEmbeddingDegradationReason(
  diagnostics: RecallMcpHonestyDiagnostics | null | undefined
): SoulMemorySearchDegradationReason | null {
  if (diagnostics === undefined || diagnostics === null) return null;
  if (diagnostics.embedding_supplement_status === "provider_missing") return "provider_missing";
  const mappedProviderReason = mapProviderDegradationReason(diagnostics.provider_degradation_reason);
  // Intentional embedding-off: do not invent unavailable from warmup/pending.
  if (diagnostics.embedding_supplement_status === "disabled") {
    return isHardEmbeddingFailureReason(mappedProviderReason) ? mappedProviderReason : null;
  }
  if (mappedProviderReason !== null) return mappedProviderReason;
  if (diagnostics.embedding_provider_status === "provider_failed"
    || diagnostics.embedding_provider_status === "query_embedding_unusable") return "provider_failed";
  if (diagnostics.embedding_provider_status === "provider_pending") return "provider_unavailable";
  return null;
}

function mapProviderDegradationReason(reason: string | null | undefined): SoulMemorySearchDegradationReason | null {
  return mapEmbeddingProviderDiagnosticToMcpReason(reason);
}

function isHardEmbeddingFailureReason(reason: SoulMemorySearchDegradationReason | null): reason is SoulMemorySearchDegradationReason {
  return reason === "provider_failed" || reason === "provider_missing" || reason === "no_stored_vectors";
}
