import "../../../../../bench-runner/src/__tests__/support/provider-free-cli-bootstrap.mjs";
import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
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
    if (payload.request.access_hint?.startsWith("fixture-delay:")) {
      await new Promise(resolve => setTimeout(resolve, Number(payload.request.access_hint.split(":")[1])));
    }
    const execution = {
      contract: "source-semantic-execution-v2",
      query_preparation: payload.prepared_query?.receipt ?? {
        status: "not_requested", reason: "operation_does_not_prepare", navigation_digest: null, selected: null,
        method: "not_run", submitted_inputs: 0, token_count: null, external_api_attempts: 0,
        binding_work: "not_run", execution_work: "not_run", elapsed_ms: 0
      },
      acquisition: { policy: "source-index-interleaved-prefix.v1", status: "not_run", reason: "fixture_does_not_acquire",
        allowance: { max_attempts: 0, max_roots: 0, max_vector_windows: 0 },
        budget: { work_units: 0, memory_bytes: 0 }, result: null, accounting: "not_run" },
      semantic_generation_attempts: 0
    };
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
