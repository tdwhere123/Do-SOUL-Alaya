import {
  PathGraphSnapshotSchema,
  serializePathAnchorRef,
  type PathGraphSnapshot,
  type PathRelation
} from "@do-soul/alaya-protocol";
import { deepFreeze } from "../shared/deep-freeze.js";

export interface PathGraphSnapshotterDependencies {
  readonly pathRelationRepo: {
    findActive(workspaceId: string): Promise<readonly Readonly<PathRelation>[]>;
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
    const relations = await this.deps.pathRelationRepo.findActive(workspaceId);
    const snapshotAt = this.now().toISOString();
    const metrics = summarizePathRelations(relations, previousSnapshot);
    const retiredMetrics = buildReservedRetiredMetrics();

    return freezeSnapshot(
      PathGraphSnapshotSchema.parse({
        snapshot_id: `path-graph-snapshot:${workspaceId}:${snapshotAt}`,
        workspace_id: workspaceId,
        total_active_paths: metrics.total_active_paths,
        total_retired_paths: retiredMetrics.total_retired_paths,
        strength_distribution: metrics.strength_distribution,
        stability_distribution: metrics.stability_distribution,
        governance_distribution: metrics.governance_distribution,
        connectivity: metrics.connectivity,
        paths_reinforced_since_last: metrics.paths_reinforced_since_last,
        paths_weakened_since_last: metrics.paths_weakened_since_last,
        paths_retired_since_last: retiredMetrics.paths_retired_since_last,
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
  const previousSnapshotAt = previousSnapshot?.snapshot_at ?? null;
  const strength_distribution = {
    very_weak: 0,
    weak: 0,
    moderate: 0,
    strong: 0,
    very_strong: 0
  };
  const stability_distribution = {
    volatile: 0,
    normal: 0,
    stable: 0,
    pinned: 0
  };
  const governance_distribution = {
    hint_only: 0,
    attention_only: 0,
    recall_allowed: 0,
    strictly_governed: 0
  };
  const sourceCounts = new Map<string, number>();
  const targetCounts = new Map<string, number>();
  const anchorPathSets = new Map<string, Set<string>>();
  let paths_reinforced_since_last = 0;
  let paths_weakened_since_last = 0;
  let paths_created_since_last = 0;

  for (const relation of relations) {
    const strength = relation.plasticity_state.strength;
    if (strength < 0.2) {
      strength_distribution.very_weak += 1;
    } else if (strength < 0.4) {
      strength_distribution.weak += 1;
    } else if (strength < 0.6) {
      strength_distribution.moderate += 1;
    } else if (strength < 0.8) {
      strength_distribution.strong += 1;
    } else {
      strength_distribution.very_strong += 1;
    }

    stability_distribution[relation.plasticity_state.stability_class] += 1;
    governance_distribution[relation.legitimacy.governance_class] += 1;

    const sourceKey = serializePathAnchorRef(relation.anchors.source_anchor);
    const targetKey = serializePathAnchorRef(relation.anchors.target_anchor);

    sourceCounts.set(sourceKey, (sourceCounts.get(sourceKey) ?? 0) + 1);
    targetCounts.set(targetKey, (targetCounts.get(targetKey) ?? 0) + 1);

    addAnchorPath(anchorPathSets, sourceKey, relation.path_id);
    addAnchorPath(anchorPathSets, targetKey, relation.path_id);

    if (previousSnapshotAt === null) {
      paths_reinforced_since_last += 1;
      paths_weakened_since_last += 1;
      paths_created_since_last += 1;
      continue;
    }

    if (timestampIsAfter(relation.plasticity_state.last_reinforced_at, previousSnapshotAt)) {
      paths_reinforced_since_last += 1;
    }
    if (timestampIsAfter(relation.plasticity_state.last_weakened_at, previousSnapshotAt)) {
      paths_weakened_since_last += 1;
    }
    if (timestampIsAfter(relation.created_at, previousSnapshotAt)) {
      paths_created_since_last += 1;
    }
  }

  return {
    total_active_paths: relations.length,
    strength_distribution,
    stability_distribution,
    governance_distribution,
    connectivity: {
      unique_source_anchors: sourceCounts.size,
      unique_target_anchors: targetCounts.size,
      max_out_degree: maxMapValue(sourceCounts),
      max_in_degree: maxMapValue(targetCounts),
      isolated_anchors: countIsolatedAnchors(anchorPathSets)
    },
    paths_reinforced_since_last,
    paths_weakened_since_last,
    paths_created_since_last
  };
}

function timestampIsAfter(timestamp: string | undefined, previousSnapshotAt: string): boolean {
  return timestamp !== undefined && timestamp > previousSnapshotAt;
}

function buildReservedRetiredMetrics(): Pick<
  PathGraphSnapshot,
  "total_retired_paths" | "paths_retired_since_last"
> {
  // Retired counters stay zero until a live retirement producer reaches this path.
  return {
    total_retired_paths: 0,
    paths_retired_since_last: 0
  };
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
