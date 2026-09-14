import {
  isRecallReadWorkerOperation,
  type RecallReadWorkerRequest
} from "./protocol.js";
import {
  BoundedRequestSchema,
  parseWorkerOperationPayload,
  parseWorkerOperationResult,
  type WorkerOperationPayload,
  type WorkerOperationPayloadMap
} from "./operation-schemas.js";
import { createBoundedActiveConstraintsReader, runWorkerActiveConstraints } from "./active-constraints.js";
import { runMemoryOperation } from "./memory-operations.js";
import { runEvidenceOperation } from "./evidence-operations.js";
import { runSynthesisOperation } from "./synthesis-operations.js";
import { runPathOperation } from "./path-operations.js";
import { runConditionalFieldWorkerRecall } from "./observer-operations.js";
import type { RecallReadWorkerRuntime } from "./runtime.js";
import { settleWorkerDelivery } from "./prepared-delivery.js";

const boundedConstraintsReaders = new WeakMap<RecallReadWorkerRuntime, ReturnType<typeof createBoundedActiveConstraintsReader>>();

type DispatchParsedOperation = Exclude<
  RecallReadWorkerRequest["operation"],
  | "constraints.readBounded"
  | "conditionalField.recall"
  | "conditionalField.acknowledge"
  | "conditionalField.discard"
>;

export async function runOperation(
  runtime: RecallReadWorkerRuntime,
  request: RecallReadWorkerRequest
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
  const parsedPayload = parseWorkerOperationPayload(request.operation, request.payload);
  if (request.operation === "conditionalField.recall") {
    return parseWorkerOperationResult(
      request.operation,
      runConditionalFieldWorkerRecall(
        runtime,
        parsedPayload as WorkerOperationPayload<"conditionalField.recall">
      )
    );
  }
  if (request.operation === "conditionalField.acknowledge") {
    return parseWorkerOperationResult(
      request.operation,
      settleWorkerDelivery(
        runtime,
        parsedPayload as WorkerOperationPayload<"conditionalField.acknowledge">,
        false
      )
    );
  }
  if (request.operation === "conditionalField.discard") {
    return parseWorkerOperationResult(
      request.operation,
      settleWorkerDelivery(
        runtime,
        parsedPayload as WorkerOperationPayload<"conditionalField.discard">,
        true
      )
    );
  }
  return parseWorkerOperationResult(
    request.operation,
    await dispatchParsed(
      runtime,
      request.operation,
      parsedPayload as WorkerOperationPayloadMap[DispatchParsedOperation]
    )
  );
}

async function dispatchParsed(
  runtime: RecallReadWorkerRuntime,
  operation: DispatchParsedOperation,
  payload: WorkerOperationPayloadMap[DispatchParsedOperation]
): Promise<unknown> {
  switch (operation) {
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
      return await runMemoryOperation(
        runtime,
        operation,
        payload as WorkerOperationPayloadMap[Extract<DispatchParsedOperation, `memory.${string}`>]
      );
    case "evidence.searchByKeyword":
    case "evidence.searchByKeywordField":
    case "evidence.searchManyByKeywordField":
    case "evidence.findByIds":
    case "evidence.findRecallQualifiedByIds":
    case "evidence.findRecallQualifiedFactKeysByIds":
    case "evidence.findSourceAnchorsByIds":
      return await runEvidenceOperation(
        runtime,
        operation,
        payload as WorkerOperationPayloadMap[Extract<DispatchParsedOperation, `evidence.${string}`>]
      );
    case "synthesis.searchByKeyword":
    case "synthesis.searchByKeywordField":
    case "synthesis.searchManyByKeywordField":
    case "synthesis.findByIds":
      return await runSynthesisOperation(
        runtime,
        operation,
        payload as WorkerOperationPayloadMap[Extract<DispatchParsedOperation, `synthesis.${string}`>]
      );
    case "path.findByAnchors":
    case "path.findByTimeConcernWindowDigests":
    case "pathPlasticity.getStrengthByMemoryId":
      return await runPathOperation(
        runtime,
        operation,
        payload as WorkerOperationPayloadMap[
          Extract<DispatchParsedOperation, `path${string}` | "pathPlasticity.getStrengthByMemoryId">
        ]
      );
    case "constraints.findActive":
      return await runWorkerActiveConstraints({
        payload: payload as WorkerOperationPayload<"constraints.findActive">,
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
    default:
      throwUnknownRecallReadWorkerOperation(operation);
  }
}

function throwUnknownRecallReadWorkerOperation(operation: unknown): never {
  throw new Error(`unknown recall read worker operation: ${String(operation)}`);
}
