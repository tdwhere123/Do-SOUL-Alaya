import {
  MILLIGRADE_TOP,
  type InformationIndex,
  type MemorySearchResult,
  type StagedWarningArray,
  type RecallCandidate,
  type SoulMemorySearchDegradationReason
} from "@do-soul/alaya-protocol";
import { mapEmbeddingProviderDiagnosticToMcpReason } from "@do-soul/alaya-core";

/** Diagnostics slice needed for honest MCP degradation_reason. */
export type RecallMcpHonestyDiagnostics = Readonly<{
  readonly embedding_supplement_status?: string;
  readonly embedding_provider_status?: string;
  readonly provider_degradation_reason?: string | null;
}>;

export function encodeIndexResults(
  index: InformationIndex,
  previews: ReadonlyMap<string, string> = new Map(),
  maxTotalTokens = 2_000,
  sourceMetadata: Readonly<Record<string, Readonly<{
    readonly evidence_refs?: readonly string[];
    readonly staged_warnings?: StagedWarningArray;
  }>>> = {}
): readonly MemorySearchResult[] {
  const encoded: MemorySearchResult[] = [];
  let usedTokens = 0;
  for (const [offset, entry] of index.entries.entries()) {
    if (offset >= index.representation.page_budget) break;
    const score = entry.association_milligrades / MILLIGRADE_TOP;
    const preview = previews.get(entry.object_id) ?? "[payload omitted]";
    const metadata = sourceMetadata[entry.object_id];
    const evidencePointers = metadata?.evidence_refs ?? [];
    const stagedWarnings = metadata?.staged_warnings?.map((warning) => ({
      ...warning, target_object_id: entry.object_id
    }));
    const metadataBytes = evidencePointers.length === 0 && (stagedWarnings?.length ?? 0) === 0
      ? 0 : Buffer.byteLength(JSON.stringify({ evidencePointers, stagedWarnings }), "utf8");
    const fitted = fitEncodedPreview(preview, metadataBytes, maxTotalTokens - usedTokens);
    if (fitted === null) break;
    // Emitting the bytes then flagging within_budget=false is not an allowance.
    const usedThrough = usedTokens + fitted.tokenEstimate;
    usedTokens = usedThrough;
    encoded.push({
      object_id: entry.object_id,
      object_kind: "memory_entry",
      relevance_score: score,
      content_preview: fitted.preview,
      evidence_pointers: evidencePointers,
      ...(stagedWarnings === undefined ? {} : { staged_warnings: stagedWarnings }),
      ...(entry.hypothesis_id === undefined ? {} : { hypothesis_id: entry.hypothesis_id }),
      ...(entry.program_state === undefined ? {} : { program_state: entry.program_state }),
      ...(entry.time_state === undefined ? {} : { time_state: entry.time_state }),
      ...(entry.output_binding === undefined ? {} : { output_binding: entry.output_binding }),
      selection_reason: `Associated at ${entry.association_milligrades} milligrades; claim ${entry.claim}.`,
      source_channels: ["conditional_field"],
      score_factors: { activation: score, relevance: score },
      budget_state: {
        token_estimate: fitted.tokenEstimate,
        max_entries: index.representation.page_budget,
        max_total_tokens: maxTotalTokens,
        remaining_entries: Math.max(0, index.representation.page_budget - encoded.length),
        remaining_tokens: Math.max(0, maxTotalTokens - usedThrough),
        within_budget: true
      }
    });
  }
  return encoded;
}

export function frameEncodedIndex(
  index: InformationIndex,
  results: readonly MemorySearchResult[]
): InformationIndex {
  if (results.length >= index.entries.length) return index;
  return {
    ...index,
    completeness: {
      ...index.completeness,
      payload: "omitted",
      transport: index.completeness.transport === "complete" ? "partial" : index.completeness.transport
    }
  };
}

export function sourceMetadataForRecallResult(result: Readonly<{
  readonly candidates: readonly Pick<RecallCandidate, "object_id" | "staged_warnings">[];
  readonly source_metadata?: Parameters<typeof encodeIndexResults>[3];
}>): NonNullable<Parameters<typeof encodeIndexResults>[3]> {
  const metadata = { ...result.source_metadata };
  for (const candidate of result.candidates) {
    if (candidate.staged_warnings === undefined) continue;
    metadata[candidate.object_id] = {
      staged_warnings: candidate.staged_warnings,
      ...metadata[candidate.object_id]
    };
  }
  return metadata;
}

export function selectRecallMcpHonestyDiagnostics(
  diagnostics: RecallMcpHonestyDiagnostics | null | undefined
): RecallMcpHonestyDiagnostics | null {
  if (diagnostics === undefined || diagnostics === null) {
    return null;
  }
  return {
    ...(diagnostics.embedding_supplement_status === undefined
      ? {}
      : { embedding_supplement_status: diagnostics.embedding_supplement_status }),
    ...(diagnostics.embedding_provider_status === undefined
      ? {}
      : { embedding_provider_status: diagnostics.embedding_provider_status }),
    ...(diagnostics.provider_degradation_reason === undefined
      ? {}
      : { provider_degradation_reason: diagnostics.provider_degradation_reason })
  };
}

export function resolveMcpDegradationReason(
  recallResult: Readonly<{
    readonly degradation_reason?: SoulMemorySearchDegradationReason | null;
    readonly diagnostics?: RecallMcpHonestyDiagnostics | null;
  }>,
  explainabilityPartial: boolean
): SoulMemorySearchDegradationReason | null {
  if (recallResult.degradation_reason !== undefined && recallResult.degradation_reason !== null) {
    return recallResult.degradation_reason;
  }
  const embeddingReason = mapEmbeddingDegradationReason(recallResult.diagnostics);
  if (embeddingReason !== null) {
    return embeddingReason;
  }
  return explainabilityPartial ? "recall_explainability_partial" : null;
}

function mapEmbeddingDegradationReason(
  diagnostics: RecallMcpHonestyDiagnostics | null | undefined
): SoulMemorySearchDegradationReason | null {
  if (diagnostics === undefined || diagnostics === null) {
    return null;
  }
  if (diagnostics.embedding_supplement_status === "provider_missing") {
    return "provider_missing";
  }
  const mappedProviderReason = mapProviderDegradationReason(
    diagnostics.provider_degradation_reason
  );
  // Intentional embedding-off: do not invent unavailable from warmup/pending.
  if (diagnostics.embedding_supplement_status === "disabled") {
    return isHardEmbeddingFailureReason(mappedProviderReason) ? mappedProviderReason : null;
  }
  if (mappedProviderReason !== null) {
    return mappedProviderReason;
  }
  if (
    diagnostics.embedding_provider_status === "provider_failed" ||
    diagnostics.embedding_provider_status === "query_embedding_unusable"
  ) {
    return "provider_failed";
  }
  if (diagnostics.embedding_provider_status === "provider_pending") {
    return "provider_unavailable";
  }
  return null;
}

function mapProviderDegradationReason(
  reason: string | null | undefined
): SoulMemorySearchDegradationReason | null {
  return mapEmbeddingProviderDiagnosticToMcpReason(reason);
}

function isHardEmbeddingFailureReason(
  reason: SoulMemorySearchDegradationReason | null
): reason is SoulMemorySearchDegradationReason {
  return (
    reason === "provider_failed" ||
    reason === "provider_missing" ||
    reason === "no_stored_vectors"
  );
}

function fitEncodedPreview(
  preview: string,
  metadataBytes: number,
  remaining: number
): Readonly<{ readonly preview: string; readonly tokenEstimate: number }> | null {
  const tokenEstimate = Math.max(1, Buffer.byteLength(preview, "utf8") + metadataBytes);
  if (tokenEstimate <= remaining) return { preview, tokenEstimate };
  const maxPreviewBytes = remaining - metadataBytes;
  // A 1-token remainder is the token_estimate floor; it cannot also hold a 1-byte preview plus metadata.
  if (maxPreviewBytes < 1 || remaining <= 1) return null;
  const truncated = truncateUtf8(preview, maxPreviewBytes);
  const truncatedEstimate = Math.max(1, Buffer.byteLength(truncated, "utf8") + metadataBytes);
  if (truncated.length < 1 || truncatedEstimate > remaining) return null;
  return { preview: truncated, tokenEstimate: truncatedEstimate };
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes < 1) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let truncated = text.slice(0, maxBytes);
  while (truncated.length > 0 && Buffer.byteLength(truncated, "utf8") > maxBytes) {
    truncated = truncated.slice(0, truncated.length - 1);
  }
  return truncated;
}
