import "../../../../../bench-runner/src/__tests__/support/provider-free-cli-bootstrap.mjs";
import { SourceSemanticObserver } from "../../../../dist/runtime/recall-read-worker/source-semantic-observation.js";

// Inject a metadata-construction failure at an actual native decision boundary.
// Production dispatch, SQLite, resource owners and result admission are unchanged.
const event = SourceSemanticObserver.prototype.event;
SourceSemanticObserver.prototype.event = function (kind, phase, data) {
  return event.call(this, kind, phase, kind === "source_index_routes" ? () => {
    throw new Error("native observation metadata capture failed");
  } : data);
};
await import("../../../../dist/runtime/recall/recall-read-worker.js");
