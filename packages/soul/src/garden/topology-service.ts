import {
  TopologyExplorationResultSchema,
  TopologyTrendSchema,
  serializePathAnchorRef,
  type PathGraphSnapshot,
  type PathRelation,
  type TopologyExplorationResult,
  type TopologyStrengthTrendDirection,
  type TopologyTrend,
  type TopologyTrendDirection
} from "@do-soul/alaya-protocol";
import { deepFreeze } from "../shared/deep-freeze.js";

const TOPOLOGY_HISTORY_LIMIT = 5;

type SnapshotHistoryPort = {
  getHistory(workspaceId: string, limit: number): Promise<readonly Readonly<PathGraphSnapshot>[]>;
};

export interface TopologyServiceDependencies {
  readonly pathRelationRepo: {
    findActiveAll(workspaceId: string): Promise<readonly Readonly<PathRelation>[]>;
  };
  readonly snapshotHistory?: SnapshotHistoryPort;
  readonly now?: () => Date;
}

type NodeAccumulator = {
  out_degree: number;
  in_degree: number;
};

type BuiltTopology = {
  readonly totalNodes: number;
  readonly totalEdges: number;
  readonly maxOutDegree: number;
  readonly maxInDegree: number;
  readonly avgDegree: number;
  readonly stronglyConnectedComponents: number;
};

export class TopologyService {
  private readonly now: () => Date;

  public constructor(private readonly deps: TopologyServiceDependencies) {
    this.now = deps.now ?? (() => new Date());
  }

  public async explore(workspaceId: string): Promise<Readonly<TopologyExplorationResult>> {
    const relations = await this.deps.pathRelationRepo.findActiveAll(workspaceId);
    const built = buildTopology(relations);
    const exploredAt = this.now().toISOString();
    const trend = await this.buildTrend(workspaceId);

    return parseTopologyExplorationResult({
      exploration_id: `topology-explore:${workspaceId}:${exploredAt}`,
      workspace_id: workspaceId,
      total_nodes: built.totalNodes,
      total_edges: built.totalEdges,
      max_out_degree: built.maxOutDegree,
      max_in_degree: built.maxInDegree,
      avg_degree: built.avgDegree,
      strongly_connected_components: built.stronglyConnectedComponents,
      trend,
      explored_at: exploredAt
    });
  }

  private async buildTrend(workspaceId: string): Promise<Readonly<TopologyTrend> | undefined> {
    if (this.deps.snapshotHistory === undefined) {
      return undefined;
    }

    const history = await this.readOptionalHistory(workspaceId);
    if (history === undefined || history.length === 0) {
      return undefined;
    }

    const latest = history[0];
    const baseline = history.at(-1) ?? latest;

    return parseTopologyTrend({
      snapshot_count: history.length,
      edge_count_trend: classifyEdgeTrend(latest.total_active_paths, baseline.total_active_paths),
      avg_strength_trend: classifyStrengthTrend(
        estimateAverageStrength(latest),
        estimateAverageStrength(baseline)
      )
    });
  }

  private async readOptionalHistory(
    workspaceId: string
  ): Promise<readonly Readonly<PathGraphSnapshot>[] | undefined> {
    try {
      return await this.deps.snapshotHistory?.getHistory(workspaceId, TOPOLOGY_HISTORY_LIMIT);
    } catch {
      // C-5 snapshots are only an optional historical overlay for the C-10
      // derived view. If the overlay read fails, keep the topology projection
      // available from active PathRelation state and omit the trend block.
      return undefined;
    }
  }
}

function buildTopology(relations: readonly Readonly<PathRelation>[]): BuiltTopology {
  const nodesByKey = new Map<string, NodeAccumulator>();
  const adjacency = new Map<string, Set<string>>();
  for (const relation of relations) {
    const sourceKey = serializePathAnchorRef(relation.anchors.source_anchor);
    const targetKey = serializePathAnchorRef(relation.anchors.target_anchor);

    const source = getOrCreateNode(nodesByKey, sourceKey);
    const target = getOrCreateNode(nodesByKey, targetKey);

    source.out_degree += 1;
    target.in_degree += 1;

    const neighbors = adjacency.get(sourceKey) ?? new Set<string>();
    neighbors.add(targetKey);
    adjacency.set(sourceKey, neighbors);
    if (!adjacency.has(targetKey)) {
      adjacency.set(targetKey, new Set<string>());
    }
  }

  const nodes = [...nodesByKey.values()];
  const totalNodes = nodes.length;
  const totalEdges = relations.length;
  const maxOutDegree = maxValue(nodes.map((node) => node.out_degree));
  const maxInDegree = maxValue(nodes.map((node) => node.in_degree));
  const totalDegree = nodes.reduce((sum, node) => sum + node.out_degree + node.in_degree, 0);

  return {
    totalNodes,
    totalEdges,
    maxOutDegree,
    maxInDegree,
    avgDegree: totalNodes === 0 ? 0 : totalDegree / totalNodes,
    stronglyConnectedComponents: countStronglyConnectedComponents(
      [...nodesByKey.keys()],
      adjacency
    )
  };
}

function getOrCreateNode(
  nodesByKey: Map<string, NodeAccumulator>,
  key: string
): NodeAccumulator {
  const existing = nodesByKey.get(key);
  if (existing !== undefined) {
    return existing;
  }

  const created: NodeAccumulator = {
    out_degree: 0,
    in_degree: 0
  };
  nodesByKey.set(key, created);
  return created;
}

function maxValue(values: readonly number[]): number {
  let max = 0;

  for (const value of values) {
    if (value > max) {
      max = value;
    }
  }

  return max;
}

function countStronglyConnectedComponents(
  nodeKeys: readonly string[],
  adjacency: ReadonlyMap<string, ReadonlySet<string>>
): number {
  let index = 0;
  let componentCount = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();

  const strongConnect = (nodeKey: string): void => {
    indices.set(nodeKey, index);
    lowLinks.set(nodeKey, index);
    index += 1;
    stack.push(nodeKey);
    onStack.add(nodeKey);

    for (const neighbor of adjacency.get(nodeKey) ?? []) {
      if (!indices.has(neighbor)) {
        strongConnect(neighbor);
        lowLinks.set(
          nodeKey,
          Math.min(
            readTrackedNumber(lowLinks, nodeKey, "low-link"),
            readTrackedNumber(lowLinks, neighbor, "low-link")
          )
        );
      } else if (onStack.has(neighbor)) {
        lowLinks.set(
          nodeKey,
          Math.min(
            readTrackedNumber(lowLinks, nodeKey, "low-link"),
            readTrackedNumber(indices, neighbor, "index")
          )
        );
      }
    }

    if (
      readTrackedNumber(lowLinks, nodeKey, "low-link") ===
      readTrackedNumber(indices, nodeKey, "index")
    ) {
      componentCount += 1;
      while (stack.length > 0) {
        const candidate = stack.pop();
        if (candidate === undefined) {
          throw new Error("TopologyService Tarjan invariant violated: stack underflow.");
        }
        onStack.delete(candidate);
        if (candidate === nodeKey) {
          break;
        }
      }
    }
  };

  for (const nodeKey of nodeKeys) {
    if (!indices.has(nodeKey)) {
      strongConnect(nodeKey);
    }
  }

  return componentCount;
}

function readTrackedNumber(
  trackedValues: ReadonlyMap<string, number>,
  nodeKey: string,
  label: string
): number {
  const value = trackedValues.get(nodeKey);
  if (value === undefined) {
    throw new Error(
      `TopologyService Tarjan invariant violated: missing ${label} for ${nodeKey}.`
    );
  }

  return value;
}

function classifyEdgeTrend(latest: number, baseline: number): TopologyTrendDirection {
  if (latest > baseline) {
    return "growing";
  }
  if (latest < baseline) {
    return "shrinking";
  }
  return "stable";
}

function classifyStrengthTrend(
  latest: number,
  baseline: number
): TopologyStrengthTrendDirection {
  if (latest > baseline) {
    return "increasing";
  }
  if (latest < baseline) {
    return "decreasing";
  }
  return "stable";
}

function estimateAverageStrength(snapshot: Readonly<PathGraphSnapshot>): number {
  if (snapshot.total_active_paths === 0) {
    return 0;
  }

  const weightedStrength =
    snapshot.strength_distribution.very_weak * 0.1 +
    snapshot.strength_distribution.weak * 0.3 +
    snapshot.strength_distribution.moderate * 0.5 +
    snapshot.strength_distribution.strong * 0.7 +
    snapshot.strength_distribution.very_strong * 0.9;

  return weightedStrength / snapshot.total_active_paths;
}

function parseTopologyTrend(value: TopologyTrend): Readonly<TopologyTrend> {
  return deepFreeze(TopologyTrendSchema.parse(value));
}

function parseTopologyExplorationResult(
  value: TopologyExplorationResult
): Readonly<TopologyExplorationResult> {
  return deepFreeze(TopologyExplorationResultSchema.parse(value));
}
