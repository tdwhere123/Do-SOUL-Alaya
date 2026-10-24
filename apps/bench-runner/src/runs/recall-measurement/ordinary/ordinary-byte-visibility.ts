import { hydrateUtf8Chunk } from "@do-soul/alaya-core";
import { canonicalJson, sourceGoldRootIdentity } from "@do-soul/alaya-protocol";
import {
  consumerVisibilityUnavailableReason, scoreConsumerByteVisibility, scoreConsumerMessageVisibility,
  type ConsumerVisibilityInput, type ConsumerVisibilityInterval
} from "../../longmemeval-semantic/message-visibility.js";

export type OrdinaryLiteralWindow = ConsumerVisibilityInterval & Readonly<{ text: string }>;
export const ORDINARY_VISIBILITY_BYTE_BUDGETS = [2048, 4096, 8192] as const;

/** Evaluation of the captured source-preview stream only, in occupied-slot order.
 * This does not repack a native page or read undisclosed source bytes. Framing,
 * memory payloads and metadata are not source bytes. Membership continuation is
 * not payload continuation and does not prove that an uncaptured tail is empty.
 */
export function scoreOrdinaryByteVisibility(input: ConsumerVisibilityInput & Readonly<{
  windows: readonly OrdinaryLiteralWindow[];
}>) {
  const slot = scoreConsumerMessageVisibility(input);
  const admitted = (input.pages ?? []).flatMap(page => page.status === "observed" ? page.intervals : []);
  const roots = input.windows.map(window => sourceGoldRootIdentity({
    ...window.target, kind: "source_evidence", evidence_object_id: null
  }));
  const invalid = input.unavailableReason ?? (canonicalJson(admitted) !== canonicalJson(input.windows.map(({ text: _text, ...interval }) => interval))
    || new Set(roots).size !== roots.length || input.windows.some((window, index) =>
      window.rank <= (input.windows[index - 1]?.rank ?? 0) || window.end - window.start !== Buffer.byteLength(window.text)
      || Buffer.from(window.text).toString("utf8") !== window.text)
    ? "ordinary_literal_windows_not_bound" : null);
  // The slot owner validates page structure and the captured ten-position/terminal
  // prefix. Structural failure must not turn literal text into positive evidence.
  const unavailable = invalid ?? consumerVisibilityUnavailableReason(input)
    ?? (slot.observation.observed_pages === 0 ? "ordinary_captured_stream_unobserved" : null);
  const complete = slot.observation.observed_through !== null && (slot.observation.observed_through >= 10
    || input.pages?.at(-1)?.terminal_tail.status === "exhausted")
    && input.pages?.every(page => page.status === "observed" && page.complete) === true;
  const total = input.windows.reduce((sum, window) => sum + Buffer.byteLength(window.text), 0);
  const score = (budget: number) => {
    const windows = prefix(input.windows, budget);
    const bytes = windows.reduce((sum, window) => sum + Buffer.byteLength(window.text), 0);
    const result = scoreConsumerByteVisibility({ gold: input.gold, windows, byte_budget: budget,
      unique_utf8_bytes: bytes, ...(unavailable === null ? {} : { unavailableReason: unavailable }) });
    // A positive needs only its admitted bytes; absence beyond an open captured
    // prefix remains unknown. This is not a claim about the unobserved library.
    const uncertain = !complete && budget > total;
    const retain = (metric: typeof result.any_at_budget) => uncertain && metric.status === "miss"
      ? { status: "unknown" as const, reason: "ordinary_captured_stream_incomplete" } : metric;
    return { byte_budget: budget, source_utf8_bytes: bytes,
      any_at_budget: retain(result.any_at_budget), all_at_budget: retain(result.all_at_budget) };
  };
  const threshold = (metric: "any_at_budget" | "all_at_budget") => {
    const full = score(total)[metric];
    if (full.status !== "hit") return { status: full.status === "unknown" || !complete ? "unknown" as const : "not_visible" as const,
      bytes: null, reason: full.reason ?? (!complete ? "ordinary_captured_stream_incomplete" : "not_visible_in_captured_stream") };
    // A mapped positive bounds the first hit from above, but an unmapped answer
    // turn may occur earlier. Preserve budget hits without inventing an exact minimum.
    if (!input.gold?.complete) return { status: "unknown" as const, bytes: null, reason: "answer_turn_mapping_incomplete" };
    let low = 0, high = total;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (score(middle)[metric].status === "hit") high = middle; else low = middle + 1;
    }
    return { status: "visible" as const, bytes: low, reason: null };
  };
  return { contract: "ordinary-captured-source-byte-visibility-v1" as const,
    basis: "ordered_admitted_source_previews_not_wire_bytes" as const,
    captured_source_utf8_bytes: unavailable === null ? total : null,
    captured_stream_complete: unavailable === null ? complete : null,
    budgets: ORDINARY_VISIBILITY_BYTE_BUDGETS.map(score),
    first_hit_byte: threshold("any_at_budget"), last_hit_byte: threshold("all_at_budget") };
}

/** A stream prefix stops at the first clipped unit, including a codepoint that
 * cannot fit. It never spends UTF-8 slack on a later unit, so increasing B cannot
 * remove already visible bytes. Native order, extents and occupied ranks survive.
 */
function prefix(windows: readonly OrdinaryLiteralWindow[], budget: number): OrdinaryLiteralWindow[] {
  const result: OrdinaryLiteralWindow[] = [];
  let remaining = budget;
  for (const window of windows) {
    const size = Buffer.byteLength(window.text);
    if (size <= remaining) { result.push(window); remaining -= size; continue; }
    const chunk = hydrateUtf8Chunk(window.text, { byteLimit: remaining });
    if (chunk.status === "chunk" && chunk.end_offset > 0) result.push({ ...window,
      text: chunk.text, end: window.start + chunk.end_offset });
    break;
  }
  return result;
}
