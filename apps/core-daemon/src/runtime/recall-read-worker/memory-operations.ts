import type { RecallReadWorkerRequest } from "./protocol.js";
import type { ParsedWorkerOperation } from "./operation-schemas.js";
import {
  findMemoryEntriesByWorkspaceId,
  readRecallTierWindowQuery
} from "./memory-window.js";
import { runMemoryFieldOperation } from "./field-operations.js";
import { runOrderedKeywordSearchBatch } from "./worker-readers.js";
import type { RecallReadWorkerRuntime } from "./runtime.js";

type MemoryOperation = Extract<RecallReadWorkerRequest["operation"], `memory.${string}`>;
type MemorySearchOperation =
  | "memory.searchByKeyword"
  | "memory.searchByKeywordWithinObjectIds"
  | "memory.searchByKeywordWithinTier"
  | "memory.searchManyByKeywordWithinObjectIds"
  | "memory.searchByAnchorWithinObjectIds"
  | "memory.searchByAnchorWithinTier";

export async function runMemoryOperation(
  runtime: RecallReadWorkerRuntime,
  parsed: ParsedWorkerOperation<MemoryOperation>
) {
  const { memoryEntryRepo } = runtime;
  switch (parsed.operation) {
    case "memory.searchByKeywordField":
    case "memory.searchByAnchorField":
      return await runMemoryFieldOperation(memoryEntryRepo, parsed);
    case "memory.searchByKeyword":
    case "memory.searchByKeywordWithinObjectIds":
    case "memory.searchByKeywordWithinTier":
    case "memory.searchManyByKeywordWithinObjectIds":
    case "memory.searchByAnchorWithinObjectIds":
    case "memory.searchByAnchorWithinTier":
      return await runMemorySearchOperation(runtime, parsed);
    case "memory.findRecallTierWindow":
      return await memoryEntryRepo.findRecallTierWindow(
        readRecallTierWindowQuery(parsed.payload)
      );
    case "memory.findByWorkspaceId": {
      const { payload } = parsed;
      return await findMemoryEntriesByWorkspaceId(
        memoryEntryRepo,
        payload.workspaceId,
        payload.tier,
        payload.page
      );
    }
    case "memory.findByEventTimeWindow": {
      const { payload } = parsed;
      return await memoryEntryRepo.findByEventTimeWindow({
        workspaceId: payload.workspaceId,
        tier: payload.tier,
        startTime: payload.startTime,
        endTime: payload.endTime,
        limit: payload.limit
      });
    }
    case "memory.findByDimension":
      return await memoryEntryRepo.findByDimension(
        parsed.payload.workspaceId,
        parsed.payload.dimension
      );
    case "memory.findByScopeClass":
      return await memoryEntryRepo.findByScopeClass(
        parsed.payload.workspaceId,
        parsed.payload.scopeClass
      );
    case "memory.findByEvidenceRefs":
      return await memoryEntryRepo.findByEvidenceRefs(
        parsed.payload.workspaceId,
        parsed.payload.evidenceObjectIds
      );
    case "memory.findBoundEvidenceRefs":
      return await memoryEntryRepo.findBoundEvidenceRefs(
        parsed.payload.workspaceId,
        parsed.payload.evidenceObjectIds
      );
    case "memory.findByIds":
      return await memoryEntryRepo.findByIds(parsed.payload.workspaceId, parsed.payload.objectIds);
  }
}

async function runMemorySearchOperation(
  runtime: RecallReadWorkerRuntime,
  parsed: ParsedWorkerOperation<MemorySearchOperation>
) {
  if (parsed.operation === "memory.searchManyByKeywordWithinObjectIds") {
    const { payload } = parsed;
    return runOrderedKeywordSearchBatch(payload.queries, (query) =>
      runtime.memoryEntryRepo.searchByKeywordWithinObjectIds(
        payload.workspaceId, query.queryText, query.limit, payload.objectIds
      ));
  }
  if (parsed.operation === "memory.searchByKeyword") {
    const { payload } = parsed;
    return await runtime.memoryEntryRepo.searchByKeyword(
      payload.workspaceId,
      payload.queryText,
      payload.limit
    );
  }
  if (parsed.operation === "memory.searchByKeywordWithinTier") {
    const { payload } = parsed;
    return await runtime.memoryEntryRepo.searchByKeywordWithinTier(
      payload.workspaceId,
      payload.queryText,
      payload.limit,
      payload.tier
    );
  }
  if (parsed.operation === "memory.searchByAnchorWithinTier") {
    const { payload } = parsed;
    return await runtime.memoryEntryRepo.searchByAnchorWithinTier(
      payload.workspaceId,
      payload.anchorTokens,
      payload.optionalTokens,
      payload.limit,
      payload.tier
    );
  }
  if (parsed.operation === "memory.searchByKeywordWithinObjectIds") {
    const { payload } = parsed;
    return await runtime.memoryEntryRepo.searchByKeywordWithinObjectIds(
      payload.workspaceId,
      payload.queryText,
      payload.limit,
      payload.objectIds
    );
  }
  const { payload } = parsed;
  return await runtime.memoryEntryRepo.searchByAnchorWithinObjectIds(
    payload.workspaceId,
    payload.anchorTokens,
    payload.optionalTokens,
    payload.limit,
    payload.objectIds
  );
}
