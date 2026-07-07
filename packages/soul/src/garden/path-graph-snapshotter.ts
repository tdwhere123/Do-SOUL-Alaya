import {
  PathGraphSnapshotSchema,
  serializePathAnchorRef,
  type PathGraphSnapshot,
  type PathRelation
} from "@do-soul/alaya-protocol";
import { deepFreeze } from "../shared/deep-freeze.js";

export interface PathGraphSnapshotterDependencies {
  readonly pathRelationRepo: {
    findActiveAll(workspaceId: string): Promise<readonly Readonly<PathRelation>[]>;
  };
  readonly now?: () => Date;
}

export interface PathGraphSnapshotHistoryReview {
  readonly summary: string;
  readonly detail_json: {
    readonly latest_snapshot_id: string;
    readonly previous_snapshot_id: string;
    readonly latest_snapshot_at: string;
    readonly previous_snapshot_at: string;
    readonly isolated_anchor_delta: number;
    readonly isolated_anchor_count: number;
    readonly total_active_paths: number;
  };
}

export class PathGraphSnapshotter {
  private readonly now: () => Date;

  public constructor(private readonly deps: PathGraphSnapshotterDependencies) {
    this.now = deps.now ?? (() => new Date());
  }

  public async buildSnapshot(
    workspaceId: string,
    previousSnapshot: Readonly<PathGraphSnapshot> | null = null
  ): Promise<Readonly<PathGraphSnapshot>> {
    const relations = await this.deps.pathRelationRepo.findActiveAll(workspaceId);
    const snapshotAt = this.now().toISOString();
    const metrics = summarizePathRelations(relations, previousSnapshot);

    return freezeSnapshot(
      PathGraphSnapshotSchema.parse({
        snapshot_id: `path-graph-snapshot:${workspaceId}:${snapshotAt}`,
        workspace_id: workspaceId,
        total_active_paths: metrics.total_active_paths,
        strength_distribution: metrics.strength_distribution,
        stability_distribution: metrics.stability_distribution,
        governance_distribution: metrics.governance_distribution,
        connectivity: metrics.connectivity,
        paths_reinforced_since_last: metrics.paths_reinforced_since_last,
        paths_weakened_since_last: metrics.paths_weakened_since_last,
        paths_created_since_last: metrics.paths_created_since_last,
        snapshot_at: snapshotAt
      })
    );
  }
}

export function reviewPathGraphSnapshotHistory(
  workspaceId: string,
  history: readonly Readonly<PathGraphSnapshot>[]
): Readonly<PathGraphSnapshotHistoryReview> | null {
  if (history.length < 2) {
    return null;
  }

  const [latestSnapshot, previousSnapshot] = history;
  if (latestSnapshot === undefined || previousSnapshot === undefined) {
    return null;
  }
  const isolatedAnchorDelta =
    latestSnapshot.connectivity.isolated_anchors - previousSnapshot.connectivity.isolated_anchors;

  if (isolatedAnchorDelta <= 0) {
    return null;
  }

  return deepFreeze({
    summary: `Path graph isolation drift detected for ${workspaceId}`,
    detail_json: {
      latest_snapshot_id: latestSnapshot.snapshot_id,
      previous_snapshot_id: previousSnapshot.snapshot_id,
      latest_snapshot_at: latestSnapshot.snapshot_at,
      previous_snapshot_at: previousSnapshot.snapshot_at,
      isolated_anchor_delta: isolatedAnchorDelta,
      isolated_anchor_count: latestSnapshot.connectivity.isolated_anchors,
      total_active_paths: latestSnapshot.total_active_paths
    }
  });
}

function summarizePathRelations(
  relations: readonly Readonly<PathRelation>[],
  previousSnapshot: Readonly<PathGraphSnapshot> | null
): Pick<
  PathGraphSnapshot,
  | "total_active_paths"
  | "strength_distribution"
  | "stability_distribution"
  | "governance_distribution"
  | "connectivity"
  | "paths_reinforced_since_last"
  | "paths_weakened_since_last"
  | "paths_created_since_last"
> {
  const state = createPathSummaryState(previousSnapshot);
  for (const relation of relations) {
    recordPathStrength(state, relation);
    recordPathDistributions(state, relation);
    recordPathConnectivity(state, relation);
    recordPathChangeCounts(state, relation);
  }
  return {
    total_active_paths: relations.length,
    strength_distribution: state.strength_distribution,
    stability_distribution: state.stability_distribution,
    governance_distribution: state.governance_distribution,
    connectivity: {
      unique_source_anchors: state.sourceCounts.size,
      unique_target_anchors: state.targetCounts.size,
      max_out_degree: maxMapValue(state.sourceCounts),
      max_in_degree: maxMapValue(state.targetCounts),
      isolated_anchors: countIsolatedAnchors(state.anchorPathSets)
    },
    paths_reinforced_since_last: state.paths_reinforced_since_last,
    paths_weakened_since_last: state.paths_weakened_since_last,
    paths_created_since_last: state.paths_created_since_last
  };
}

interface PathSummaryState {
  readonly previousSnapshotAt: string | null;
  readonly strength_distribution: MutableStrengthDistribution;
  readonly stability_distribution: MutableStabilityDistribution;
  readonly governance_distribution: MutableGovernanceDistribution;
  readonly sourceCounts: Map<string, number>;
  readonly targetCounts: Map<string, number>;
  readonly anchorPathSets: Map<string, Set<string>>;
  paths_reinforced_since_last: number;
  paths_weakened_since_last: number;
  paths_created_since_last: number;
}

interface MutableStrengthDistribution {
  very_weak: number;
  weak: number;
  moderate: number;
  strong: number;
  very_strong: number;
}

interface MutableStabilityDistribution {
  volatile: number;
  normal: number;
  stable: number;
  pinned: number;
}

interface MutableGovernanceDistribution {
  hint_only: number;
  attention_only: number;
  recall_allowed: number;
  strictly_governed: number;
}

function createPathSummaryState(
  previousSnapshot: Readonly<PathGraphSnapshot> | null
): PathSummaryState {
  return {
    previousSnapshotAt: previousSnapshot?.snapshot_at ?? null,
    strength_distribution: {
      very_weak: 0,
      weak: 0,
      moderate: 0,
      strong: 0,
      very_strong: 0
    },
    stability_distribution: {
      volatile: 0,
      normal: 0,
      stable: 0,
      pinned: 0
    },
    governance_distribution: {
      hint_only: 0,
      attention_only: 0,
      recall_allowed: 0,
      strictly_governed: 0
    },
    sourceCounts: new Map<string, number>(),
    targetCounts: new Map<string, number>(),
    anchorPathSets: new Map<string, Set<string>>(),
    paths_reinforced_since_last: 0,
    paths_weakened_since_last: 0,
    paths_created_since_last: 0
  };
}

function recordPathStrength(
  state: PathSummaryState,
  relation: Readonly<PathRelation>
): void {
  const strength = relation.plasticity_state.strength;
  if (strength < 0.2) {
    state.strength_distribution.very_weak += 1;
  } else if (strength < 0.4) {
    state.strength_distribution.weak += 1;
  } else if (strength < 0.6) {
    state.strength_distribution.moderate += 1;
  } else if (strength < 0.8) {
    state.strength_distribution.strong += 1;
  } else {
    state.strength_distribution.very_strong += 1;
  }
}

function recordPathDistributions(
  state: PathSummaryState,
  relation: Readonly<PathRelation>
): void {
  state.stability_distribution[relation.plasticity_state.stability_class] += 1;
  state.governance_distribution[relation.legitimacy.governance_class] += 1;
}

function recordPathConnectivity(
  state: PathSummaryState,
  relation: Readonly<PathRelation>
): void {
  const sourceKey = serializePathAnchorRef(relation.anchors.source_anchor);
  const targetKey = serializePathAnchorRef(relation.anchors.target_anchor);
  state.sourceCounts.set(sourceKey, (state.sourceCounts.get(sourceKey) ?? 0) + 1);
  state.targetCounts.set(targetKey, (state.targetCounts.get(targetKey) ?? 0) + 1);
  addAnchorPath(state.anchorPathSets, sourceKey, relation.path_id);
  addAnchorPath(state.anchorPathSets, targetKey, relation.path_id);
}

function recordPathChangeCounts(
  state: PathSummaryState,
  relation: Readonly<PathRelation>
): void {
  if (state.previousSnapshotAt === null) {
    state.paths_reinforced_since_last += 1;
    state.paths_weakened_since_last += 1;
    state.paths_created_since_last += 1;
    return;
  }
  if (timestampIsAfter(relation.plasticity_state.last_reinforced_at, state.previousSnapshotAt)) {
    state.paths_reinforced_since_last += 1;
  }
  if (timestampIsAfter(relation.plasticity_state.last_weakened_at, state.previousSnapshotAt)) {
    state.paths_weakened_since_last += 1;
  }
  if (timestampIsAfter(relation.created_at, state.previousSnapshotAt)) {
    state.paths_created_since_last += 1;
  }
}

function timestampIsAfter(timestamp: string | undefined, previousSnapshotAt: string): boolean {
  return timestamp !== undefined && timestamp > previousSnapshotAt;
}

function addAnchorPath(anchorPathSets: Map<string, Set<string>>, anchorKey: string, pathId: string): void {
  const pathIds = anchorPathSets.get(anchorKey) ?? new Set<string>();
  pathIds.add(pathId);
  anchorPathSets.set(anchorKey, pathIds);
}

function maxMapValue(values: Map<string, number>): number {
  let max = 0;

  for (const value of values.values()) {
    if (value > max) {
      max = value;
    }
  }

  return max;
}

function countIsolatedAnchors(anchorPathSets: Map<string, Set<string>>): number {
  let isolated = 0;

  for (const pathIds of anchorPathSets.values()) {
    if (pathIds.size === 1) {
      isolated += 1;
    }
  }

  return isolated;
}

function freezeSnapshot(snapshot: PathGraphSnapshot): Readonly<PathGraphSnapshot> {
  return deepFreeze(snapshot);
}
