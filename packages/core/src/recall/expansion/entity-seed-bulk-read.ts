import { errorNameOf, toErrorMessage } from "../runtime/recall-service-helpers.js";
import type { RecallServiceDependencies, RecallServiceWarnPort } from "../runtime/recall-service-types.js";

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
type BulkFailure = Readonly<{
  readonly failureClass: "result_count_mismatch" | "service_error";
  readonly actualCount: number;
}>;
type BulkSearchOutcome = Readonly<
  | { readonly kind: "unavailable" }
  | { readonly kind: "success"; readonly batches: readonly (readonly EntitySeedHit[])[] }
  | { readonly kind: "failure"; readonly failure: BulkFailure }
>;

export async function loadEntitySeedHitBatches(
  params: LoadEntitySeedHitBatchesParams
): Promise<readonly (readonly EntitySeedHit[])[]> {
  if (params.lookups.length === 0) return [];
  const bulk = await tryBulkSearch(params);
  if (bulk.kind === "success") return bulk.batches;
  const hasScalar = hasScalarSearch(params.memoryRepo);
  if (bulk.kind === "failure") {
    warnBulkFailure(params, bulk.failure, hasScalar);
    if (!hasScalar) return emptyHitBatches(params.lookups);
  }
  if (!hasScalar) {
    warnNoSearchPort(params);
    return emptyHitBatches(params.lookups);
  }
  return loadScalarHitBatches(params);
}

async function tryBulkSearch(
  params: LoadEntitySeedHitBatchesParams
): Promise<BulkSearchOutcome> {
  const bulkSearch = params.memoryRepo.searchManyByKeywordWithinObjectIds;
  if (bulkSearch === undefined) return Object.freeze({ kind: "unavailable" });
  try {
    const batches = await bulkSearch.call(
      params.memoryRepo,
      params.workspaceId,
      params.lookups.map(({ surface, limit }) => ({ queryText: surface, limit })),
      params.candidateIds
    );
    return batches.length === params.lookups.length
      ? Object.freeze({ kind: "success", batches })
      : Object.freeze({
          kind: "failure",
          failure: Object.freeze({
            failureClass: "result_count_mismatch" as const,
            actualCount: batches.length
          })
        });
  } catch {
    return Object.freeze({
      kind: "failure",
      failure: Object.freeze({ failureClass: "service_error" as const, actualCount: 0 })
    });
  }
}

async function loadScalarHitBatches(
  params: LoadEntitySeedHitBatchesParams
): Promise<readonly (readonly EntitySeedHit[])[]> {
  const batches: (readonly EntitySeedHit[])[] = [];
  for (const lookup of params.lookups) {
    batches.push(await loadScalarHits(params, lookup));
  }
  return batches;
}

async function loadScalarHits(
  params: LoadEntitySeedHitBatchesParams,
  lookup: EntitySeedLookup
): Promise<readonly EntitySeedHit[]> {
  try {
    const scoped = params.memoryRepo.searchByKeywordWithinObjectIds;
    if (scoped !== undefined) {
      return scoped.call(
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

function warnBulkFailure(
  params: LoadEntitySeedHitBatchesParams,
  failure: BulkFailure,
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
      actual_count: failure.actualCount
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

function emptyHitBatches(
  lookups: readonly EntitySeedLookup[]
): readonly (readonly EntitySeedHit[])[] {
  return lookups.map(() => Object.freeze([]));
}
