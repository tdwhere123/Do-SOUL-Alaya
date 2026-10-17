/** Authored serializer fault inside the real compiled worker, before its native protocol listener. */
import "../../support/strict-provider-free-cli-bootstrap.mjs";
import { SourceSemanticReadBudget } from "../../../../../core-daemon/dist/runtime/field/source-semantic-read-stores.js";
const canonicalLength = SourceSemanticReadBudget.prototype.canonicalJsonLength;
SourceSemanticReadBudget.prototype.canonicalJsonLength = function (value, planner) {
  if (value?.kind === "research_qualified_selection" && value.status === "failed") {
    this.charge(this.work + 1, 0, "authored qualified failure wire exhaustion");
  }
  return canonicalLength.call(this, value, planner);
};
await import("../../../../../core-daemon/dist/runtime/recall/recall-read-worker.js");
