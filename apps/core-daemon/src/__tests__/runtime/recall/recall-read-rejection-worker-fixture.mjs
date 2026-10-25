// Install credential and transport guards before importing application modules.
import { installProviderFreeBoundary } from "../../../../../bench-runner/src/__tests__/support/provider-free-boundary.ts";
const isolation = installProviderFreeBoundary();
globalThis.fetch = () => { throw new Error("provider transport forbidden in worker rejection fixture"); };
const { parentPort, workerData } = await import("node:worker_threads");
const { default: Database } = await import("better-sqlite3");
const { CoreError } = await import("@do-soul/alaya-core");
const { serializeWorkerError } = await import("../../../../dist/runtime/recall-read-worker/protocol-validation.js");
const { attachMeasuredWorkerCost, withWorkerActualCost } = await import("../../../../dist/runtime/recall/worker-actual-cost.js");
const database = new Database(workerData.databaseFilename);

// Authored failures, not a natural-corpus reproduction. Serialization and IPC
// are production boundaries; snapshot rollback uses an actual SQLite connection.
parentPort.on("message", ({ id, operation, payload }) => {
  try {
    let result = null;
    if (operation === "snapshot.beginDeferred") database.exec("BEGIN DEFERRED");
    if (operation === "snapshot.rollback") database.exec("ROLLBACK");
    if (operation === "memory.findByWorkspaceId") result = [];
    if (operation === "conditionalField.recall") {
      const details = payload.kind === "absent" ? undefined
        : { owner: { label: "private-owner-evidence", token: "fixture-sensitive-token" },
          ...(payload.kind === "large" ? { large: "x".repeat(100_000) } : {}),
          ...(payload.kind === "unserializable" ? { value: 1n } : {}),
          ...(payload.kind === "shared" ? { shared: new SharedArrayBuffer(4) } : {}) };
      if (payload.kind === "circular") details.self = details;
      const error = payload.kind === "core"
        ? new CoreError("CONFLICT", "private worker refusal", { subCode: "CONCURRENT_MODIFICATION", details })
        : Object.assign(new TypeError("private worker refusal"), details === undefined ? {} : { details });
      if (payload.kind === "long-text") error.message = "private text ".repeat(10_000);
      if (payload.kind !== "absent") {
        // Sample the existing measurement owner rather than inventing a cost.
        const measured = withWorkerActualCost({}, () => ({ execution_receipt: {} }));
        attachMeasuredWorkerCost(error, measured.execution_receipt.worker);
      }
      throw error;
    }
    if (isolation.violations.length !== 0) throw new Error("worker provider-free boundary violation");
    parentPort.postMessage({ id, ok: true, result });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: serializeWorkerError(error) });
  }
});
