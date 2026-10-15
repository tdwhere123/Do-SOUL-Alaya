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
parentPort.on("message", async ({ id, operation, payload }) => {
  record({ kind: "dispatch", id, operation, payload });
  if (payload.workspaceId === "native-lock") {
    record({ kind: "sql-enter", id });
    database.prepare("SELECT value FROM transport_probe").all();
    record({ kind: "sql-return", id });
  }
  if (payload.workspaceId?.startsWith("delay:")) {
    await new Promise(resolve => setTimeout(resolve, Number(payload.workspaceId.split(":")[1])));
  }
  parentPort.postMessage({ id, ok: true, result: operation.startsWith("memory.") ? [] : null });
  record({ kind: "response", id });
});
