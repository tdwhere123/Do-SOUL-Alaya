import type { SoulMemorySearchDegradationReason } from "@do-soul/alaya-protocol";

/**
 * Internal embedding diagnostics → public MCP SoulMemorySearchDegradationReason.
 * Unknown diagnostics stay unmapped (null) so MCP does not invent a reason.
 */
export const EMBEDDING_PROVIDER_DIAGNOSTIC_TO_MCP_REASON = Object.freeze({
  no_stored_vectors: "no_stored_vectors",
  provider_missing: "provider_missing",
  provider_unavailable: "provider_unavailable",
  provider_warmup_pending: "provider_unavailable",
  query_embedding_pending: "provider_unavailable",
  provider_failed: "provider_failed",
  query_embedding_failed: "provider_failed",
  local_vector_lookup_failed: "provider_failed"
} as const satisfies Record<string, SoulMemorySearchDegradationReason>);

const KNOWN_INTERNAL_DIAGNOSTICS = new Set([
  "query_embedding_failed",
  "provider_unavailable",
  "local_vector_lookup_failed",
  "query_embedding_pending",
  "no_stored_vectors"
]);

/** Map a provider diagnostic to MCP degradation_reason; unknown → null. */
export function mapEmbeddingProviderDiagnosticToMcpReason(
  reason: string | null | undefined
): SoulMemorySearchDegradationReason | null {
  if (reason === undefined || reason === null) {
    return null;
  }
  const normalized = reason.trim().toLowerCase();
  if (normalized.length === 0) {
    return null;
  }
  const mapped = (
    EMBEDDING_PROVIDER_DIAGNOSTIC_TO_MCP_REASON as Readonly<
      Record<string, SoulMemorySearchDegradationReason>
    >
  )[normalized];
  return mapped ?? null;
}

/**
 * Normalize an internal embedding diagnostic. Known tokens pass through;
 * unknown collapse to provider_unavailable so callers always get a vocabulary
 * member (unlike MCP mapping, which leaves unknown as null).
 */
export function normalizeEmbeddingProviderDegradationReason(reason: string): string | null {
  const normalized = reason.trim().toLowerCase();
  if (KNOWN_INTERNAL_DIAGNOSTICS.has(normalized)) {
    return normalized;
  }
  return "provider_unavailable";
}
