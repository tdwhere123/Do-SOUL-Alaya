import { SourceSemanticResourceExhausted, SourceSemanticResourceLedger, indexEntryCacheKey, indexMemoryObjectId,
  type InformationIndex } from "@do-soul/alaya-protocol";
import type { ConditionalFieldRecallRequest } from "./recall-service-runner-types.js";
import type { RecallSourceMetadata } from "./recall-service-results.js";
import { encodeIndexResults, encodeRecallPageResponse, frameEncodedIndex,
  type RecallResultEncodingObservation } from "./recall-page-encoding.js";
import { preparedDeliveryId } from "./index-continuation.js";
import { RecallEnvelopeFraming } from "./recall-envelope-framing.js";
import { CoreError } from "../../shared/errors.js";
import { captureRecallData } from "./captured-recall-request.js";

/** Fixed codec phases every page pays: the envelope is assembled and serialized even
 * when its membership is empty. An empty page is therefore never free. */
const ENVELOPE_PHASES = RecallEnvelopeFraming.minimumWork;
/** Bounded codec-entry reservation, not a charge or a promise that the byte scan
 * completes. Additional work is paid incrementally by RecallEnvelopeFraming. */
export function framingReserve(entryCount: number): number {
  return ENVELOPE_PHASES + Math.min(Math.max(0, entryCount), 62);
}

/** Which allowance stopped this attempt. Never conflated with an envelope that is
 * genuinely too small: work/memory interruption is recoverable by a larger budget,
 * while an encoded page that still cannot carry its membership is deterministic. */
export type RecallPageInterruption = "work" | "memory" | "codec";

/** No unmeasured page may be acknowledged; the incoming token remains unconsumed. */
export function framingInterruption(resource: RecallPageInterruption, fit?: RecallPageFitObservation): CoreError {
  return new CoreError("CONFLICT", "Recall public envelope framing interrupted; delivery was not issued", {
    details: { outcome: "resource_exhausted", resource: `framing_${resource}`,
      reason: "framing_interrupted", ...(fit === undefined ? {} : { page_fit: fit }) }
  });
}

/** Bounded private facts about one attempt. No source identities, text, index or
 * previews cross this diagnostic boundary. Null means not measured, not zero. */
export type RecallPageFitObservation = Readonly<{
  measurement: "complete" | "interrupted";
  expected_result_count: number;
  representation_page_budget: number;
  max_total_tokens: number;
  max_encoded_bytes: number;
  measured_bytes: number;
  byte_overflow: boolean | null;
  encoding: RecallResultEncodingObservation | null;
  codec_invocations: number;
  spent_work: number;
  spent_memory_bytes: number;
}>;

/** Completed byte measurements and encoded membership are independent fit gates.
 * A replay can also refuse an otherwise fitted but changed page. */
export function pageResourceRefusal(input: Readonly<{ message: string } & (
  { fit: RecallPageFitObservation } | { available_bytes: number; required_bytes: number }
)>): CoreError {
  const fit = "fit" in input ? input.fit : undefined;
  const omitted = fit?.encoding !== null && fit?.encoding !== undefined
    && fit.encoding.result_count !== fit.expected_result_count;
  const overflow = fit === undefined || fit.byte_overflow === true;
  return new CoreError("CONFLICT", input.message, {
    details: {
      outcome: "resource_exhausted",
      resource: omitted ? "encoded_members" : overflow ? "encoded_page" : "replay_page",
      reason: omitted ? "encoded_member_omission" : overflow ? "encoded_byte_overflow" : "replay_changed",
      ...(fit === undefined && "available_bytes" in input
        ? { available_bytes: input.available_bytes, required_bytes: input.required_bytes }
        : fit?.byte_overflow === true
          ? { available_bytes: fit.max_encoded_bytes, required_bytes: fit.measured_bytes } : {}),
      ...(fit === undefined ? {} : { page_fit: fit })
    }
  });
}

export type RecallPageFit = Readonly<{
  readonly index: InformationIndex;
  readonly previews: ReadonlyMap<string, string>;
  /** Exact size after a completed scan; measured prefix only on interruption.
   * Zero with interruption means no bytes measured, not an empty envelope. */
  readonly bytes: number;
  readonly result_count: number;
  readonly fits: boolean;
  readonly observation: RecallPageFitObservation;
  /** Set only when the resource owner refused the attempt; `fits` is then false. */
  readonly interruption?: RecallPageInterruption;
}>;

/** Diagnostic evidence from the actual fit inputs, before any membership commits. */
export type RecallPageAttempt = Readonly<{
  readonly index: InformationIndex;
  readonly previews: readonly (readonly [string, string])[];
  readonly metadata: Readonly<Record<string, RecallSourceMetadata>>;
  readonly request: Pick<ConditionalFieldRecallRequest, "budget" | "requested_budget" | "delivery_budget" | "governance">;
  readonly request_digest: string;
  readonly codec: "default" | "custom";
  readonly allowance: Readonly<{ work_units: number; memory_bytes: number }>;
  readonly outcome: Readonly<{ fits: boolean; bytes: number; result_count: number;
    interruption: RecallPageInterruption | null; observation: RecallPageFitObservation }>;
}>;

/** Fit the actual public codec on the fully assembled page. The caller supplies the
 * final index: membership continuation, sealed token and hydrated visible spans must
 * already be present, and the committed page must be this returned page without later
 * expansion.
 *
 * Accounting is performed by this owner on the page's real cost: the entry work it
 * actually framed plus bounded JSON traversal and measured byte work, and
 * that charge is taken for every attempt that runs. An empty membership is not a free
 * envelope, and an attempt that cannot fit is not free either. The envelope is
 * transient delivery output and retains no copy of the index, previews or text, so it
 * is not also charged as retained memory.
 */
export function fitProjectedRecallPage(input: Readonly<{
  index: InformationIndex; previews: ReadonlyMap<string, string>; metadata: Readonly<Record<string, RecallSourceMetadata>>;
  request: ConditionalFieldRecallRequest; request_digest: string; meter: SourceSemanticResourceLedger;
}>): RecallPageFit {
  const budget = deliveryBudgetOf(input.request);
  let codecInvocations = 0;
  let encoding: RecallResultEncodingObservation | null = null;
  const initialWork = input.meter.spentWork, initialBytes = input.meter.spentBytes;
  const finish = (fit: Omit<RecallPageFit, "observation">): RecallPageFit => {
    const observed = { ...fit, observation: {
      measurement: fit.interruption === undefined ? "complete" as const : "interrupted" as const,
      expected_result_count: input.index.entries.length,
      representation_page_budget: input.index.representation.page_budget,
      max_total_tokens: budget.max_total_tokens, max_encoded_bytes: budget.max_encoded_bytes,
      measured_bytes: fit.bytes, byte_overflow: fit.interruption === undefined ? fit.bytes > budget.max_encoded_bytes : null,
      encoding, codec_invocations: codecInvocations,
      spent_work: input.meter.spentWork - initialWork, spent_memory_bytes: input.meter.spentBytes - initialBytes
    } };
    try { input.request.observe_page_fit?.(structuredClone({ ...observed, codec_invocations: codecInvocations })); }
    catch { /* Diagnostics cannot change fitting, resource refusal or issuance. */ }
    return observed;
  };
  // No page is framed for free: below the envelope floor the attempt is refused
  // before the codec runs.
  if (input.meter.work < ENVELOPE_PHASES + input.index.entries.length) {
    return finish({ index: input.index, previews: new Map(), bytes: 0, result_count: 0, fits: false,
      interruption: "work" });
  }
  const framing = new RecallEnvelopeFraming(input.meter);
  let codecRefusal: SourceSemanticResourceExhausted | undefined;
  // Attribute only a refusal from this fit's owner. A foreign codec ledger or
  // invalid codec data must remain a codec failure, not field exhaustion.
  const codecMeter = input.request.encode_page === undefined ? input.meter : new Proxy(input.meter, {
    get(target, key, receiver) {
      if (key !== "reserve") return Reflect.get(target, key, receiver);
      return (...args: Parameters<SourceSemanticResourceLedger["reserve"]>) => {
        try { return target.reserve(...args); }
        catch (error) { if (error instanceof SourceSemanticResourceExhausted) codecRefusal = error; throw error; }
      };
    }
  });
  try {
    framing.begin();
    const results = encodeIndexResults(input.index, input.previews, budget.max_total_tokens, input.metadata,
      () => framing.entry(), observation => { encoding = observation; });
    const index = frameEncodedIndex(input.index, results);
    // Availability comes from hydration and fitting, never from source text.
    const previews = new Map(index.entries.flatMap((entry, offset) => {
      const preview = results[offset]?.content_preview;
      return preview === undefined || results[offset]?.payload_available !== true ? []
        : [[indexEntryCacheKey(entry), input.previews.get(indexEntryCacheKey(entry)) === ""
          && entry.target.kind === "source_evidence" && preview === "[empty source]" ? "" : preview] as const];
    }));
    framing.enterCodec();
    codecInvocations++;
    const envelope = input.request.encode_page === undefined ? encodeRecallPageResponse({
      delivery_id: `delivery_${preparedDeliveryId(input.request_digest, index)}`, index, results,
      active_constraints: input.request.governance?.constraints ?? [],
      active_constraints_count: input.request.governance?.total_count ?? null,
      active_constraints_completeness: input.request.governance?.completeness ?? "incomplete",
      degradation_reason: null
    }) : input.request.encode_page(captureRecallData(index), codecPreviews(previews),
      captureRecallData(input.metadata), codecMeter);
    const bytes = framing.measure(envelope);
    const fits = results.length === index.entries.length && bytes <= budget.max_encoded_bytes;
    return finish({ index, previews, bytes, result_count: results.length, fits });
  } catch (error) {
    if (framing.interrupted) {
      return finish({ index: input.index, previews: new Map(), bytes: framing.measuredBytes, result_count: 0, fits: false,
        interruption: "work" });
    }
    if (codecRefusal !== undefined && error === codecRefusal) {
      return finish({ index: input.index, previews: new Map(), bytes: framing.measuredBytes, result_count: 0, fits: false,
        interruption: "codec" });
    }
    if (error instanceof CoreError) throw error;
    throw new CoreError("CONFLICT", error instanceof Error ? error.message : "Recall page codec failed", {
      cause: error, details: { outcome: "codec_failed", resource: "public_envelope" }
    });
  }
}

/** Snapshot only the current candidate's own inputs, without retaining producer references. */
export function captureRecallPageAttempt(input: Readonly<{
  index: InformationIndex; previews: ReadonlyMap<string, string>; metadata: Readonly<Record<string, RecallSourceMetadata>>;
  request: ConditionalFieldRecallRequest; request_digest: string;
  allowance: RecallPageAttempt["allowance"]; fit: RecallPageFit;
}>): RecallPageAttempt {
  const keys = new Set(input.index.entries.flatMap(entry => {
    const objectId = indexMemoryObjectId(entry);
    return objectId === undefined ? [indexEntryCacheKey(entry)] : [indexEntryCacheKey(entry), objectId];
  }));
  const previews = [...keys].flatMap(key => input.previews.has(key) ? [[key, input.previews.get(key)!] as const] : []);
  const metadata = Object.fromEntries([...keys].flatMap(key => Object.hasOwn(input.metadata, key)
    ? [[key, input.metadata[key]!] as const] : []));
  return structuredClone({ index: input.index, previews, metadata,
    request: { budget: input.request.budget, requested_budget: input.request.requested_budget,
      delivery_budget: input.request.delivery_budget, governance: input.request.governance },
    request_digest: input.request_digest, codec: input.request.encode_page === undefined ? "default" : "custom",
    allowance: input.allowance, outcome: { fits: input.fit.fits, bytes: input.fit.bytes, result_count: input.fit.result_count,
      interruption: input.fit.interruption ?? null, observation: input.fit.observation } });
}

/** Codecs may retain their arguments, but cannot mutate the measured page or the
 * preview cache. A read-only facade also keeps Map.forEach from leaking a writer. */
function codecPreviews(previews: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
  const owned = new Map(previews);
  const view: ReadonlyMap<string, string> = Object.freeze({
    size: owned.size,
    get: (key: string) => owned.get(key), has: (key: string) => owned.has(key),
    entries: () => owned.entries(), keys: () => owned.keys(), values: () => owned.values(),
    [Symbol.iterator]: () => owned[Symbol.iterator](),
    forEach: (callback: (value: string, key: string, map: ReadonlyMap<string, string>) => void, thisArg?: unknown) => {
      owned.forEach((value, key) => callback.call(thisArg, value, key, view));
    }
  });
  return view;
}

/** The one default delivery envelope: an explicit surface budget wins, otherwise the
 * announced request memory budget bounds the encoded page. The compiled public view
 * and the page fit derive the same value, so both call this owner. A direct Core
 * request that declares no surface token cap must not invent a smaller content
 * ceiling than its own encoded-byte allowance.
 */
export function deliveryBudgetOf(
  request: ConditionalFieldRecallRequest
): NonNullable<ConditionalFieldRecallRequest["delivery_budget"]> {
  const maxEncodedBytes = (request.requested_budget ?? request.budget).memory_bytes;
  return request.delivery_budget ?? { max_total_tokens: maxEncodedBytes,
    max_encoded_bytes: maxEncodedBytes };
}
