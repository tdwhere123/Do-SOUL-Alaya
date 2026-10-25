import { AlayaError, MILLIGRADE_TOP, SoulMemorySearchResponseSchema, indexEntryCacheKey, indexEntryObjectKind, indexMemoryObjectId,
  type InformationIndex, type MemorySearchResult, type RecallCandidate, type StagedWarningArray } from "@do-soul/alaya-protocol";
import { projectSourceDisclosure } from "./source-disclosure.js";
import { displayRecallPreview, projectPayloadCompleteness } from "./recall-result-encoding.js";

/** The same complete envelope is sized by the field and returned by MCP. */
export function encodeRecallPageResponse(input: Readonly<{
  delivery_id: string; index: InformationIndex; results: readonly MemorySearchResult[];
  active_constraints: readonly import("@do-soul/alaya-protocol").SoulActiveConstraint[];
  active_constraints_count: number | null; active_constraints_completeness?: "complete" | "incomplete";
  degradation_reason: import("@do-soul/alaya-protocol").SoulMemorySearchDegradationReason | null;
}>) {
  return SoulMemorySearchResponseSchema.parse({ ...input, protocol_version: 1, total_count: input.results.length,
    ...(input.index.order_status === undefined ? {} : { order_status: input.index.order_status }),
    ...(input.index.page_purpose === undefined ? {} : { page_purpose: input.index.page_purpose }),
    ...(input.index.product_updates === undefined ? {} : { product_updates: input.index.product_updates }) });
}

export type RecallPageSourceMetadata = Readonly<Record<string, Readonly<{
  evidence_refs?: readonly string[];
  staged_warnings?: StagedWarningArray;
  source_lookup_reasons?: RecallCandidate["source_lookup_reasons"];
  source_disclosure?: RecallCandidate["source_disclosure"];
}>>>;

/** Numeric evidence from the existing encoder decisions, never a second fit policy. */
export type RecallResultEncodingObservation = Readonly<{
  candidate_count: number; result_count: number; used_tokens: number;
  count_limited_entries: number;
  metadata_block: Readonly<{ essential_bytes: number; remaining_tokens: number }> | null;
}>;

/** The field and its public adapter use this exact codec. Preview shortening is
 * a UTF-8 prefix operation: displayed source intervals never count decoration.
 */
export function encodeIndexResults(index: InformationIndex, previews: ReadonlyMap<string, string> = new Map(),
  maxTotalTokens = 2_000, sourceMetadata: RecallPageSourceMetadata = {}, onEntry?: () => void,
  observe?: (observation: RecallResultEncodingObservation) => void): readonly MemorySearchResult[] {
  if (index.entries.some(entry => entry.interpretation_node !== undefined)) {
    throw new AlayaError("CONFLICT", "conditional interpretation results require the qualified interpretation result capability");
  }
  const rows = index.entries.slice(0, index.representation.page_budget).map(entry => {
    onEntry?.();
    const cacheKey = indexEntryCacheKey(entry), objectId = indexMemoryObjectId(entry);
    const retainedPreview = previews.get(cacheKey) ?? (objectId === undefined ? undefined : previews.get(objectId));
    const preview = displayRecallPreview(retainedPreview, entry.target) ?? "[payload omitted]";
    const metadata = sourceMetadata[cacheKey] ?? (objectId === undefined ? undefined : sourceMetadata[objectId]);
    const evidencePointers = metadata?.evidence_refs ?? [];
    const stagedWarnings = metadata?.staged_warnings?.map(warning => ({ ...warning,
      target_object_id: objectId ?? (entry.target.kind === "source_evidence" ? entry.target.root_id : warning.target_object_id) }));
    const reasons = metadata?.source_lookup_reasons;
    const disclosure = entry.target.kind !== "source_evidence" ? undefined : metadata?.source_disclosure
      ?? projectSourceDisclosure({ material_kind: entry.target.root_kind === "source_record" ? "original_body"
        : entry.target.span?.retained_extent === "gist" ? "retained_gist" : "retained_excerpt", evaluated_as_of: sourceClock(index) });
    const disclosureBytes = disclosure === undefined ? 0 : Buffer.byteLength(JSON.stringify({ source_disclosure: disclosure }));
    const essentialBytes = disclosureBytes + (evidencePointers.length === 0 && (stagedWarnings?.length ?? 0) === 0
      ? 0 : Buffer.byteLength(JSON.stringify({ evidencePointers, stagedWarnings })));
    const reasonedBytes = reasons === undefined ? essentialBytes : disclosureBytes
      + Buffer.byteLength(JSON.stringify({ evidencePointers, stagedWarnings, source_lookup_reasons: reasons }));
    return { entry, objectId, retainedPreview, preview, evidencePointers, stagedWarnings, reasons, disclosure, essentialBytes, reasonedBytes };
  });
  let optionalAllowance = Math.max(0, maxTotalTokens - rows.reduce((sum, row) =>
    sum + Math.max(1, Buffer.byteLength(row.preview) + row.essentialBytes), 0));
  const encoded: MemorySearchResult[] = [];
  let usedTokens = 0;
  let metadataBlock: RecallResultEncodingObservation["metadata_block"] = null;
  for (const row of rows) {
    const { entry, objectId, retainedPreview, preview, evidencePointers, stagedWarnings, reasons, disclosure,
      essentialBytes, reasonedBytes } = row;
    const score = entry.association_milligrades / MILLIGRADE_TOP;
    const optionalBytes = reasonedBytes - essentialBytes;
    const retainedReasons = reasons !== undefined && optionalBytes <= optionalAllowance
      && reasonedBytes < maxTotalTokens - usedTokens ? reasons : undefined;
    const metadataBytes = retainedReasons === undefined ? essentialBytes : reasonedBytes;
    if (retainedReasons !== undefined) optionalAllowance -= optionalBytes;
    if (metadataBytes > maxTotalTokens - usedTokens) {
      metadataBlock = { essential_bytes: essentialBytes, remaining_tokens: maxTotalTokens - usedTokens };
      break;
    }
    const fitted = fitEncodedPreview(preview, metadataBytes, maxTotalTokens - usedTokens);
    const content = fitted?.preview ?? "[payload omitted]", tokenEstimate = fitted?.tokenEstimate ?? metadataBytes;
    usedTokens += tokenEstimate;
    encoded.push({ ...(objectId === undefined ? {} : { object_id: objectId }), object_kind: indexEntryObjectKind(entry),
      target: deliveredTarget(entry.target, content, fitted !== null && retainedPreview !== undefined),
      relevance_score: score, content_preview: content,
      ...(disclosure === undefined ? {} : { source_disclosure: disclosure }), evidence_pointers: evidencePointers,
      ...(stagedWarnings === undefined ? {} : { staged_warnings: stagedWarnings }),
      ...(retainedReasons === undefined ? {} : { source_lookup_reasons: retainedReasons }),
      hypothesis_id: entry.hypothesis_id, program_state: entry.program_state, time_state: entry.time_state, output_binding: entry.output_binding,
      selection_reason: `Associated at ${entry.association_milligrades} milligrades; claim ${entry.claim}.`,
      source_channels: ["conditional_field"], score_factors: { activation: score, relevance: score },
      budget_state: { token_estimate: tokenEstimate, max_entries: index.representation.page_budget, max_total_tokens: maxTotalTokens,
        remaining_entries: Math.max(0, index.representation.page_budget - encoded.length),
        remaining_tokens: Math.max(0, maxTotalTokens - usedTokens), within_budget: true } });
  }
  observe?.({ candidate_count: rows.length, result_count: encoded.length, used_tokens: usedTokens,
    count_limited_entries: index.entries.length - rows.length, metadata_block: metadataBlock });
  return encoded;
}

export function frameEncodedIndex(index: InformationIndex, results: readonly MemorySearchResult[]): InformationIndex {
  let partialPayload = results.length < index.entries.length || results.some(row => row.content_preview === "[payload omitted]");
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
  return { ...index, entries, completeness: { ...index.completeness,
    payload: projectPayloadCompleteness(index.completeness.payload,
      results.some(row => row.content_preview === "[payload omitted]") || results.length < index.entries.length,
      partialPayload),
    transport: results.length < index.entries.length && index.completeness.transport === "complete" ? "partial" : index.completeness.transport } };
}

function sourceClock(index: InformationIndex): string {
  const clock = index.as_of ?? index.continuation?.interpretation_clock;
  if (clock === undefined) throw new AlayaError("VALIDATION", "source disclosure requires an evaluation clock");
  return clock;
}

function deliveredTarget(target: MemorySearchResult["target"], content: string, hasPayload: boolean): MemorySearchResult["target"] {
  if (target.kind !== "source_evidence" || target.span === undefined) return target;
  const span = target.span;
  const bytes = hasPayload ? Math.min(Buffer.byteLength(content), span.content_end - span.content_start) : 0;
  if (hasPayload && bytes === span.content_end - span.content_start) return target;
  return { ...target, span: { ...span, content_end: span.content_start + bytes,
    content_complete: span.content_complete && hasPayload && bytes === span.content_end - span.content_start } };
}

function fitEncodedPreview(preview: string, metadataBytes: number, remaining: number) {
  const tokenEstimate = Math.max(1, Buffer.byteLength(preview) + metadataBytes);
  if (tokenEstimate <= remaining) return { preview, tokenEstimate };
  const maxPreviewBytes = remaining - metadataBytes;
  if (maxPreviewBytes < 1 || remaining <= 1) return null;
  const bytes = Buffer.from(preview);
  let end = Math.min(bytes.length, maxPreviewBytes);
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  const truncated = bytes.subarray(0, end).toString("utf8");
  if (truncated.length < 1) return null;
  return { preview: truncated, tokenEstimate: Math.max(1, Buffer.byteLength(truncated) + metadataBytes) };
}
