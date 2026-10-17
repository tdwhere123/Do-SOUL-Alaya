// Also explicit here for direct fixture execution; --import installs this before the module graph.
import "../../../../../bench-runner/src/__tests__/support/provider-free-cli-bootstrap.mjs";
import { parentPort, workerData } from "node:worker_threads";
import { deepStrictEqual, notStrictEqual, throws } from "node:assert/strict";
import { admitSourceSemanticQuery, authorizedScopesFromAdmission, encodeSourceSemanticLibraryResponse }
  from "../../../../../../packages/core/dist/index.js";
import { sourceSemanticExecution } from "../../../../../../packages/protocol/dist/index.js";
import { initDatabase, closeCachedDatabase } from "../../../../../../packages/storage/dist/index.js";
import { SourceSemanticReadBudget } from "../../../../dist/runtime/field/source-semantic-read-stores.js";
import { compareResearchNominatedSourceLibrary } from "../../../../dist/runtime/recall-read-worker/source-semantic-research-nominated-library.js";
import { createRecallReadWorkerRuntime } from "../../../../dist/runtime/recall-read-worker/runtime.js";
import { observeSourceSemanticAccess } from "../../../../dist/runtime/recall-read-worker/source-semantic-candidate-access.js";
import { sourceSemanticRevision } from "../../../../dist/runtime/recall-read-worker/source-semantic-leases.js";
import { runSourceSemanticWorker } from "../../../../dist/runtime/recall-read-worker/source-semantic-reasoning.js";

const database = initDatabase({ filename: workerData.filename });
try {
  const { payload, costs } = workerData, request = payload.request;
  const foreignMeter = new SourceSemanticReadBudget(request.budget);
  foreignMeter.charge(costs.work, costs.bytes, "transported parent access costs");
  foreignMeter.nativeWork = costs.nativeWork; foreignMeter.nativeBytes = costs.nativeBytes; foreignMeter.indexWork = costs.indexWork;
  foreignMeter.preparation = costs.preparation; foreignMeter.acquisition = costs.acquisition;
  const runtime = createRecallReadWorkerRuntime(database);
  const authorized = authorizedScopesFromAdmission(payload.authorized_scopes).authorized_scopes;
  if (authorized === undefined || request.kind !== "recall" || request.original_query === undefined) {
    throw new Error("guarded comparison requires a direct recall with admitted scopes");
  }
  const admission = admitSourceSemanticQuery(request.query_semantics, request.original_query);
  const result = database.connection.transaction(() => {
    // SQLite mutation counters belong to a connection, not to the file sent by the parent.
    const revision = sourceSemanticRevision(runtime);
    notStrictEqual(revision, workerData.revision, "writer and fresh reader must have different mutation counters");
    throws(() => compareResearchNominatedSourceLibrary(database, payload, workerData.pool, foreignMeter), {
      code: "CONFLICT", message: "research access scope or source revision changed"
    }, "an unchanged file must not turn a copied parent pool into a worker snapshot");
    const before = runSourceSemanticWorker(runtime, payload);
    const meter = new SourceSemanticReadBudget(request.budget);
    const pool = observeSourceSemanticAccess(runtime, payload, authorized, meter, request.original_query,
      admission.kind === "admitted" ? admission.query : undefined, request.access_policy, request.budget);
    const { pool_id: parentId, ...parentReceipt } = workerData.pool.access;
    const { pool_id: workerId, ...workerReceipt } = pool.access;
    notStrictEqual(workerId, parentId, "the fresh native observation must bind its own connection revision");
    deepStrictEqual([pool.sources, pool.descriptors, pool.sourcePages, pool.interpretationPages, workerReceipt],
      [workerData.pool.sources, workerData.pool.descriptors, workerData.pool.sourcePages, workerData.pool.interpretationPages, parentReceipt],
      "the same native acquisition and observation must be preserved, apart from revision binding");
    const comparison = compareResearchNominatedSourceLibrary(database, payload, pool, meter);
    const after = runSourceSemanticWorker(runtime, payload);
    deepStrictEqual(sourceSemanticRevision(runtime), revision, "comparison must not mutate the captured snapshot");
    if (before.order.enumeration_policy !== "evidence_support" || after.order.enumeration_policy !== "evidence_support"
      || JSON.stringify(before.index.entries) !== JSON.stringify(after.index.entries)
      || JSON.stringify(before.previews) !== JSON.stringify(after.previews)) {
      throw new Error("private comparison changed ordinary O1 exposure");
    }
    const ordinary = encodeSourceSemanticLibraryResponse(before), prefix = comparison.hydration.prefix.artifact;
    deepStrictEqual(prefix.index.entries, ordinary.index.entries, "captured prefix must preserve ordinary O1 membership");
    const exposure = rows => rows.map(row => ({ target: row.target, preview: row.content_preview }));
    deepStrictEqual(exposure(prefix.results), exposure(ordinary.results), "captured prefix must preserve ordinary O1 bytes");
    const capturedExecution = sourceSemanticExecution(meter.preparation, meter.acquisition);
    deepStrictEqual(capturedExecution, sourceSemanticExecution(costs.preparation, costs.acquisition),
      "fresh capture must not discard the parent's preparation or acquisition evidence");
    for (const arm of [comparison.hydration.prefix, comparison.hydration.nominated, ...Object.values(comparison.ordering)]) {
      deepStrictEqual(arm.artifact.execution, capturedExecution, "every arm must retain the captured execution phases");
    }
    return comparison;
  })();
  parentPort.postMessage({ result });
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.stack : String(error) });
  process.exitCode = 1;
} finally {
  database.close(); closeCachedDatabase(workerData.filename);
}
