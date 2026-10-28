import { AlayaError, MILLIGRADE_TOP, ORDINARY_NATIVE_FIELD_RESULT_VERSION, SoulMemorySearchResponseSchema, indexEntryCacheKey, indexEntryObjectKind, indexMemoryObjectId,
  type InformationIndex, type MemorySearchResult, type RecallCandidate, type StagedWarningArray } from "@do-soul/alaya-protocol";
import { projectSourceDisclosure } from "./source-disclosure.js";
import { completeSourceDeliveryEnd, sourceDeliveryEnds, sourceDeliveryPrefix } from "./source-delivery-prefix.js";
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
  delivery_boundaries?: import("@do-soul/alaya-protocol").SourceDeliveryBoundaries;
}>>>;

/** Numeric evidence from the existing encoder decisions, never a second fit policy. */
export type RecallResultEncodingObservation = Readonly<{
  candidate_count: number; result_count: number; used_tokens: number;
  count_limited_entries: number;
  metadata_block: Readonly<{ essential_bytes: number; remaining_tokens: number }> | null;
}>;

/** The field and its public adapter use this exact codec. Recorded structural
 * ends shorten literal previews only; unavailable boundaries retain UTF-8 prefixes.
 */
export function encodeIndexResults(index: InformationIndex, previews: ReadonlyMap<string, string> = new Map(),
  maxTotalTokens = 2_000, sourceMetadata: RecallPageSourceMetadata = {}, onEntry?: () => void,
  observe?: (observation: RecallResultEncodingObservation) => void): readonly MemorySearchResult[] {
  if (index.result_version.startsWith("ordinary-native-field.")
    && index.result_version !== ORDINARY_NATIVE_FIELD_RESULT_VERSION) {
    throw new AlayaError("CONFLICT", "ordinary field result version is unsupported for delivery");
  }
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
    const span = entry.target.kind === "source_evidence" ? entry.target.span : undefined;
    const boundaryEnds = span === undefined || retainedPreview === undefined ? undefined
      : sourceDeliveryEnds(metadata?.delivery_boundaries, span.content_start);
    return { entry, objectId, retainedPreview, preview, evidencePointers, stagedWarnings, reasons, disclosure,
      essentialBytes, reasonedBytes, boundaryEnds };
  });
  let optionalAllowance = Math.max(0, maxTotalTokens - rows.reduce((sum, row) =>
    sum + Math.max(1, Buffer.byteLength(row.preview) + row.essentialBytes), 0));
  const encoded: MemorySearchResult[] = [];
  let usedTokens = 0;
  let metadataBlock: RecallResultEncodingObservation["metadata_block"] = null;
  for (const row of rows) {
    const { entry, objectId, retainedPreview, preview, evidencePointers, stagedWarnings, reasons, disclosure,
      essentialBytes, reasonedBytes, boundaryEnds } = row;
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
    const fitted = fitEncodedPreview(preview, metadataBytes, maxTotalTokens - usedTokens, boundaryEnds);
    if (encoded.length > 0 && boundaryEnds !== undefined
      && completeSourceDeliveryEnd(fitted?.preview ?? "", boundaryEnds) === undefined) {
      const fresh = fitEncodedPreview(preview, metadataBytes, maxTotalTokens, boundaryEnds);
      // Refuse this wider membership fit before issuance; the projector retries
      // a shorter prefix without advancing the deferred source. Oversized first
      // units still make UTF-8 progress instead of indefinitely deferring.
      if (fresh !== null && completeSourceDeliveryEnd(fresh.preview, boundaryEnds) !== undefined) break;
    }
    const content = fitted?.preview ?? "[payload omitted]", tokenEstimate = fitted?.tokenEstimate ?? metadataBytes;
    usedTokens += tokenEstimate;
    encoded.push({ ...(objectId === undefined ? {} : { object_id: objectId }), object_kind: indexEntryObjectKind(entry),
      target: deliveredTarget(entry.target, content, fitted !== null && retainedPreview !== undefined),
      relevance_score: score, content_preview: content,
      payload_available: fitted !== null && retainedPreview !== undefined,
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
  const missingPayload = results.length < index.entries.length || results.some(row => row.payload_available !== true);
  let partialPayload = missingPayload;
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
      missingPayload,
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

function fitEncodedPreview(preview: string, metadataBytes: number, remaining: number,
  boundaryEnds?: readonly number[]) {
  const cost = (text: string) => Math.max(1, Buffer.byteLength(text) + metadataBytes);
  if (cost(preview) <= remaining && boundaryEnds === undefined) return { preview, tokenEstimate: cost(preview) };
  if (remaining - metadataBytes < 1 || remaining <= 1) return null;
  const truncated = sourceDeliveryPrefix(preview, text => cost(text) <= remaining, boundaryEnds);
  if (truncated.length < 1) return null;
  return { preview: truncated, tokenEstimate: cost(truncated) };
}
