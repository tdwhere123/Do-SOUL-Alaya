import "../../support/provider-free-cli.mjs";
import { parentPort, threadId } from "node:worker_threads";

// Fixture-only responses isolate caller capture/queue semantics. Positive source
// preparation, snapshots and domain errors use the built production worker instead.
parentPort.on("message", ({ id, operation, payload }) => {
  if (operation !== "conditionalField.sourceSemantics") {
    parentPort.postMessage({ id, ok: true, result: null });
    return;
  }
  if (payload.request.kind !== "prepare_query") {
    parentPort.postMessage({ id, ok: false, error: { name: "Error", message: "fixture captured non-preparation payload" } });
    return;
  }
  parentPort.postMessage({ id, ok: true, result: {
    kind: "prepare_query", query_handle: `capture-${threadId}-${id}`,
    query_semantics_status: { status: "unavailable", reason: "absent" },
    candidates: [], truncated: false,
    coverage: { discovery: "unexercised", source_interpretation: "unexercised", query_semantics: "unexercised",
      semantic_correspondence: "unexercised", conditional_computation: "unexercised", payload: "complete" },
    work: { native_work: 0, native_bytes: 0, logical_memory_bytes: 0, rss_bytes: 0 }
  } });
});
