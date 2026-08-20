import {
  MemoryDimensionSchema,
  ScopeClassSchema,
  StorageTierSchema
} from "@do-soul/alaya-protocol";
import type { RecallReadWorkerRequest } from "./protocol.js";
import {
  findMemoryEntriesByWorkspaceId,
  readRecallTierWindowQuery
} from "./memory-window.js";
import { runMemoryFieldOperation } from "./field-operations.js";
import {
  readNumber,
  readString,
  readStringArray
} from "./payload-readers.js";
import {
  readKeywordSearchBatchQueries,
  readPage,
  runOrderedKeywordSearchBatch
} from "./worker-readers.js";
import type { RecallReadWorkerRuntime } from "./runtime.js";

export async function runMemoryOperation(
  runtime: RecallReadWorkerRuntime,
  operation: Extract<RecallReadWorkerRequest["operation"], `memory.${string}`>,
  payload: Record<string, unknown>
) {
  const { memoryEntryRepo } = runtime;
  switch (operation) {
    case "memory.searchByKeywordField":
    case "memory.searchByAnchorField":
      return await runMemoryFieldOperation(memoryEntryRepo, operation, payload);
    case "memory.searchByKeyword":
    case "memory.searchByKeywordWithinObjectIds":
    case "memory.searchByKeywordWithinTier":
    case "memory.searchManyByKeywordWithinObjectIds":
    case "memory.searchByAnchorWithinObjectIds":
    case "memory.searchByAnchorWithinTier":
      return await runMemorySearchOperation(runtime, operation, payload);
    case "memory.findRecallTierWindow":
      return await memoryEntryRepo.findRecallTierWindow(
        readRecallTierWindowQuery(payload)
      );
    case "memory.findByWorkspaceId":
      return await findMemoryEntriesByWorkspaceId(
        memoryEntryRepo,
        readString(payload.workspaceId, "workspaceId"),
        payload.tier === undefined ? undefined : StorageTierSchema.parse(payload.tier),
        payload.page === undefined ? undefined : readPage(payload.page)
      );
    case "memory.findByEventTimeWindow":
      return await findMemoryEntriesByEventTimeWindow(runtime, payload);
    case "memory.findByDimension":
      return await memoryEntryRepo.findByDimension(
        readString(payload.workspaceId, "workspaceId"),
        MemoryDimensionSchema.parse(payload.dimension)
      );
    case "memory.findByScopeClass":
      return await memoryEntryRepo.findByScopeClass(
        readString(payload.workspaceId, "workspaceId"),
        ScopeClassSchema.parse(payload.scopeClass)
      );
    case "memory.findByEvidenceRefs":
      return await memoryEntryRepo.findByEvidenceRefs(
        readString(payload.workspaceId, "workspaceId"),
        readStringArray(payload.evidenceObjectIds, "evidenceObjectIds")
      );
    case "memory.findBoundEvidenceRefs":
      return await memoryEntryRepo.findBoundEvidenceRefs(
        readString(payload.workspaceId, "workspaceId"),
        readStringArray(payload.evidenceObjectIds, "evidenceObjectIds")
      );
    case "memory.findByIds":
      return await memoryEntryRepo.findByIds(
        readString(payload.workspaceId, "workspaceId"),
        readStringArray(payload.objectIds, "objectIds")
      );
  }
}

async function findMemoryEntriesByEventTimeWindow(
  runtime: RecallReadWorkerRuntime,
  payload: Record<string, unknown>
) {
  return await runtime.memoryEntryRepo.findByEventTimeWindow({
    workspaceId: readString(payload.workspaceId, "workspaceId"),
    tier: StorageTierSchema.parse(payload.tier),
    startTime: readString(payload.startTime, "startTime"),
    endTime: readString(payload.endTime, "endTime"),
    limit: readNumber(payload.limit, "limit")
  });
}

async function runMemorySearchOperation(
  runtime: RecallReadWorkerRuntime,
  operation: Extract<RecallReadWorkerRequest["operation"], `memory.search${string}`>,
  payload: Record<string, unknown>
) {
  if (operation === "memory.searchManyByKeywordWithinObjectIds") {
    return await searchManyMemoryKeywordsWithinObjectIds(runtime, payload);
  }
  const workspaceId = readString(payload.workspaceId, "workspaceId");
  const limit = readNumber(payload.limit, "limit");
  if (operation === "memory.searchByKeyword") {
    return await runtime.memoryEntryRepo.searchByKeyword(
      workspaceId,
      readString(payload.queryText, "queryText"),
      limit
    );
  }
  if (
    operation === "memory.searchByKeywordWithinTier" ||
    operation === "memory.searchByAnchorWithinTier"
  ) {
    return await runTierScopedMemorySearch(runtime, operation, payload, workspaceId, limit);
  }
  const objectIds = readStringArray(payload.objectIds, "objectIds");
  if (operation === "memory.searchByKeywordWithinObjectIds") {
    return await runtime.memoryEntryRepo.searchByKeywordWithinObjectIds(
      workspaceId,
      readString(payload.queryText, "queryText"),
      limit,
      objectIds
    );
  }
  return await runtime.memoryEntryRepo.searchByAnchorWithinObjectIds(
    workspaceId,
    readStringArray(payload.anchorTokens, "anchorTokens"),
    readStringArray(payload.optionalTokens, "optionalTokens"),
    limit,
    objectIds
  );
}

async function runTierScopedMemorySearch(
  runtime: RecallReadWorkerRuntime,
  operation: "memory.searchByKeywordWithinTier" | "memory.searchByAnchorWithinTier",
  payload: Record<string, unknown>,
  workspaceId: string,
  limit: number
) {
  const tier = StorageTierSchema.parse(payload.tier);
  if (operation === "memory.searchByKeywordWithinTier") {
    const queryText = readString(payload.queryText, "queryText");
    return await runtime.memoryEntryRepo.searchByKeywordWithinTier(
      workspaceId, queryText, limit, tier
    );
  }
  const anchorTokens = readStringArray(payload.anchorTokens, "anchorTokens");
  const optionalTokens = readStringArray(payload.optionalTokens, "optionalTokens");
  return await runtime.memoryEntryRepo.searchByAnchorWithinTier(
    workspaceId, anchorTokens, optionalTokens, limit, tier
  );
}

async function searchManyMemoryKeywordsWithinObjectIds(
  runtime: RecallReadWorkerRuntime,
  payload: Record<string, unknown>
) {
  const workspaceId = readString(payload.workspaceId, "workspaceId");
  const objectIds = readStringArray(payload.objectIds, "objectIds");
  const queries = readKeywordSearchBatchQueries(payload.queries);
  return runOrderedKeywordSearchBatch(queries, (query) =>
    runtime.memoryEntryRepo.searchByKeywordWithinObjectIds(
      workspaceId, query.queryText, query.limit, objectIds
    ));
}
