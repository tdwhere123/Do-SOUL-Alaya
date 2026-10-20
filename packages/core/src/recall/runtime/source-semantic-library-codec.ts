import {
  MILLIGRADE_TOP, SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET, SoulInterpretationResponseSchema,
  indexEntryCacheKey, indexEntryObjectKind, indexMemoryObjectId, verifySourceSemanticLibraryDelivery,
  type SourceSemanticResourceLedger, type SourceSemanticResourceBudget, type InformationIndex,
  type MemorySearchResult, type SourceDisclosure, type SourceSemanticWorkerResult, type SoulInterpretationResponse, type IndexEntry
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import { fieldContractSha256 } from "../../shared/field-hash.js";
import { makeTokenEstimator } from "./recall-service-port-helpers.js";
import { projectSourceDisclosure } from "./source-disclosure.js";

export type Recall = Extract<SourceSemanticWorkerResult, { kind: "recall" }>;
export type Meter = Pick<SourceSemanticResourceLedger, "charge" | "retain">;
export const PAYLOAD_TOKENS = 2_000;
export function rawLibraryEntry(entry: IndexEntry): boolean {
  return entry.target.kind === "source_evidence" && entry.interpretation_node === undefined && entry.explanation_ids.length === 0;
}
type PayloadIndex = Pick<InformationIndex, "entries" | "as_of"> & { representation: Pick<InformationIndex["representation"], "page_budget"> };

/** Raw fallback reserves a fair root share; semantic support is admitted atomically. */
export function sourceSemanticLibraryRawPreview(text: string, occupiedRoots: number): string {
  return previewWithinTokens(text, Math.floor(PAYLOAD_TOKENS
    / Math.max(1, Math.min(occupiedRoots, SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET))), makeTokenEstimator());
}
export function encodeSourceSemanticLibraryResults(index: InformationIndex, previews: ReadonlyMap<string, string> = new Map(),
  maxTotalTokens = PAYLOAD_TOKENS, atomic = false, sourceDisclosures: Readonly<Record<string, SourceDisclosure>> = {}): MemorySearchResult[] {
  return projectLibraryResults(index, previews, maxTotalTokens, atomic, sourceDisclosures);
}
/** The same projection kernel serves complete delivery, reusable members and resource-only witnesses. */
function projectLibraryResults(index: PayloadIndex, previews: ReadonlyMap<string, string>, maxTotalTokens: number,
  atomic: boolean, sourceDisclosures: Readonly<Record<string, SourceDisclosure>>): MemorySearchResult[] {
  const encoded: MemorySearchResult[] = [], estimator = makeTokenEstimator();
  const entries = index.entries.slice(0, index.representation.page_budget);
  const payloads = entries.map(entry => {
    const objectId = indexMemoryObjectId(entry);
    const preview = previews.get(indexEntryCacheKey(entry)) ?? (objectId === undefined ? undefined : previews.get(objectId));
    return { available: preview !== undefined, text: preview === "" ? "[empty source]" : preview ?? "[payload omitted]" };
  });
  const required = payloads.map(({ text }) => estimator.estimate(text));
  const totalTokens = required.reduce((sum, tokens) => sum + tokens, 0);
  const allowances = allocatePreviewTokens(required, maxTotalTokens);
  let usedTokens = 0;
  for (const [offset, entry] of entries.entries()) {
    const score = entry.association_milligrades / MILLIGRADE_TOP;
    const objectId = indexMemoryObjectId(entry), payload = payloads[offset]!;
    const proof = entry.interpretation_node !== undefined && entry.explanation_ids.length > 0;
    const disclosure = sourceDisclosures[indexEntryCacheKey(entry)] ?? projectSourceDisclosure({
      material_kind: "original_body", evaluated_as_of: sourceClock(index), proof_use: proof ? "conditional_support" : "source_only"
    });
    const prefix = payload.available ? atomic || proof ? payload.text : previewWithinTokens(payload.text, allowances[offset]!, estimator) : "";
    const content = prefix.length === 0 ? "[payload omitted]" : prefix;
    const tokenEstimate = estimator.estimate(content); usedTokens += tokenEstimate;
    encoded.push({
      ...(objectId === undefined ? {} : { object_id: objectId }), object_kind: indexEntryObjectKind(entry),
      target: entry.target, relevance_score: score, content_preview: content, source_disclosure: disclosure,
      evidence_pointers: [], hypothesis_id: entry.hypothesis_id, program_state: entry.program_state ?? "accepting",
      time_state: entry.time_state ?? "as_of", output_binding: entry.output_binding,
      selection_reason: proof ? `Conditional on interpretation ${entry.interpretation_node!.packet_id}; claim unknown.`
        : "Source evidence without a proved semantic answer; claim unknown.",
      source_channels: proof ? ["conditional_field"] : ["source_record"], score_factors: { activation: score, relevance: score },
      budget_state: payloadBudget(tokenEstimate, usedTokens, totalTokens, index.representation.page_budget,
        encoded.length, maxTotalTokens, payload.available && content === payload.text, atomic, proof ? maxTotalTokens : allowances[offset]!)
    });
  }
  return encoded;
}
export function payloadBudget(tokens: number, used: number, total: number, maxEntries: number, position: number,
  limit: number, available: boolean, atomic: boolean, allowance: number): MemorySearchResult["budget_state"] {
  return { token_estimate: tokens, max_entries: maxEntries, max_total_tokens: limit,
    remaining_entries: Math.max(0, maxEntries - position - 1), remaining_tokens: Math.max(0, limit - used),
    within_budget: available && (atomic ? total <= limit : tokens <= allowance) };
}
function sourceClock(index: Pick<InformationIndex, "as_of">): string {
  if (index.as_of === undefined) throw new CoreError("OBLIGATION_VIOLATION", "library source disclosure requires an evaluation clock");
  return index.as_of;
}
function allocatePreviewTokens(required: readonly number[], limit: number): number[] {
  const allocated = required.map(() => 0);
  let remaining = Math.max(0, Math.floor(limit)), pending = required.map((_, index) => index);
  while (remaining > 0 && pending.length > 0) {
    const share = Math.floor(remaining / pending.length), remainder = remaining % pending.length;
    for (const [position, index] of pending.entries()) {
      const increment = Math.min(required[index]! - allocated[index]!, share + (position < remainder ? 1 : 0));
      allocated[index]! += increment; remaining -= increment;
    }
    pending = pending.filter(index => allocated[index]! < required[index]!);
  }
  return allocated;
}
function previewWithinTokens(text: string, allowance: number, estimator: ReturnType<typeof makeTokenEstimator>): string {
  let low = 0, high = text.length;
  while (low < high) {
    const end = Math.ceil((low + high) / 2);
    if (estimator.estimate(text.slice(0, end)) <= allowance) low = end;
    else high = end - 1;
  }
  if (low > 0 && low < text.length && /[\uD800-\uDBFF]/u.test(text[low - 1]!) && /[\uDC00-\uDFFF]/u.test(text[low]!)) low -= 1;
  return text.slice(0, low);
}

export type CapturePrices = { costs: WeakMap<object, SourceSemanticResourceBudget>; work: number; bytes: number };
/** Descriptor-safe copy before validation; never freeze or subsequently read caller containers.
 * Ledger.capture's pre-parser walk would invoke accessors, or require another ownership copy. */
export function captureInput<T>(value: T, meter?: Meter, prices?: CapturePrices): T {
  const beforeWork = prices?.work ?? 0, beforeBytes = prices?.bytes ?? 0;
  meter?.charge(1, 0, "library encoding input check");
  if (prices !== undefined) prices.work++;
  if (value === null || typeof value !== "object") return value;
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
  if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null) throw new CoreError("VALIDATION", "library encoding requires plain data");
  const keys = Object.keys(value), bytes = captureFrameBytes(keys.length);
  meter?.charge(keys.length, bytes, "library encoding input capture");
  if (prices !== undefined) { prices.work += keys.length; prices.bytes += bytes; }
  const owned = array ? new Array((value as unknown[]).length) : Object.create(prototype) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!("value" in descriptor)) throw new CoreError("VALIDATION", "library encoding requires data properties");
    Object.defineProperty(owned, key, { value: captureInput(descriptor.value, meter, prices), enumerable: true, writable: true, configurable: true });
  }
  Object.freeze(owned);
  if (prices !== undefined) {
    meter?.charge(1, 48, "library encoding capture price storage");
    prices.costs.set(owned, Object.freeze({ work_units: prices.work - beforeWork, memory_bytes: prices.bytes - beforeBytes }));
  }
  return owned as T;
}
function captureFrameBytes(keys: number): number { return 64 + keys * 16; }
const SCALAR_CAPTURE = Object.freeze({ work_units: 1, memory_bytes: 0 });
/** Quote the executed capture-frame contract, borrowing only owner-issued subtree prices. */
export function quoteCapture(value: unknown, meter: Meter, prices: CapturePrices): SourceSemanticResourceBudget {
  if (value === null || typeof value !== "object") return SCALAR_CAPTURE;
  meter.charge(1, 0, "library encoding capture price lookup");
  const prior = prices.costs.get(value);
  if (prior !== undefined) return prior;
  const keys = Object.keys(value);
  meter.charge(keys.length, keys.length * 8 + 48, "library encoding capture completion scan");
  let work_units = 1 + keys.length, memory_bytes = captureFrameBytes(keys.length);
  for (const key of keys) {
    const cost = quoteCapture((value as Record<string, unknown>)[key], meter, prices);
    work_units += cost.work_units; memory_bytes += cost.memory_bytes;
  }
  return { work_units, memory_bytes };
}

/** One proof, token, coverage and public-schema kernel; final admission never uses a size bound alone. */
export function encodeOwned(result: Recall): SoulInterpretationResponse {
  verifySourceSemanticLibraryDelivery(result, fieldContractSha256);
  if (result.execution === undefined) throw new CoreError("VALIDATION", "Source library v2 requires actual execution accounting");
  const { kind: _kind, previews, coverage, ...rest } = result;
  const results = encodeSourceSemanticLibraryResults(result.index, new Map(Object.entries(previews ?? {})), PAYLOAD_TOKENS, true, result.source_disclosures);
  const omitted = results.some(row => !row.budget_state.within_budget), incomplete = omitted || coverage.payload !== "complete";
  return SoulInterpretationResponseSchema.parse({ operation: "recall", ...rest, results, total_count: results.length,
    index: incomplete ? { ...result.index, completeness: { ...result.index.completeness, payload: "partial" } } : result.index,
    coverage: { ...coverage, payload: omitted ? "truncated" : coverage.payload } });
}
/** Compatible public codec; budgeted worker callers use the metered encoding session. */
export function encodeSourceSemanticLibraryResponse(result: Recall): SoulInterpretationResponse {
  return encodeOwned(captureInput(result));
}
