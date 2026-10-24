import { SourceSemanticResourceExhausted, SourceSemanticResourceLedger, indexEntryCacheKey,
  type InformationIndex } from "@do-soul/alaya-protocol";
import type { ConditionalFieldRecallRequest } from "./recall-service-runner-types.js";
import type { RecallSourceMetadata } from "./recall-service-results.js";
import { encodeIndexResults, encodeRecallPageResponse, frameEncodedIndex } from "./recall-page-encoding.js";
import { PAYLOAD_OMITTED_PREVIEW } from "./recall-result-encoding.js";
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

export type RecallPageFit = Readonly<{
  readonly index: InformationIndex;
  readonly previews: ReadonlyMap<string, string>;
  /** Exact size after a completed scan; measured prefix only on interruption.
   * Zero with interruption means no bytes measured, not an empty envelope. */
  readonly bytes: number;
  readonly result_count: number;
  readonly fits: boolean;
  /** Set only when the resource owner refused the attempt; `fits` is then false. */
  readonly interruption?: RecallPageInterruption;
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
  const finish = (fit: RecallPageFit): RecallPageFit => {
    try { input.request.observe_page_fit?.(structuredClone({ ...fit, codec_invocations: codecInvocations })); }
    catch { /* Diagnostics cannot change fitting, resource refusal or issuance. */ }
    return fit;
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
      () => framing.entry());
    const index = frameEncodedIndex(input.index, results);
    // An omission placeholder is not a captured preview; keeping it out of the surface
    // cache lets a zero-payload page prove that it exposed no text.
    const previews = new Map(index.entries.flatMap((entry, offset) => {
      const preview = results[offset]?.content_preview;
      return preview === undefined || preview === PAYLOAD_OMITTED_PREVIEW ? []
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
