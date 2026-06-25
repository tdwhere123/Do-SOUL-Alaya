import { EDGE_TYPE_RECALL_MODEL, type MemoryEntry } from "@do-soul/alaya-protocol";
import { clamp01, compareMemoryEntries } from "./recall-service-helpers.js";
import type {
  RecallGraphExpansionDiagnostics,
  RecallGraphExpansionTrackedEdgeType,
  RecallMultiSeedGraphFanInDiagnostics
} from "./recall-service-types.js";

// invariant: membership equals EDGE_TYPE_RECALL_MODEL transitive rows; order is load-bearing (indexOf drives the edge_type tie-break), so the array stays explicit.
// see also: graph-expansion.ts shouldReplaceGraphExpansionCandidate, compareGraphExpansionCandidateDrafts.
export const GRAPH_EXPANSION_TRACKED_EDGE_TYPES: readonly RecallGraphExpansionTrackedEdgeType[] = [
  "derives_from",
  "recalls",
  "supports"
];
// Derived view of EDGE_TYPE_RECALL_MODEL.hop_decay over the transitive rows; only read at hop >= 2.
export const EDGE_TYPE_HOP_DECAY: Readonly<Record<RecallGraphExpansionTrackedEdgeType, number>> = Object.freeze(
  Object.fromEntries(
    GRAPH_EXPANSION_TRACKED_EDGE_TYPES.map((edgeType) => {
      const decay = EDGE_TYPE_RECALL_MODEL[edgeType].hop_decay;
      if (decay === null) {
        throw new Error(`graph-expansion tracked edge_type "${edgeType}" has null hop_decay in EDGE_TYPE_RECALL_MODEL`);
      }
      return [edgeType, decay];
    })
  ) as Record<RecallGraphExpansionTrackedEdgeType, number>
);
// invariant: traversal maps a path's free-string relation_kind onto EDGE_TYPE_RECALL_MODEL when it names a transitive edge type; path-only kinds (co_recalled/shares_entity/signal_graph_ref) fold onto the weakest recalls tier so they propagate at most one extra hop. Negative/neutral kinds never reach here (traversal follows only recall-eligible paths).
// see also: protocol/soul/memory-graph.ts EDGE_TYPE_RECALL_MODEL, path-graph/path-relation-proposal-service.ts seed catalog.
const PATH_ASSOCIATIVE_RELATION_KIND_FALLBACK: RecallGraphExpansionTrackedEdgeType = "recalls";
// invariant: earned multi-session fan-in carrier relation_kind (mirrors path-relation-proposal-service.ts CO_RECALLED_SEED_PROFILE.relationKind); minted only past the threshold-3 gate, so the structural reserve grants it a gold-blind exemption from the relevance gate. Other relation_kinds stay relevance-gated.
export const EARNED_CO_RECALLED_FANIN_RELATION_KIND = "co_recalled";
// Folds a path's free-string relation_kind onto the tracked edge-type set; unmapped kinds become recalls so the {derives_from, recalls, supports} diagnostic key set is preserved.
export function pathRelationKindToTrackedEdgeType(
  relationKind: string
): RecallGraphExpansionTrackedEdgeType {
  return GRAPH_EXPANSION_TRACKED_EDGE_TYPES.includes(relationKind as RecallGraphExpansionTrackedEdgeType)
    ? (relationKind as RecallGraphExpansionTrackedEdgeType)
    : PATH_ASSOCIATIVE_RELATION_KIND_FALLBACK;
}

export interface MutableGraphExpansionDiagnostics {
  readonly graph_expansion_plane_count_per_hop: [number, number];
  readonly graph_expansion_plane_count_per_edge_type: Record<RecallGraphExpansionTrackedEdgeType, number>;
  // invariant: 0 = pooled-seed only; 1+ = entity_seed fan-in ran. see also: recall-service.ts addGraphExpansionCandidates multi-seed branch.
  multi_seed_fan_in_distinct_seeds: number;
  // anchor: dedup_collisions counts every collision (not unique colliders); max-score reduction keeps one candidate.
  multi_seed_fan_in_dedup_collisions: number;
  // anchor: per-seed candidate counts (post-dedup, pre-cap); freezeGraphExpansionDiagnostics derives p50/p95.
  readonly multi_seed_fan_in_candidates_per_seed: number[];
}

export interface GraphExpansionFrontierNode {
  readonly memoryId: string;
  readonly pathScore: number;
  // Raw relation_kind traversed to reach this node (null for seed roots); hop>=2 drops a neighbor reached by the same kind to gate single-relation lineage floods. Keyed on raw kind so heterogeneous reach survives.
  readonly arrivalRelationKind: string | null;
}

export interface GraphExpansionCandidateDraft {
  readonly entry: Readonly<MemoryEntry>;
  readonly score: number;
  readonly hop: 1 | 2;
  readonly edgeType: RecallGraphExpansionTrackedEdgeType;
}

export interface GraphExpansionCandidateSourceDiagnostic {
  readonly hop: 1 | 2;
  readonly edgeType: RecallGraphExpansionTrackedEdgeType;
}

export interface GraphExpansionCandidatesResult {
  readonly diagnostics: Readonly<RecallGraphExpansionDiagnostics>;
  readonly candidateSources: ReadonlyMap<string, Readonly<GraphExpansionCandidateSourceDiagnostic>>;
}

// Traversal admission score magnitude for a PathRelation hop = EDGE_TYPE_RECALL_MODEL[edge].contribution_weight, floored at 0. Strength does NOT scale here — the caller folds strength into hop-1 via scorePathRelationExpansion.
// note: magnitude matches the static edge-era weight but topology is directed (collectPathGraphNeighbors follows direction_bias), not the retired undirected edge plane; aligned with the hop-1 direction filter on purpose.
// see also: path-relations.ts collectPathGraphNeighbors, directionEligiblePathExpansionTargets.
export function graphTraversalScoreFromPath(
  trackedEdgeType: RecallGraphExpansionTrackedEdgeType
): number {
  const weight = EDGE_TYPE_RECALL_MODEL[trackedEdgeType].contribution_weight;
  return clamp01(Math.max(0, weight));
}

export function createMutableGraphExpansionDiagnostics(): MutableGraphExpansionDiagnostics {
  return {
    graph_expansion_plane_count_per_hop: [0, 0],
    graph_expansion_plane_count_per_edge_type: {
      derives_from: 0,
      recalls: 0,
      supports: 0
    },
    multi_seed_fan_in_distinct_seeds: 0,
    multi_seed_fan_in_dedup_collisions: 0,
    multi_seed_fan_in_candidates_per_seed: []
  };
}

export function createEmptyGraphExpansionDiagnostics(): Readonly<RecallGraphExpansionDiagnostics> {
  return freezeGraphExpansionDiagnostics(createMutableGraphExpansionDiagnostics());
}

// anchor: percentile-of-sample helper for multi_seed_graph_fan_in diagnostics; linear interpolation matching numpy.percentile(method='linear') for cross-language reads.
function percentileOfSorted(samples: readonly number[], percentile: number): number {
  if (samples.length === 0) {
    return 0;
  }
  if (samples.length === 1) {
    return samples[0];
  }
  const rank = ((samples.length - 1) * percentile) / 100;
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) {
    return samples[lower];
  }
  const weight = rank - lower;
  return samples[lower] * (1 - weight) + samples[upper] * weight;
}

function freezeGraphExpansionDiagnostics(
  diagnostics: Readonly<MutableGraphExpansionDiagnostics>
): Readonly<RecallGraphExpansionDiagnostics> {
  const base = {
    graph_expansion_plane_count_per_hop: Object.freeze([
      diagnostics.graph_expansion_plane_count_per_hop[0],
      diagnostics.graph_expansion_plane_count_per_hop[1]
    ]) as RecallGraphExpansionDiagnostics["graph_expansion_plane_count_per_hop"],
    graph_expansion_plane_count_per_edge_type: Object.freeze({
      derives_from: diagnostics.graph_expansion_plane_count_per_edge_type.derives_from,
      recalls: diagnostics.graph_expansion_plane_count_per_edge_type.recalls,
      supports: diagnostics.graph_expansion_plane_count_per_edge_type.supports
    })
  };
  if (diagnostics.multi_seed_fan_in_distinct_seeds === 0) {
    return Object.freeze(base);
  }
  const sortedCounts = [...diagnostics.multi_seed_fan_in_candidates_per_seed].sort((a, b) => a - b);
  const fanIn: RecallMultiSeedGraphFanInDiagnostics = {
    distinct_seeds: diagnostics.multi_seed_fan_in_distinct_seeds,
    candidates_per_seed_p50: percentileOfSorted(sortedCounts, 50),
    candidates_per_seed_p95: percentileOfSorted(sortedCounts, 95),
    dedup_collisions: diagnostics.multi_seed_fan_in_dedup_collisions
  };
  return Object.freeze({
    ...base,
    multi_seed_graph_fan_in: Object.freeze(fanIn)
  });
}

export function freezeGraphExpansionCandidatesResult(
  diagnostics: Readonly<MutableGraphExpansionDiagnostics>,
  candidateSources: ReadonlyMap<string, Readonly<GraphExpansionCandidateSourceDiagnostic>>
): Readonly<GraphExpansionCandidatesResult> {
  return Object.freeze({
    diagnostics: freezeGraphExpansionDiagnostics(diagnostics),
    candidateSources: new Map(candidateSources)
  });
}

export function mergeGraphExpansionCandidateSources(
  current: ReadonlyMap<string, Readonly<GraphExpansionCandidateSourceDiagnostic>>,
  next: ReadonlyMap<string, Readonly<GraphExpansionCandidateSourceDiagnostic>>,
  nextCandidateIds: ReadonlySet<string>
): ReadonlyMap<string, Readonly<GraphExpansionCandidateSourceDiagnostic>> {
  const merged = new Map(current);
  for (const id of nextCandidateIds) {
    const source = next.get(id);
    if (source !== undefined) {
      merged.set(id, source);
    }
  }
  return merged;
}

export function mergeGraphExpansionScores(
  current: Readonly<Record<string, number>>,
  next: Readonly<Record<string, number>>,
  nextCandidateIds: ReadonlySet<string>
): Readonly<Record<string, number>> {
  const merged: Record<string, number> = { ...current };
  for (const id of nextCandidateIds) {
    const score = next[id];
    if (score !== undefined) {
      merged[id] = Math.max(merged[id] ?? 0, score);
    }
  }
  return Object.freeze(merged);
}

function summarizeGraphExpansionCandidateSources(
  sources: ReadonlyMap<string, Readonly<GraphExpansionCandidateSourceDiagnostic>>
): Readonly<RecallGraphExpansionDiagnostics> {
  const diagnostics = createMutableGraphExpansionDiagnostics();
  for (const source of sources.values()) {
    diagnostics.graph_expansion_plane_count_per_hop[source.hop - 1] += 1;
    diagnostics.graph_expansion_plane_count_per_edge_type[source.edgeType] += 1;
  }
  return freezeGraphExpansionDiagnostics(diagnostics);
}

// anchor: cascade merge for graph_expansion diagnostics; re-derives hop/edge_type counts from sources. multi_seed_graph_fan_in is not re-derivable, so the tier with more distinct_seeds wins. see also: recall-service.ts mergeCoarseFilters.
export function mergeGraphExpansionDiagnosticsAcrossCascade(params: Readonly<{
  readonly sources: ReadonlyMap<string, Readonly<GraphExpansionCandidateSourceDiagnostic>>;
  readonly currentFanIn?: Readonly<RecallMultiSeedGraphFanInDiagnostics>;
  readonly nextFanIn?: Readonly<RecallMultiSeedGraphFanInDiagnostics>;
}>): Readonly<RecallGraphExpansionDiagnostics> {
  const summary = summarizeGraphExpansionCandidateSources(params.sources);
  const chosenFanIn = chooseStrongerFanIn(params.currentFanIn, params.nextFanIn);
  if (chosenFanIn === undefined) {
    return summary;
  }
  return Object.freeze({
    ...summary,
    multi_seed_graph_fan_in: chosenFanIn
  });
}

function chooseStrongerFanIn(
  left: Readonly<RecallMultiSeedGraphFanInDiagnostics> | undefined,
  right: Readonly<RecallMultiSeedGraphFanInDiagnostics> | undefined
): Readonly<RecallMultiSeedGraphFanInDiagnostics> | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  return right.distinct_seeds > left.distinct_seeds ? right : left;
}

export function shouldReplaceGraphExpansionCandidate(
  candidate: Readonly<GraphExpansionCandidateDraft>,
  current: Readonly<GraphExpansionCandidateDraft>
): boolean {
  if (candidate.score !== current.score) {
    return candidate.score > current.score;
  }
  if (candidate.hop !== current.hop) {
    return candidate.hop < current.hop;
  }
  const edgeTypeOrder =
    GRAPH_EXPANSION_TRACKED_EDGE_TYPES.indexOf(candidate.edgeType) -
    GRAPH_EXPANSION_TRACKED_EDGE_TYPES.indexOf(current.edgeType);
  if (edgeTypeOrder !== 0) {
    return edgeTypeOrder < 0;
  }
  return compareMemoryEntries(candidate.entry, current.entry) < 0;
}

export function compareGraphExpansionCandidateDrafts(
  left: Readonly<GraphExpansionCandidateDraft>,
  right: Readonly<GraphExpansionCandidateDraft>
): number {
  if (left.hop !== right.hop) {
    return left.hop - right.hop;
  }
  if (left.score !== right.score) {
    return right.score - left.score;
  }
  const edgeTypeOrder =
    GRAPH_EXPANSION_TRACKED_EDGE_TYPES.indexOf(left.edgeType) -
    GRAPH_EXPANSION_TRACKED_EDGE_TYPES.indexOf(right.edgeType);
  if (edgeTypeOrder !== 0) {
    return edgeTypeOrder;
  }
  return compareMemoryEntries(left.entry, right.entry);
}
