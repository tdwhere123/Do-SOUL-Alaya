import { errorNameOf, toErrorMessage } from "../runtime/recall-service-helpers.js";
import type { RecallServiceDependencies, RecallServiceWarnPort } from "../runtime/recall-service-types.js";
import {
  loadIndexAlignedSearchBatches,
  type IndexAlignedBatchFailure
} from "../runtime/orchestration/index-aligned-search-batches.js";

export type EntitySeedHit = Readonly<{
  readonly object_id: string;
  readonly normalized_rank: number;
}>;

type EntitySeedLookup = Readonly<{ readonly surface: string; readonly limit: number }>;
type LoadEntitySeedHitBatchesParams = Readonly<{
  readonly workspaceId: string;
  readonly lookups: readonly EntitySeedLookup[];
  readonly candidateIds: readonly string[];
  readonly memoryRepo: RecallServiceDependencies["memoryRepo"];
  readonly warn: RecallServiceWarnPort;
}>;
export async function loadEntitySeedHitBatches(
  params: LoadEntitySeedHitBatchesParams
): Promise<readonly (readonly EntitySeedHit[])[]> {
  const bulkSearch = params.memoryRepo.searchManyByKeywordWithinObjectIds;
  const hasScalar = hasScalarSearch(params.memoryRepo);
  return loadIndexAlignedSearchBatches({
    lookups: params.lookups,
    ...(bulkSearch === undefined ? {} : {
      searchMany: (lookups: readonly EntitySeedLookup[]) => bulkSearch.call(
        params.memoryRepo,
        params.workspaceId,
        lookups.map(({ surface, limit }) => ({ queryText: surface, limit })),
        params.candidateIds
      )
    }),
    ...(hasScalar ? { searchOne: (lookup: EntitySeedLookup) => loadScalarHits(params, lookup) } : {}),
    isHit: isEntitySeedHit,
    maxHitsForLookup: (lookup) => lookup.limit,
    onBatchFailure: (failure, canFallback) => warnBulkFailure(params, failure, canFallback),
    onUnavailable: () => warnNoSearchPort(params)
  });
}

async function loadScalarHits(
  params: LoadEntitySeedHitBatchesParams,
  lookup: EntitySeedLookup
): Promise<readonly EntitySeedHit[]> {
  try {
    const scoped = params.memoryRepo.searchByKeywordWithinObjectIds;
    if (scoped !== undefined) {
      return await scoped.call(
        params.memoryRepo, params.workspaceId, lookup.surface, lookup.limit, params.candidateIds
      );
    }
    const unscoped = params.memoryRepo.searchByKeyword;
    if (unscoped === undefined) return [];
    return await unscoped.call(
      params.memoryRepo, params.workspaceId, lookup.surface, lookup.limit
    );
  } catch (error) {
    params.warn("entity seed lookup failed", {
      workspace_id: params.workspaceId,
      entity_surface: lookup.surface,
      operation: "entity_seed_lookup",
      errorName: errorNameOf(error),
      error: toErrorMessage(error)
    });
    return [];
  }
}

function hasScalarSearch(memoryRepo: RecallServiceDependencies["memoryRepo"]): boolean {
  return memoryRepo.searchByKeywordWithinObjectIds !== undefined ||
    memoryRepo.searchByKeyword !== undefined;
}

function isEntitySeedHit(value: unknown): value is EntitySeedHit {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const hit = value as Record<string, unknown>;
  return typeof hit.object_id === "string" && hit.object_id.trim().length > 0 &&
    typeof hit.normalized_rank === "number" && Number.isFinite(hit.normalized_rank);
}

function warnBulkFailure(
  params: LoadEntitySeedHitBatchesParams,
  failure: IndexAlignedBatchFailure,
  hasScalar: boolean
): void {
  params.warn(
    hasScalar
      ? "entity seed bulk lookup failed; using scalar lookups"
      : "entity seed bulk lookup failed; skipping entity seeds",
    {
      operation: "entity_seed_bulk_lookup",
      failure_class: failure.failureClass,
      expected_count: params.lookups.length,
      returned_count: failure.returnedCount,
      valid_batch_count: failure.validBatchCount,
      invalid_index: failure.invalidIndex
    }
  );
}

function warnNoSearchPort(params: LoadEntitySeedHitBatchesParams): void {
  params.warn("entity seed lookup unavailable; skipping entity seeds", {
    operation: "entity_seed_lookup",
    failure_class: "no_search_port",
    expected_count: params.lookups.length,
    actual_count: 0
  });
}
