import "../../support/provider-free-cli.mjs";
import { parentPort } from "node:worker_threads";
import { recallExecutionRetention, CoreError } from "@do-soul/alaya-core";
// The shipped singleton and capacity policy remain unchanged. Synthetic accounted
// pressure avoids allocating 64 MiB merely to test real Worker -> parent revocation.
parentPort.on("message", message => {
  if (message.operation !== "fixture.retention") return;
  const before = recallExecutionRetention.snapshot();
  if (message.fill) {
    const execution = "pressure", key = "field:pressure";
    const row = bytes => ({ execution, workspace: message.workspace, bytes, handles: [], value: {} });
    const rollback = new Error("rollback pressure probe");
    let lo = 0, hi = 64 * 1024 * 1024, best = 0;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      let fits = true;
      try {
        recallExecutionRetention.transaction(() => {
          recallExecutionRetention.set(key, row(mid));
          fits = recallExecutionRetention.executionFor(message.protect) !== undefined;
          throw rollback;
        });
      } catch (error) {
        if (error instanceof CoreError && error.details?.resource === "execution_retention") fits = false;
        else if (error !== rollback) throw error;
      }
      if (fits) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    recallExecutionRetention.set(key, row(best));
  }
  parentPort.postMessage({ kind: "fixture.retention", before, after: recallExecutionRetention.snapshot(),
    protected: message.protect === undefined ? undefined : recallExecutionRetention.executionFor(message.protect) });
});
await import("../../../../dist/runtime/recall/recall-read-worker.js");
