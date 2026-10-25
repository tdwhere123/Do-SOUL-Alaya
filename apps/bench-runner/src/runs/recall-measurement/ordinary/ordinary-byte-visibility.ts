import {
  consumerVisibilityUnavailableReason, scoreConsumerByteVisibility, scoreConsumerMessageVisibility,
  type ConsumerVisibilityInput
} from "../../longmemeval-semantic/message-visibility.js";
import { ordinaryLiteralWindows, ordinaryUnmappedSources, ordinaryPreviewStreamIssue, prefixOrdinaryBodyPreviews,
  ordinaryBodyStreamUnavailableReason,
  type OrdinarySourcePreview } from "./ordinary-preview-stream.js";

export const ORDINARY_VISIBILITY_BYTE_BUDGETS = [2048, 4096, 8192] as const;

/** B is literal source-body delivery, not serialized-response/display bytes.
 * A spanless display leaves cumulative body cost/alignment unknown; filtering it
 * out cannot establish an exact complete stream. Slot/root evidence is independent. */
export function scoreOrdinaryByteVisibility(input: ConsumerVisibilityInput & Readonly<{
  previews: readonly OrdinarySourcePreview[];
}>) {
  const slot = scoreConsumerMessageVisibility(input);
  const admissionIssue = input.unavailableReason ?? ordinaryPreviewStreamIssue(input.previews, input.pages)
    ?? consumerVisibilityUnavailableReason(input)
    ?? (slot.observation.observed_pages === 0 ? "ordinary_captured_stream_unobserved" : null);
  const previews = input.previews ?? [], literal = ordinaryLiteralWindows(previews);
  const unavailable = admissionIssue ?? ordinaryBodyStreamUnavailableReason(previews);
  const complete = slot.observation.observed_through !== null && (slot.observation.observed_through >= 10
    || input.pages?.at(-1)?.terminal_tail.status === "exhausted")
    && input.pages?.every(page => page.status === "observed" && page.complete) === true;
  const total = literal.reduce((sum, window) => sum + Buffer.byteLength(window.text), 0);
  const score = (budget: number) => {
    const packed = unavailable === null ? prefixOrdinaryBodyPreviews(previews, budget) : [];
    const windows = ordinaryLiteralWindows(packed);
    const bytes = windows.reduce((sum, window) => sum + Buffer.byteLength(window.text), 0);
    const result = scoreConsumerByteVisibility({ gold: input.gold, windows, byte_budget: budget,
      unique_utf8_bytes: bytes, unmapped_sources: ordinaryUnmappedSources(packed),
      ...(unavailable === null ? {} : { unavailableReason: unavailable }) });
    const uncertain = !complete && budget > total;
    const retain = (metric: typeof result.any_at_budget) => uncertain && metric.status === "miss"
      ? { status: "unknown" as const, reason: "ordinary_captured_stream_incomplete" } : metric;
    return { byte_budget: budget, source_utf8_bytes: unavailable === null ? bytes : null,
      any_at_budget: retain(result.any_at_budget), all_at_budget: retain(result.all_at_budget) };
  };
  const threshold = (metric: "any_at_budget" | "all_at_budget") => {
    const full = score(total)[metric];
    if (full.status !== "hit") return { status: full.status === "unknown" || !complete ? "unknown" as const : "not_visible" as const,
      bytes: null, reason: full.reason ?? (!complete ? "ordinary_captured_stream_incomplete" : "not_visible_in_captured_stream") };
    if (!input.gold?.complete) return { status: "unknown" as const, bytes: null, reason: "answer_turn_mapping_incomplete" };
    let low = 0, high = total;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (score(middle)[metric].status === "hit") high = middle; else low = middle + 1;
    }
    return { status: "visible" as const, bytes: low, reason: null };
  };
  return { contract: "ordinary-captured-source-byte-visibility-v2" as const,
    basis: "ordered_literal_source_body_bytes_not_display_or_wire_bytes" as const,
    captured_source_utf8_bytes: unavailable === null ? total : null,
    admitted_source_utf8_bytes: admissionIssue === null ? total : null,
    observed_display_utf8_bytes: admissionIssue === null ? previews.reduce((sum, preview) => sum + Buffer.byteLength(preview.text), 0) : null,
    body_stream_mapping: { status: unavailable === null ? "mapped" as const : "unavailable" as const, reason: unavailable },
    captured_stream_complete: unavailable === null ? complete : null,
    budgets: ORDINARY_VISIBILITY_BYTE_BUDGETS.map(score),
    first_hit_byte: threshold("any_at_budget"), last_hit_byte: threshold("all_at_budget") };
}
