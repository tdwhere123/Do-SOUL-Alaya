import {
  isRecallReadWorkerOperation,
  type RecallReadWorkerRequest
} from "./protocol.js";
import {
  BoundedRequestSchema,
  parseWorkerOperation,
  parseWorkerOperationResult,
  type ParsedWorkerOperation
} from "./operation-schemas.js";
import { createBoundedActiveConstraintsReader, runWorkerActiveConstraints } from "./active-constraints.js";
import { runMemoryOperation } from "./memory-operations.js";
import { runEvidenceOperation } from "./evidence-operations.js";
import { runSynthesisOperation } from "./synthesis-operations.js";
import { runPathOperation } from "./path-operations.js";
import { runConditionalFieldWorkerRecall } from "./observer-operations.js";
import { runSourceSemanticWorker } from "./source-semantic-reasoning.js";
import type { RecallReadWorkerRuntime } from "./runtime.js";
import { settleWorkerDelivery } from "./prepared-delivery.js";

import type { SourceSemanticObserver } from "./source-semantic-observation.js";
import { readSourceIndexSnapshotFact } from "./source-index-measurement.js";
import { sourceSemanticRevision } from "./source-semantic-leases.js";

const boundedConstraintsReaders = new WeakMap<RecallReadWorkerRuntime, ReturnType<typeof createBoundedActiveConstraintsReader>>();

type DispatchParsedOperation = Exclude<
  RecallReadWorkerRequest["operation"],
  | "constraints.readBounded"
  | "conditionalField.recall"
  | "conditionalField.sourceSemantics"
  | "conditionalField.acknowledge"
  | "conditionalField.discard"
>;

export async function runOperation(
  runtime: RecallReadWorkerRuntime,
  request: RecallReadWorkerRequest,
  observer?: SourceSemanticObserver
): Promise<unknown> {
  if (!isRecallReadWorkerOperation(request.operation)) {
    throwUnknownRecallReadWorkerOperation(request.operation);
  }
  if (runtime.closed && request.operation !== "close") {
    throw new Error("recall read worker database is closed");
  }
  if (request.operation === "constraints.readBounded") {
    const parsed = BoundedRequestSchema.parse(request.payload ?? {});
    let reader = boundedConstraintsReaders.get(runtime);
    if (reader === undefined) {
      reader = createBoundedActiveConstraintsReader(runtime.database);
      boundedConstraintsReaders.set(runtime, reader);
    }
    return parseWorkerOperationResult(request.operation, reader(parsed));
  }
  const parsed = parseWorkerOperation(request.operation, request.payload);
  if (parsed.operation === "conditionalField.sourceSemantics") {
    // Source operation finalizers own result admission; do not deep-copy their admitted envelopes again.
    return runSourceSemanticWorker(runtime, parsed.payload, observer);
  }
  if (parsed.operation === "conditionalField.recall") {
    const { payload } = parsed;
    const context = { operation: "recall", workspace_id: payload.workspace_id, as_of: payload.as_of,
      preparation: payload.prepared_query === undefined ? null
        : { status: payload.prepared_query.receipt.status, reason: payload.prepared_query.receipt.reason } };
    observer?.context(runtime, () => ({ ...context, snapshot_revision: null, index: null }));
    try {
      return parseWorkerOperationResult(parsed.operation,
        runConditionalFieldWorkerRecall(runtime, payload, observer === undefined ? {} : { observer }));
    } finally {
      // Observe the already pinned snapshot only after the native operation has read it.
      if (runtime.database.connection.inTransaction) observer?.context(runtime, () => ({ ...context,
        snapshot_revision: sourceSemanticRevision(runtime), index: readSourceIndexSnapshotFact(runtime.database, payload.workspace_id) }));
    }
  }
  if (parsed.operation === "conditionalField.acknowledge") {
    const { payload } = parsed;
    const receipt = settleWorkerDelivery(runtime, payload, false);
    // Settlement owns the final receipt. Preserve it separately through the bounded
    // diagnostic channel: preparation totals and the fitted public bytes stay intact.
    observer?.event("delivery_settlement", "delivery", () => ({
      preparation_id: payload.preparation_id, execution_receipt: receipt
    }));
    return parseWorkerOperationResult(parsed.operation, receipt);
  }
  if (parsed.operation === "conditionalField.discard") {
    return parseWorkerOperationResult(
      parsed.operation,
      settleWorkerDelivery(runtime, parsed.payload, true)
    );
  }
  return parseWorkerOperationResult(parsed.operation, await dispatchParsed(runtime, parsed));
}

async function dispatchParsed(
  runtime: RecallReadWorkerRuntime,
  parsed: ParsedWorkerOperation<DispatchParsedOperation>
): Promise<unknown> {
  switch (parsed.operation) {
    case "ready":
      return null;
    case "memory.findRecallTierWindow":
    case "memory.findByWorkspaceId":
    case "memory.findByEventTimeWindow":
    case "memory.findByDimension":
    case "memory.findByScopeClass":
    case "memory.searchByKeyword":
    case "memory.searchByKeywordField":
    case "memory.searchByKeywordWithinObjectIds":
    case "memory.searchByKeywordWithinTier":
    case "memory.searchManyByKeywordWithinObjectIds":
    case "memory.searchByAnchorWithinObjectIds":
    case "memory.searchByAnchorWithinTier":
    case "memory.searchByAnchorField":
    case "memory.findByEvidenceRefs":
    case "memory.findBoundEvidenceRefs":
    case "memory.findByIds":
      return await runMemoryOperation(runtime, parsed);
    case "evidence.searchByKeyword":
    case "evidence.searchByKeywordField":
    case "evidence.searchManyByKeywordField":
    case "evidence.findByIds":
    case "evidence.findRecallQualifiedByIds":
    case "evidence.findRecallQualifiedFactKeysByIds":
    case "evidence.findSourceAnchorsByIds":
      return await runEvidenceOperation(runtime, parsed);
    case "synthesis.searchByKeyword":
    case "synthesis.searchByKeywordField":
    case "synthesis.searchManyByKeywordField":
    case "synthesis.findByIds":
      return await runSynthesisOperation(runtime, parsed);
    case "path.findByAnchors":
    case "path.findByTimeConcernWindowDigests":
    case "pathPlasticity.getStrengthByMemoryId":
      return await runPathOperation(runtime, parsed);
    case "constraints.findActive":
      return await runWorkerActiveConstraints({
        payload: parsed.payload,
        memoryRepo: runtime.memoryEntryRepo,
        claimFormRepo: runtime.claimFormRepo,
        pathReadPorts: runtime.recallPathReadPorts
      });
    case "snapshot.beginDeferred":
      runtime.database.connection.exec("BEGIN DEFERRED");
      return null;
    case "snapshot.commit":
      if (runtime.database.connection.inTransaction) {
        runtime.database.connection.exec("COMMIT");
      }
      return null;
    case "snapshot.rollback":
      if (runtime.database.connection.inTransaction) {
        runtime.database.connection.exec("ROLLBACK");
      }
      return null;
    case "close":
      runtime.database.close();
      runtime.closed = true;
      return null;
    default: {
      const unreachable: never = parsed;
      throwUnknownRecallReadWorkerOperation(unreachable);
    }
  }
}

function throwUnknownRecallReadWorkerOperation(operation: unknown): never {
  throw new Error(`unknown recall read worker operation: ${String(operation)}`);
}
