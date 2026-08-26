import type { MemoryEntry } from "@do-soul/alaya-protocol";
import { recordRecallDegradation } from "../runtime/diagnostics.js";
import { errorNameOf, toErrorMessage } from "../runtime/recall-service-helpers.js";
import type {
  RecallDegradationReason,
  RecallServiceDependencies,
  RecallServiceWarnPort
} from "../runtime/recall-service-types.js";
import {
  loadIndexAlignedSearchBatches,
  type IndexAlignedBatchFailure
} from "../search/index-aligned-search-batches.js";

export type EntitySeedHit = Readonly<{
  readonly object_id: string;
  readonly normalized_rank: number;
}>;

type EntitySeedLookup = Readonly<{ readonly surface: string; readonly limit: number }>;
type LoadEntitySeedHitBatchesParams = Readonly<{
  readonly workspaceId: string;
  readonly lookups: readonly EntitySeedLookup[];
  readonly candidateIds: readonly string[];
  readonly searchScope?: "object_ids" | "tier";
  readonly tier?: MemoryEntry["storage_tier"];
  readonly memoryRepo: RecallServiceDependencies["memoryRepo"];
  readonly warn: RecallServiceWarnPort;
  readonly degradationReasons?: Set<RecallDegradationReason>;
}>;
export async function loadEntitySeedHitBatches(
  params: LoadEntitySeedHitBatchesParams
): Promise<readonly (readonly EntitySeedHit[])[]> {
  const bulkSearch = params.searchScope === "tier"
    ? undefined
    : params.memoryRepo.searchManyByKeywordWithinObjectIds;
  const hasScalar = hasScalarSearch(params);
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
    return await searchEntitySeedHits(params, lookup);
  } catch (error) {
    params.warn("entity seed lookup failed", {
      workspace_id: params.workspaceId,
      entity_surface: lookup.surface,
      operation: "entity_seed_lookup",
      errorName: errorNameOf(error),
      error: toErrorMessage(error)
    });
    recordEntitySeedLookupFailure(params);
    return [];
  }
}

async function searchEntitySeedHits(
  params: LoadEntitySeedHitBatchesParams,
  lookup: EntitySeedLookup
): Promise<readonly EntitySeedHit[]> {
  if (params.searchScope === "tier") {
    return searchEntitySeedHitsWithinTier(params, lookup);
  }
  const scoped = params.memoryRepo.searchByKeywordWithinObjectIds;
  if (scoped !== undefined) {
    return await scoped.call(
      params.memoryRepo, params.workspaceId, lookup.surface, lookup.limit, params.candidateIds
    );
  }
  return searchEntitySeedHitsUnscoped(params, lookup);
}

async function searchEntitySeedHitsWithinTier(
  params: LoadEntitySeedHitBatchesParams,
  lookup: EntitySeedLookup
): Promise<readonly EntitySeedHit[]> {
  // Field-scoped recall must not shrink entity FTS to the activation id set.
  const withinTier = params.memoryRepo.searchByKeywordWithinTier;
  if (withinTier !== undefined && params.tier !== undefined) {
    return await withinTier.call(
      params.memoryRepo, params.workspaceId, lookup.surface, lookup.limit, params.tier
    );
  }
  return searchEntitySeedHitsUnscoped(params, lookup);
}

async function searchEntitySeedHitsUnscoped(
  params: LoadEntitySeedHitBatchesParams,
  lookup: EntitySeedLookup
): Promise<readonly EntitySeedHit[]> {
  const unscoped = params.memoryRepo.searchByKeyword;
  if (unscoped === undefined) return [];
  return await unscoped.call(
    params.memoryRepo, params.workspaceId, lookup.surface, lookup.limit
  );
}

function hasScalarSearch(params: LoadEntitySeedHitBatchesParams): boolean {
  if (params.searchScope === "tier") {
    return params.memoryRepo.searchByKeywordWithinTier !== undefined ||
      params.memoryRepo.searchByKeyword !== undefined;
  }
  return params.memoryRepo.searchByKeywordWithinObjectIds !== undefined ||
    params.memoryRepo.searchByKeyword !== undefined;
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
      invalid_index: failure.invalidIndex,
      errorName: failure.errorName,
      errorMessage: failure.errorMessage
    }
  );
  if (!hasScalar) recordEntitySeedLookupFailure(params);
}

function warnNoSearchPort(params: LoadEntitySeedHitBatchesParams): void {
  params.warn("entity seed lookup unavailable; skipping entity seeds", {
    operation: "entity_seed_lookup",
    failure_class: "no_search_port",
    expected_count: params.lookups.length,
    actual_count: 0
  });
  recordEntitySeedLookupFailure(params);
}

function recordEntitySeedLookupFailure(params: LoadEntitySeedHitBatchesParams): void {
  recordRecallDegradation(params, "entity_seed_lookup_failed");
}
