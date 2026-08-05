import type {
  MemoryDimension,
  ScopeClass,
  StorageTier
} from "@do-soul/alaya-protocol";
import type {
  KeywordSearchBatchQuery,
  KeywordSearchLaneScope,
  RecallMemoryListPageOptions,
  RecallServiceMemoryRepoPort
} from "@do-soul/alaya-core";
import type { RecallReadWorkerOperation } from "./protocol.js";

type TierWindowReader = NonNullable<RecallServiceMemoryRepoPort["findRecallTierWindow"]>;
export type WorkerTierWindowResult = Awaited<ReturnType<TierWindowReader>>;

type WorkerRequest = <Result>(
  operation: RecallReadWorkerOperation,
  payload: unknown
) => Promise<Result>;

type MemoryLookupReads = Pick<
  RecallServiceMemoryRepoPort,
  | "findByWorkspaceId"
  | "findByDimension"
  | "findByScopeClass"
  | "findByEvidenceRefs"
  | "findBoundEvidenceRefs"
  | "findByIds"
>;

type MemoryKeywordReads = Pick<
  RecallServiceMemoryRepoPort,
  | "searchByKeyword"
  | "searchByKeywordField"
  | "searchByKeywordWithinObjectIds"
  | "searchByKeywordWithinTier"
  | "searchManyByKeywordWithinObjectIds"
>;

type MemoryAnchorReads = Pick<
  RecallServiceMemoryRepoPort,
  "searchByAnchorWithinObjectIds" | "searchByAnchorWithinTier" | "searchByAnchorField"
>;

export function createWorkerMemoryRepo(input: Readonly<{
  readonly request: WorkerRequest;
  readonly readTierWindow: TierWindowReader;
}>): RecallServiceMemoryRepoPort {
  return {
    findRecallTierWindow: input.readTierWindow,
    findByEventTimeWindow: async (query) =>
      await input.request("memory.findByEventTimeWindow", query),
    ...createWorkerMemoryLookupReads(input.request),
    ...createWorkerMemoryKeywordReads(input.request),
    ...createWorkerMemoryAnchorReads(input.request)
  };
}

function createWorkerMemoryLookupReads(request: WorkerRequest): MemoryLookupReads {
  return {
    findByWorkspaceId: async (
      workspaceId: string,
      tier?: StorageTier,
      page?: RecallMemoryListPageOptions
    ) => await request("memory.findByWorkspaceId", { workspaceId, tier, page }),
    findByDimension: async (workspaceId: string, dimension: MemoryDimension) =>
      await request("memory.findByDimension", { workspaceId, dimension }),
    findByScopeClass: async (workspaceId: string, scopeClass: ScopeClass) =>
      await request("memory.findByScopeClass", { workspaceId, scopeClass }),
    findByEvidenceRefs: async (workspaceId: string, evidenceObjectIds: readonly string[]) =>
      await request("memory.findByEvidenceRefs", { workspaceId, evidenceObjectIds }),
    findBoundEvidenceRefs: async (workspaceId: string, evidenceObjectIds: readonly string[]) =>
      await request("memory.findBoundEvidenceRefs", { workspaceId, evidenceObjectIds }),
    findByIds: async (workspaceId: string, objectIds: readonly string[]) =>
      await request("memory.findByIds", { workspaceId, objectIds })
  };
}

function createWorkerMemoryKeywordReads(request: WorkerRequest): MemoryKeywordReads {
  return {
    searchByKeyword: async (workspaceId: string, queryText: string, limit: number) =>
      await request("memory.searchByKeyword", { workspaceId, queryText, limit }),
    searchByKeywordField: async (
      workspaceId: string,
      queryText: string,
      limit: number,
      scope?: Readonly<KeywordSearchLaneScope>,
      refinementDepths?: readonly number[]
    ) => await request("memory.searchByKeywordField", {
      workspaceId, queryText, limit, scope,
      ...(refinementDepths === undefined ? {} : { refinementDepths })
    }),
    searchByKeywordWithinObjectIds: async (
      workspaceId: string,
      queryText: string,
      limit: number,
      objectIds: readonly string[]
    ) => await request(
      "memory.searchByKeywordWithinObjectIds",
      { workspaceId, queryText, limit, objectIds }
    ),
    searchByKeywordWithinTier: async (
      workspaceId: string,
      queryText: string,
      limit: number,
      tier: StorageTier
    ) => await request(
      "memory.searchByKeywordWithinTier",
      { workspaceId, queryText, limit, tier }
    ),
    searchManyByKeywordWithinObjectIds: async (
      workspaceId: string,
      queries: readonly Readonly<KeywordSearchBatchQuery>[],
      objectIds: readonly string[]
    ) => await request(
      "memory.searchManyByKeywordWithinObjectIds",
      { workspaceId, queries, objectIds }
    )
  };
}

function createWorkerMemoryAnchorReads(request: WorkerRequest): MemoryAnchorReads {
  return {
    searchByAnchorWithinObjectIds: async (
      workspaceId: string,
      anchorTokens: readonly string[],
      optionalTokens: readonly string[],
      limit: number,
      objectIds: readonly string[]
    ) => await request(
      "memory.searchByAnchorWithinObjectIds",
      { workspaceId, anchorTokens, optionalTokens, limit, objectIds }
    ),
    searchByAnchorWithinTier: async (
      workspaceId: string,
      anchorTokens: readonly string[],
      optionalTokens: readonly string[],
      limit: number,
      tier: StorageTier
    ) => await request(
      "memory.searchByAnchorWithinTier",
      { workspaceId, anchorTokens, optionalTokens, limit, tier }
    ),
    searchByAnchorField: async (
      workspaceId: string,
      anchorTokens: readonly string[],
      optionalTokens: readonly string[],
      limit: number,
      scope?: Readonly<KeywordSearchLaneScope>,
      refinementDepths?: readonly number[]
    ) => await request(
      "memory.searchByAnchorField",
      {
        workspaceId, anchorTokens, optionalTokens, limit, scope,
        ...(refinementDepths === undefined ? {} : { refinementDepths })
      }
    )
  };
}
