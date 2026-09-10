import {
  MILLIGRADE_TOP,
  indexEntryCacheKey,
  indexEntryObjectKind,
  indexMemoryObjectId,
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
    const cacheKey = indexEntryCacheKey(entry);
    const objectId = indexMemoryObjectId(entry);
    const retainedPreview = previews.get(cacheKey) ?? (objectId === undefined ? undefined : previews.get(objectId));
    const preview = retainedPreview ?? "[payload omitted]";
    const metadata = sourceMetadata[cacheKey] ?? (objectId === undefined ? undefined : sourceMetadata[objectId]);
    const evidencePointers = metadata?.evidence_refs ?? [];
    const stagedWarnings = metadata?.staged_warnings?.map((warning) => ({
      ...warning,
      target_object_id: objectId
        ?? (entry.target.kind === "source_evidence" ? entry.target.root_id : warning.target_object_id)
    }));
    const metadataBytes = evidencePointers.length === 0 && (stagedWarnings?.length ?? 0) === 0
      ? 0 : Buffer.byteLength(JSON.stringify({ evidencePointers, stagedWarnings }), "utf8");
    const fitted = fitEncodedPreview(preview, metadataBytes, maxTotalTokens - usedTokens);
    const omitted = fitted === null;
    const content = omitted ? "[payload omitted]" : fitted.preview;
    const tokenEstimate = omitted ? 0 : fitted.tokenEstimate;
    const usedThrough = usedTokens + tokenEstimate;
    usedTokens = usedThrough;
    encoded.push({
      ...(objectId === undefined ? {} : { object_id: objectId }),
      object_kind: indexEntryObjectKind(entry),
      target: deliveredTarget(entry.target, content, !omitted && retainedPreview !== undefined),
      relevance_score: score,
      content_preview: content,
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
        token_estimate: tokenEstimate,
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
  let partialPayload = results.length < index.entries.length
    || results.some((row) => row.content_preview === "[payload omitted]");
  const entries = index.entries.map((entry, offset) => {
    if (entry.target.kind !== "source_evidence") return entry;
    const target = results[offset]?.target;
    if (target?.kind === "source_evidence") {
      if (target.span?.content_complete === false) partialPayload = true;
      return { ...entry, target };
    }
    partialPayload = true;
    const { span: _span, ...root } = entry.target;
    return { ...entry, target: root };
  });
  if (!partialPayload && entries.every((entry, offset) => entry === index.entries[offset])) return index;
  return {
    ...index,
    entries,
    completeness: {
      ...index.completeness,
      payload: results.some((row) => row.content_preview === "[payload omitted]") || results.length < index.entries.length
        ? "omitted"
        : partialPayload ? "partial" : index.completeness.payload,
      transport: results.length < index.entries.length && index.completeness.transport === "complete" ? "partial" : index.completeness.transport
    }
  };
}

function deliveredTarget(target: MemorySearchResult["target"], content: string, hasPayload: boolean): MemorySearchResult["target"] {
  if (target.kind !== "source_evidence" || target.span === undefined) return target;
  const span = target.span;
  const bytes = hasPayload ? Math.min(Buffer.byteLength(content, "utf8"), span.content_end - span.content_start) : 0;
  if (hasPayload && bytes === span.content_end - span.content_start) return target;
  return { ...target, span: { ...span, content_end: span.content_start + bytes,
    content_complete: span.content_complete && hasPayload && bytes === span.content_end - span.content_start } };
}

export function sourceMetadataForRecallResult(result: Readonly<{
  readonly candidates: readonly Pick<RecallCandidate, "object_id" | "staged_warnings">[];
  readonly source_metadata?: Parameters<typeof encodeIndexResults>[3];
}>): NonNullable<Parameters<typeof encodeIndexResults>[3]> {
  const metadata = { ...result.source_metadata };
  for (const candidate of result.candidates) {
    if (candidate.staged_warnings === undefined) continue;
    const key = candidate.object_id;
    if (key === undefined) continue;
    metadata[key] = {
      staged_warnings: candidate.staged_warnings,
      ...metadata[key]
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
  const bytes = Buffer.from(text, "utf8");
  let end = Math.min(bytes.length, maxBytes);
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}
