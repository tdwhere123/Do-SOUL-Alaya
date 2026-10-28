// Replay the actual pre-commit page attempts through the production fit owner.
import { isDeepStrictEqual } from "node:util";
import { SourceSemanticResourceLedger } from "@do-soul/alaya-protocol";
import { fitProjectedRecallPage } from "../../../packages/core/dist/recall/runtime/recall-page-fit.js";
import { ordinaryEntryStopCause } from "../dist/runs/recall-measurement/ordinary/ordinary-entry-policy.js";
import { withRecallSnapshot } from "./recall-bound-snapshot.mjs";

const rootId = target => target?.kind === "source_evidence" ? target.root_id : null;

/** This order is the observed field order, not a reconstruction from delivered answers. */
export function observedAccessOrder(capture) {
  const order = capture.access_orders?.find(row => row.status === "ordered" && !row.truncated);
  if (!order || order.total !== order.entries.length) throw new Error("complete field access order unavailable");
  const entries = order.entries.filter(entry => rootId(entry.target) !== null);
  if (entries.some(entry => !Number.isSafeInteger(entry.access_ordinal))) throw new Error("source access ordinal unavailable");
  const sorted = [...entries].sort((a, b) => a.access_ordinal - b.access_ordinal);
  const seen = new Set(), result = [];
  for (const entry of sorted) {
    const id = rootId(entry.target);
    if (!seen.has(id)) { seen.add(id); result.push(id); }
  }
  return result;
}

function replayAttempt(attempt) {
  if (attempt.codec !== "default" || !Array.isArray(attempt.previews) || !attempt.metadata || !attempt.index
    || !attempt.request || !attempt.outcome || !attempt.allowance) throw new Error("native page fit inputs unavailable");
  const { work_units, memory_bytes } = attempt.allowance;
  if (![work_units, memory_bytes].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error("native page fit allowance unavailable");
  }
  const previews = new Map(attempt.previews);
  if (previews.size !== attempt.previews.length) throw new Error("ambiguous native page preview keys");
  const fit = fitProjectedRecallPage({ index: attempt.index, previews, metadata: attempt.metadata,
    request: attempt.request, request_digest: attempt.request_digest,
    meter: new SourceSemanticResourceLedger({ work_units, memory_bytes }) });
  const outcome = { fits: fit.fits, bytes: fit.bytes, result_count: fit.result_count,
    interruption: fit.interruption ?? null, observation: fit.observation };
  if (!isDeepStrictEqual(outcome, attempt.outcome)) throw new Error("native page fit replay differs from observed attempt");
  if (fit.interruption !== undefined) throw new Error(`native page fit interrupted: ${fit.interruption}`);
  return fit;
}

/** Native attempts witness one execution. Other orders and displays need their own projection. */
export function simulateRecallDelivery(row, order, display = {}) {
  const capture = row.pool_capture, pages = capture?.pages, frames = capture?.page_attempts;
  if (capture?.status !== "captured" || !Array.isArray(pages) || !Array.isArray(frames)
    || pages.length === 0 || frames.length !== pages.length) throw new Error("complete native page attempts unavailable");
  if (!Array.isArray(order) || new Set(order).size !== order.length) throw new Error("policy order must contain unique roots");
  if (!isDeepStrictEqual(order, observedAccessOrder(capture)) || Object.keys(display).length > 0) {
    throw new Error("counterfactual projection attempts were not observed");
  }
  return withRecallSnapshot(row, () => {
    const intervals = [];
    let occupied = 0, previous = null, stop = null;
    for (let pageIndex = 0; pageIndex < frames.length; pageIndex++) {
      const frame = frames[pageIndex], page = pages[pageIndex], metadata = capture.page_metadata?.[pageIndex];
      if (!Array.isArray(frame.attempts) || frame.attempts.length === 0 || frame.request_id !== metadata?.request_id
        || !isDeepStrictEqual(page.request?.continuation ?? null, previous)) throw new Error("native page attempt sequence unavailable");
      let fit;
      frame.attempts.forEach((attempt, attemptIndex) => {
        fit = replayAttempt(attempt);
        if (fit.fits !== (attemptIndex === frame.attempts.length - 1)) throw new Error("native page fit commit sequence unavailable");
      });
      if (!fit || fit.result_count !== fit.index.entries.length
        || !isDeepStrictEqual(fit.index.entries, metadata.entries.map(item => item.entry))
        || fit.result_count !== page.occupied_slots) throw new Error("native fitted membership is not bound to its page");
      fit.index.entries.forEach((entry, offset) => {
        if (rootId(entry.target) !== null) intervals.push({ slot_index: occupied + offset,
          target: entry.target, span: entry.target.span ?? null });
      });
      occupied += fit.result_count;
      previous = fit.index.continuation;
      stop = ordinaryEntryStopCause(fit.index, occupied, pageIndex + 1);
      if (pageIndex < frames.length - 1 && stop !== null) throw new Error("native page sequence continued after its stop");
    }
    if (!["observed_ten_slot_prefix", "occupancy_tail_exhausted"].includes(stop) || stop !== row.stop_cause) {
      throw new Error("native page sequence has no matching completed stop");
    }
    return { pages: frames.length, metadata_scope: "captured_native", intervals };
  });
}
