import {
  isRecallReadWorkerOperation,
  type RecallReadWorkerRequest
} from "./protocol.js";
import { asPayload } from "./payload-readers.js";
import { runWorkerActiveConstraints } from "./active-constraints.js";
import { runMemoryOperation } from "./memory-operations.js";
import { runEvidenceOperation } from "./evidence-operations.js";
import { runSynthesisOperation } from "./synthesis-operations.js";
import { runPathOperation } from "./path-operations.js";
import type { RecallReadWorkerRuntime } from "./runtime.js";

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
  const payload = asPayload(request.payload);
  switch (request.operation) {
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
      return await runMemoryOperation(runtime, request.operation, payload);
    case "evidence.searchByKeyword":
    case "evidence.searchByKeywordField":
    case "evidence.searchManyByKeywordField":
    case "evidence.findByIds":
    case "evidence.findRecallQualifiedByIds":
    case "evidence.findRecallQualifiedFactKeysByIds":
    case "evidence.findSourceAnchorsByIds":
      return await runEvidenceOperation(runtime, request.operation, payload);
    case "synthesis.searchByKeyword":
    case "synthesis.searchByKeywordField":
    case "synthesis.searchManyByKeywordField":
    case "synthesis.findByIds":
      return await runSynthesisOperation(runtime, request.operation, payload);
    case "path.findByAnchors":
    case "path.findByTimeConcernWindowDigests":
    case "pathPlasticity.getStrengthByMemoryId":
      return await runPathOperation(runtime, request.operation, payload);
    case "constraints.findActive":
      return await runWorkerActiveConstraints({
        payload,
        memoryRepo: runtime.memoryEntryRepo,
        claimFormRepo: runtime.claimFormRepo,
        pathReadPorts: runtime.recallPathReadPorts
      });
    case "close":
      runtime.database.close();
      runtime.closed = true;
      return null;
    default:
      throwUnknownRecallReadWorkerOperation(request.operation);
  }
}

function throwUnknownRecallReadWorkerOperation(operation: unknown): never {
  throw new Error(`unknown recall read worker operation: ${String(operation)}`);
}
