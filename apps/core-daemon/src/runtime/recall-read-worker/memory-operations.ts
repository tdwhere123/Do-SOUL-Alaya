import type { RecallReadWorkerRequest } from "./protocol.js";
import type { WorkerOperationPayload, WorkerOperationPayloadMap } from "./operation-schemas.js";
import {
  findMemoryEntriesByWorkspaceId,
  readRecallTierWindowQuery
} from "./memory-window.js";
import { runMemoryFieldOperation } from "./field-operations.js";
import { runOrderedKeywordSearchBatch } from "./worker-readers.js";
import type { RecallReadWorkerRuntime } from "./runtime.js";

type MemoryOperation = Extract<RecallReadWorkerRequest["operation"], `memory.${string}`>;

export async function runMemoryOperation(
  runtime: RecallReadWorkerRuntime,
  operation: MemoryOperation,
  payload: WorkerOperationPayloadMap[MemoryOperation]
) {
  const { memoryEntryRepo } = runtime;
  switch (operation) {
    case "memory.searchByKeywordField":
    case "memory.searchByAnchorField":
      return await runMemoryFieldOperation(
        memoryEntryRepo,
        operation,
        payload as WorkerOperationPayloadMap[typeof operation]
      );
    case "memory.searchByKeyword":
    case "memory.searchByKeywordWithinObjectIds":
    case "memory.searchByKeywordWithinTier":
    case "memory.searchManyByKeywordWithinObjectIds":
    case "memory.searchByAnchorWithinObjectIds":
    case "memory.searchByAnchorWithinTier":
      return await runMemorySearchOperation(
        runtime,
        operation,
        payload as WorkerOperationPayloadMap[typeof operation]
      );
    case "memory.findRecallTierWindow": {
      const windowPayload = payload as WorkerOperationPayload<"memory.findRecallTierWindow">;
      return await memoryEntryRepo.findRecallTierWindow(
        readRecallTierWindowQuery(windowPayload)
      );
    }
    case "memory.findByWorkspaceId": {
      const listPayload = payload as WorkerOperationPayload<"memory.findByWorkspaceId">;
      return await findMemoryEntriesByWorkspaceId(
        memoryEntryRepo,
        listPayload.workspaceId,
        listPayload.tier,
        listPayload.page
      );
    }
    case "memory.findByEventTimeWindow": {
      const windowPayload = payload as WorkerOperationPayload<"memory.findByEventTimeWindow">;
      return await memoryEntryRepo.findByEventTimeWindow({
        workspaceId: windowPayload.workspaceId,
        tier: windowPayload.tier,
        startTime: windowPayload.startTime,
        endTime: windowPayload.endTime,
        limit: windowPayload.limit
      });
    }
    case "memory.findByDimension": {
      const dimensionPayload = payload as WorkerOperationPayload<"memory.findByDimension">;
      return await memoryEntryRepo.findByDimension(
        dimensionPayload.workspaceId,
        dimensionPayload.dimension
      );
    }
    case "memory.findByScopeClass": {
      const scopePayload = payload as WorkerOperationPayload<"memory.findByScopeClass">;
      return await memoryEntryRepo.findByScopeClass(
        scopePayload.workspaceId,
        scopePayload.scopeClass
      );
    }
    case "memory.findByEvidenceRefs": {
      const evidencePayload = payload as WorkerOperationPayload<"memory.findByEvidenceRefs">;
      return await memoryEntryRepo.findByEvidenceRefs(
        evidencePayload.workspaceId,
        evidencePayload.evidenceObjectIds
      );
    }
    case "memory.findBoundEvidenceRefs": {
      const boundPayload = payload as WorkerOperationPayload<"memory.findBoundEvidenceRefs">;
      return await memoryEntryRepo.findBoundEvidenceRefs(
        boundPayload.workspaceId,
        boundPayload.evidenceObjectIds
      );
    }
    case "memory.findByIds": {
      const idsPayload = payload as WorkerOperationPayload<"memory.findByIds">;
      return await memoryEntryRepo.findByIds(idsPayload.workspaceId, idsPayload.objectIds);
    }
  }
}

async function runMemorySearchOperation(
  runtime: RecallReadWorkerRuntime,
  operation: Extract<MemoryOperation, `memory.search${string}`>,
  payload: WorkerOperationPayloadMap[Extract<MemoryOperation, `memory.search${string}`>]
) {
  if (operation === "memory.searchManyByKeywordWithinObjectIds") {
    const batchPayload = payload as WorkerOperationPayload<"memory.searchManyByKeywordWithinObjectIds">;
    return runOrderedKeywordSearchBatch(batchPayload.queries, (query) =>
      runtime.memoryEntryRepo.searchByKeywordWithinObjectIds(
        batchPayload.workspaceId, query.queryText, query.limit, batchPayload.objectIds
      ));
  }
  if (operation === "memory.searchByKeyword") {
    const keywordPayload = payload as WorkerOperationPayload<"memory.searchByKeyword">;
    return await runtime.memoryEntryRepo.searchByKeyword(
      keywordPayload.workspaceId,
      keywordPayload.queryText,
      keywordPayload.limit
    );
  }
  if (operation === "memory.searchByKeywordWithinTier") {
    const tierPayload = payload as WorkerOperationPayload<"memory.searchByKeywordWithinTier">;
    return await runtime.memoryEntryRepo.searchByKeywordWithinTier(
      tierPayload.workspaceId,
      tierPayload.queryText,
      tierPayload.limit,
      tierPayload.tier
    );
  }
  if (operation === "memory.searchByAnchorWithinTier") {
    const anchorPayload = payload as WorkerOperationPayload<"memory.searchByAnchorWithinTier">;
    return await runtime.memoryEntryRepo.searchByAnchorWithinTier(
      anchorPayload.workspaceId,
      anchorPayload.anchorTokens,
      anchorPayload.optionalTokens,
      anchorPayload.limit,
      anchorPayload.tier
    );
  }
  if (operation === "memory.searchByKeywordWithinObjectIds") {
    const scopedPayload = payload as WorkerOperationPayload<"memory.searchByKeywordWithinObjectIds">;
    return await runtime.memoryEntryRepo.searchByKeywordWithinObjectIds(
      scopedPayload.workspaceId,
      scopedPayload.queryText,
      scopedPayload.limit,
      scopedPayload.objectIds
    );
  }
  const anchorScopedPayload = payload as WorkerOperationPayload<"memory.searchByAnchorWithinObjectIds">;
  return await runtime.memoryEntryRepo.searchByAnchorWithinObjectIds(
    anchorScopedPayload.workspaceId,
    anchorScopedPayload.anchorTokens,
    anchorScopedPayload.optionalTokens,
    anchorScopedPayload.limit,
    anchorScopedPayload.objectIds
  );
}
