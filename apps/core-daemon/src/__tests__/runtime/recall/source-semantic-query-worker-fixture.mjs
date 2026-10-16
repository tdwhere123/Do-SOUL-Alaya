import "../../../../../bench-runner/src/__tests__/support/provider-free-cli-bootstrap.mjs";
import { appendFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { sourceSemanticExecution, sourceSemanticAcquisitionNotRun } from "../../../../../../packages/protocol/dist/garden/source-semantic-access.js";
import { parentPort, threadId, workerData } from "node:worker_threads";

if (workerData.databaseFilename.endsWith(".capture")) {
  // Synthetic replies establish capture/deadline/transport behavior only, not native recall evidence.
  parentPort.on("message", async ({ id, operation, payload }) => {
    if (operation !== "conditionalField.sourceSemantics") {
      parentPort.postMessage({ id, ok: true, result: null });
      return;
    }
    if (payload.request.kind !== "prepare_query") {
      parentPort.postMessage({ id, ok: false, error: { name: "Error", message: "fixture captured non-preparation payload" } });
      return;
    }
    if (payload.request.access_hint === "fixture-hold") {
      const gate = `${workerData.databaseFilename}.release`;
      while (!existsSync(gate)) await new Promise(resolve => setImmediate(resolve));
    } else if (payload.request.access_hint?.startsWith("fixture-delay:")) {
      await new Promise(resolve => setTimeout(resolve, Number(payload.request.access_hint.split(":")[1])));
    }
    const execution = sourceSemanticExecution(payload.prepared_query?.receipt,
      sourceSemanticAcquisitionNotRun("fixture_does_not_acquire"));
    parentPort.postMessage({ id, ok: true, result: {
      kind: "prepare_query", query_handle: `query-capture-${threadId}-${id}`,
      query_semantics_status: { status: "unavailable", reason: "absent" }, candidates: [], truncated: false,
      execution,
      coverage: { discovery: "unexercised", source_interpretation: "unexercised", query_semantics: "unexercised",
        semantic_correspondence: "unexercised", conditional_computation: "unexercised", payload: "complete" },
      work: { native_work: 0, native_bytes: 0, logical_memory_bytes: 0, rss_bytes: 0 }
    } });
  });
} else {
  // Observe the built worker's real SQLite statements without replacing its transaction or dispatch owner.
  const storageRequire = createRequire(new URL("../../../../../../packages/storage/dist/sqlite/open-sqlite-connection.js", import.meta.url));
  const Database = storageRequire("better-sqlite3");
  // The native transaction controller bypasses Database.prepare. Its statements
  // share this prototype, including COMMIT/ROLLBACK and readiness PRAGMAs.
  const probe = new Database(":memory:");
  const statementPrototype = Object.getPrototypeOf(probe.prepare("SELECT 1"));
  probe.close();
  for (const name of ["run", "get", "all"]) {
    const method = statementPrototype[name];
    statementPrototype[name] = function (...parameters) {
      try { return method.apply(this, parameters); }
      finally { appendFileSync(`${workerData.databaseFilename}.query-sql`,
        `${JSON.stringify({ sql: this.source, in_transaction: this.database.inTransaction })}\n`, "utf8"); }
    };
  };
  const exec = Database.prototype.exec;
  Database.prototype.exec = function (sql, ...args) {
    try { return exec.call(this, sql, ...args); }
    finally { appendFileSync(`${workerData.databaseFilename}.query-sql`,
      `${JSON.stringify({ sql, in_transaction: this.inTransaction })}\n`, "utf8"); }
  };
  await import("../../../../dist/runtime/recall/recall-read-worker.js");
}
