import "../../support/provider-free-cli.mjs";
import { appendFileSync } from "node:fs";
import { parentPort, threadId, workerData } from "node:worker_threads";
import Database from "better-sqlite3";

// Transport fixture only: response contents/delays are synthetic; the exclusive
// lock wait below is real synchronous native SQLite, not a CPU-loop simulation.
const database = new Database(workerData.databaseFilename, { readonly: true, timeout: 5000 });
const record = (event) => appendFileSync(`${workerData.databaseFilename}.events`,
  `${JSON.stringify({ threadId, ...event })}\n`, "utf8");
record({ kind: "spawn" });
const heldResponses = new Map();
parentPort.on("message", async ({ id, operation, payload }) => {
  if (operation === "fixture.releaseResponse") {
    heldResponses.get(id)?.();
    heldResponses.delete(id);
    return;
  }
  record({ kind: "dispatch", id, operation, payload });
  if (payload.workspaceId === "native-lock" || payload.workspaceId === "native-lock-until-release") {
    // The caller-scope test releases its real SQLite lock explicitly. Do not make
    // retained occupancy depend on beating the ordinary five-second busy timeout.
    if (payload.workspaceId === "native-lock-until-release") database.pragma("busy_timeout = 2147483647");
    record({ kind: "sql-enter", id });
    database.prepare("SELECT value FROM transport_probe").all();
    record({ kind: "sql-return", id });
  }
  if (payload.workspaceId?.startsWith("delay:")) {
    await new Promise(resolve => setTimeout(resolve, Number(payload.workspaceId.split(":")[1])));
  }
  if (payload.workspaceId === "held-response") {
    await new Promise(resolve => {
      heldResponses.set(id, resolve);
      record({ kind: "response-held", id });
    });
  }
  parentPort.postMessage({ id, ok: true, result: operation.startsWith("memory.") ? [] : null });
  record({ kind: "response", id });
});
