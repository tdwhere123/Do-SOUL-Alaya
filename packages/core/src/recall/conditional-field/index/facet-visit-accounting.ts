import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  type FacetVector,
  type FieldValue,
  type SeedActivation
} from "@do-soul/alaya-protocol";
import { composedFacetPathId, facetBelongsToOutput, facetPathId } from "../engine/path-composition.js";
import { productStateNodeId } from "../reference/bind-max-min.js";

export type FacetVisitIndex = Readonly<{
  readonly facets_by_identity: ReadonlyMap<string, readonly FacetVector[]>;
  readonly seeds_by_node: ReadonlyMap<string, readonly SeedActivation[]>;
  readonly built: number;
  readonly total: number;
  readonly complete: boolean;
}>;

export type FacetVisitProgress = Readonly<{
  readonly scan_offset: number;
  readonly index: FacetVisitIndex;
  readonly visits: number;
  readonly cache_hits: number;
  readonly cache_misses: number;
}>;

export type FacetIndexPreparation = Readonly<{
  readonly index: FacetVisitIndex;
  readonly visits: number;
  readonly cache_hits: number;
  readonly cache_misses: number;
}>;

const COMPLETE_INDEXES = new WeakMap<object, WeakMap<object, FacetVisitIndex>>();

function emptyIndex(total: number): FacetVisitIndex {
  return {
    facets_by_identity: new Map(),
    seeds_by_node: new Map(),
    built: 0,
    total,
    complete: total === 0
  };
}

function pathIdentity(pathId: string): string {
  const split = pathId.indexOf(":");
  return split === -1 ? pathId : pathId.slice(0, split);
}

function cachedIndex(
  facets: readonly FacetVector[],
  seeds: readonly SeedActivation[]
): FacetVisitIndex | undefined {
  return COMPLETE_INDEXES.get(facets)?.get(seeds);
}

function rememberIndex(
  facets: readonly FacetVector[],
  seeds: readonly SeedActivation[],
  index: FacetVisitIndex
): void {
  let nested = COMPLETE_INDEXES.get(facets);
  if (nested === undefined) {
    nested = new WeakMap();
    COMPLETE_INDEXES.set(facets, nested);
  }
  nested.set(seeds, index);
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const existing = map.get(key);
  if (existing === undefined) map.set(key, [value]);
  else existing.push(value);
}

export function prepareFacetVisitIndex(
  facets: readonly FacetVector[],
  seeds: readonly SeedActivation[],
  allowance: number,
  prior?: FacetVisitIndex
): FacetIndexPreparation {
  if (facets.length === 0) {
    return { index: emptyIndex(0), visits: 0, cache_hits: 0, cache_misses: 0 };
  }
  const total = facets.length + seeds.length;
  const hit = cachedIndex(facets, seeds);
  if (hit !== undefined && hit.complete && hit.total === total) {
    return { index: hit, visits: 0, cache_hits: 1, cache_misses: 0 };
  }
  const knownFacets = new Set(
    [...(prior?.facets_by_identity.values() ?? [])].flatMap((row) => row.map((vector) => vector.path_id))
  );
  const knownSeeds = new Set(prior?.seeds_by_node.keys() ?? []);
  const maps = {
    facets_by_identity: new Map<string, FacetVector[]>(),
    seeds_by_node: new Map<string, SeedActivation[]>()
  };
  let visits = 0;
  let built = 0;
  for (const vector of facets) {
    const known = knownFacets.has(vector.path_id);
    if (!known && visits >= allowance) {
      return {
        index: { ...maps, built, total, complete: false },
        visits,
        cache_hits: 0,
        cache_misses: 1
      };
    }
    push(maps.facets_by_identity, pathIdentity(vector.path_id), vector);
    if (!known) visits += 1;
    built += 1;
  }
  for (const seed of seeds) {
    const node = productStateNodeId(seed.state);
    const known = knownSeeds.has(node);
    if (!known && visits >= allowance) {
      return {
        index: { ...maps, built, total, complete: false },
        visits,
        cache_hits: 0,
        cache_misses: 1
      };
    }
    push(maps.seeds_by_node, node, seed);
    if (!known) visits += 1;
    built += 1;
  }
  const index: FacetVisitIndex = { ...maps, built, total, complete: true };
  rememberIndex(facets, seeds, index);
  return { index, visits, cache_hits: visits === 0 ? 1 : 0, cache_misses: visits === 0 ? 0 : 1 };
}

export function facetsForCandidate(
  value: FieldValue,
  facets: readonly FacetVector[],
  seeds: readonly SeedActivation[]
): readonly FacetVector[] {
  const matchingSeeds = seeds.filter(
    (seed) => productStateNodeId(seed.state) === productStateNodeId(value.state)
  );
  return [
    ...facets.filter((vector) => facetBelongsToOutput(vector.path_id, value.state)),
    ...matchingSeeds.map((seed) => ({
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      path_id: composedFacetPathId(seed.state, "seed"),
      coordinates: [seed.milligrades]
    }))
  ];
}

export function indexedFacetsForCandidate(
  value: FieldValue,
  index: FacetVisitIndex,
  facets: readonly FacetVector[]
): readonly FacetVector[] {
  if (facets.length === 0) return [];
  const identity = facetPathId(value.state);
  const node = productStateNodeId(value.state);
  const vectors = index.facets_by_identity.get(identity) ?? [];
  const seeds = index.seeds_by_node.get(node) ?? [];
  return [
    ...vectors,
    ...seeds.map((seed) => ({
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      path_id: composedFacetPathId(seed.state, "seed"),
      coordinates: [seed.milligrades]
    }))
  ];
}

export function takeFacetBucketVisits(
  bucket: readonly FacetVector[],
  start: number,
  allowance: number
): Readonly<{ readonly visits: number; readonly next_offset: number; readonly complete: boolean }> {
  if (start >= bucket.length) return { visits: 0, next_offset: bucket.length, complete: true };
  const remaining = bucket.length - start;
  if (remaining > allowance) {
    return { visits: allowance, next_offset: start + allowance, complete: false };
  }
  return { visits: remaining, next_offset: bucket.length, complete: true };
}

export function accountFacetPreparation(
  facets: readonly FacetVector[],
  seeds: readonly SeedActivation[],
  allowance: number,
  prior: FacetVisitIndex | undefined,
  scanOffset: number,
  hold = 0
): Readonly<{
  readonly remaining: number;
  readonly truncated: boolean;
  readonly facet: FacetVisitProgress;
}> {
  const cap = hold > 0 ? Math.max(0, allowance - hold) : allowance;
  const prepared = prepareFacetVisitIndex(facets, seeds, cap, prior);
  return {
    remaining: allowance - prepared.visits,
    truncated: !prepared.index.complete,
    facet: {
      scan_offset: scanOffset,
      index: prepared.index,
      visits: prepared.visits,
      cache_hits: prepared.cache_hits,
      cache_misses: prepared.cache_misses
    }
  };
}

export function fieldProgressFingerprint(state: {
  readonly observations: { readonly length: number };
  readonly seeds: { readonly length: number };
  readonly transitions: { readonly length: number };
  readonly grounding_progress?: { readonly completed_work: number };
  readonly resume_cursors: unknown;
  readonly pair_progress: unknown;
  readonly support_progress?: unknown;
  readonly projection_progress?: {
    readonly offset: number;
    readonly delivered_entries: unknown;
    readonly facet_offset?: number;
    readonly facet_index?: { readonly built: number; readonly complete: boolean };
  };
  readonly seen_identities: { readonly length: number };
  readonly pending_path_effects?: { readonly offset: number };
  readonly last_observer_status: unknown;
} | undefined): string {
  return JSON.stringify([
    state?.observations.length ?? 0, state?.seeds.length ?? 0,
    state?.transitions.length ?? 0, state?.grounding_progress?.completed_work ?? 0,
    state?.resume_cursors ?? {}, state?.pair_progress ?? {}, state?.support_progress ?? {},
    state?.projection_progress?.offset ?? 0, state?.projection_progress?.delivered_entries ?? {},
    state?.projection_progress?.facet_offset ?? 0,
    state?.projection_progress?.facet_index?.built ?? 0,
    state?.projection_progress?.facet_index?.complete === true,
    state?.seen_identities.length ?? 0, state?.pending_path_effects?.offset ?? 0,
    state?.last_observer_status ?? null
  ]);
}
