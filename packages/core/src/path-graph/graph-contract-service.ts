import {
  SoulPathGraphContractSchema,
  serializePathAnchorRef,
  type PathGraphSnapshot,
  type PathRelation,
  type SoulPathGraphContract,
  type SoulPathGraphStrengthTrendDirection,
  type SoulPathGraphTrendDirection
} from "@do-soul/alaya-protocol";
import { deepFreeze } from "../shared/deep-freeze.js";

const GRAPH_CONTRACT_SNAPSHOT_HISTORY_LIMIT = 5;

export interface GraphContractServicePathRelationRepoPort {
  findActive(workspaceId: string): Promise<readonly Readonly<PathRelation>[]>;
}

export interface GraphContractServiceSnapshotHistoryPort {
  findHistory(
    workspaceId: string,
    limit: number
  ): Promise<readonly Readonly<PathGraphSnapshot>[]>;
}

export interface GraphContractServiceDependencies {
  readonly pathRelationRepo: GraphContractServicePathRelationRepoPort;
  readonly snapshotHistory?: GraphContractServiceSnapshotHistoryPort;
  readonly now?: () => Date;
}

interface NodeAccumulator {
  readonly id: string;
  readonly anchor: PathRelation["anchors"]["source_anchor"];
  out_degree: number;
  in_degree: number;
}

interface BuiltPathGraph {
  readonly nodes: readonly SoulPathGraphContract["nodes"][number][];
  readonly edges: readonly SoulPathGraphContract["edges"][number][];
  readonly topology: SoulPathGraphContract["topology"];
}

export class GraphContractService {
  private readonly now: () => Date;

  public constructor(private readonly dependencies: GraphContractServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  public async derive(workspaceId: string): Promise<Readonly<SoulPathGraphContract>> {
    const relations = await this.dependencies.pathRelationRepo.findActive(workspaceId);
    const built = buildPathGraph(relations);
    const generatedAt = this.now().toISOString();
    const snapshotTrend = await this.buildSnapshotTrend(workspaceId);

    return parseSoulPathGraphContract({
      contract_version: 1,
      workspace_id: workspaceId,
      generated_at: generatedAt,
      nodes: built.nodes,
      edges: built.edges,
      topology: built.topology,
      ...(snapshotTrend === undefined ? {} : { snapshot_trend: snapshotTrend })
    });
  }

  private async buildSnapshotTrend(
    workspaceId: string
  ): Promise<SoulPathGraphContract["snapshot_trend"] | undefined> {
    if (this.dependencies.snapshotHistory === undefined) {
      return undefined;
    }

    const history = await this.readOptionalHistory(workspaceId);
    if (history === undefined || history.length === 0) {
      return undefined;
    }

    const latest = history[0]!;
    const baseline = history.at(-1) ?? latest;

    return {
      snapshot_count: history.length,
      latest_snapshot_id: latest.snapshot_id,
      baseline_snapshot_id: baseline.snapshot_id,
      latest_snapshot_at: latest.snapshot_at,
      baseline_snapshot_at: baseline.snapshot_at,
      edge_count_trend: classifyEdgeTrend(latest.total_active_paths, baseline.total_active_paths),
      avg_strength_trend: classifyStrengthTrend(
        estimateAverageStrength(latest),
        estimateAverageStrength(baseline)
      ),
      latest_stability_distribution: latest.stability_distribution,
      latest_governance_distribution: latest.governance_distribution,
      latest_connectivity: latest.connectivity,
      activity_velocity: {
        paths_reinforced_since_last: latest.paths_reinforced_since_last,
        paths_weakened_since_last: latest.paths_weakened_since_last,
        paths_created_since_last: latest.paths_created_since_last
      },
      latest_snapshot: latest
    };
  }

  private async readOptionalHistory(
    workspaceId: string
  ): Promise<readonly Readonly<PathGraphSnapshot>[] | undefined> {
    try {
      return await this.dependencies.snapshotHistory?.findHistory(
        workspaceId,
        GRAPH_CONTRACT_SNAPSHOT_HISTORY_LIMIT
      );
    } catch {
      return undefined;
    }
  }
}

function buildPathGraph(relations: readonly Readonly<PathRelation>[]): BuiltPathGraph {
  const nodesByKey = new Map<string, NodeAccumulator>();
  const adjacency = new Map<string, Set<string>>();
  const edges = relations.map((relation) => {
    const sourceId = serializePathAnchorRef(relation.anchors.source_anchor);
    const targetId = serializePathAnchorRef(relation.anchors.target_anchor);
    const source = getOrCreateNode(nodesByKey, sourceId, relation.anchors.source_anchor);
    const target = getOrCreateNode(nodesByKey, targetId, relation.anchors.target_anchor);

    source.out_degree += 1;
    target.in_degree += 1;

    const neighbors = adjacency.get(sourceId) ?? new Set<string>();
    neighbors.add(targetId);
    adjacency.set(sourceId, neighbors);
    if (!adjacency.has(targetId)) {
      adjacency.set(targetId, new Set<string>());
    }

    return {
      id: relation.path_id,
      source_id: sourceId,
      target_id: targetId,
      source_anchor: relation.anchors.source_anchor,
      target_anchor: relation.anchors.target_anchor,
      relation_kind: relation.constitution.relation_kind,
      strength: relation.plasticity_state.strength,
      direction_bias: relation.plasticity_state.direction_bias,
      stability_class: relation.plasticity_state.stability_class,
      governance_class: relation.legitimacy.governance_class,
      effect_vector: relation.effect_vector,
      relation,
      created_at: relation.created_at,
      updated_at: relation.updated_at
    };
  });

  const nodes = [...nodesByKey.values()].map((node) => ({
    id: node.id,
    anchor: node.anchor,
    label: node.id,
    out_degree: node.out_degree,
    in_degree: node.in_degree
  }));
  const totalNodes = nodes.length;
  const totalEdges = relations.length;
  const maxOutDegree = maxValue(nodes.map((node) => node.out_degree));
  const maxInDegree = maxValue(nodes.map((node) => node.in_degree));
  const totalDegree = nodes.reduce((sum, node) => sum + node.out_degree + node.in_degree, 0);

  return {
    nodes,
    edges,
    topology: {
      total_nodes: totalNodes,
      total_edges: totalEdges,
      max_out_degree: maxOutDegree,
      max_in_degree: maxInDegree,
      avg_degree: totalNodes === 0 ? 0 : totalDegree / totalNodes,
      strongly_connected_components: countStronglyConnectedComponents(
        [...nodesByKey.keys()],
        adjacency
      )
    }
  };
}

function getOrCreateNode(
  nodesByKey: Map<string, NodeAccumulator>,
  id: string,
  anchor: PathRelation["anchors"]["source_anchor"]
): NodeAccumulator {
  const existing = nodesByKey.get(id);
  if (existing !== undefined) {
    return existing;
  }

  const created: NodeAccumulator = {
    id,
    anchor,
    out_degree: 0,
    in_degree: 0
  };
  nodesByKey.set(id, created);
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
          throw new Error("GraphContractService Tarjan invariant violated: stack underflow.");
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
      `GraphContractService Tarjan invariant violated: missing ${label} for ${nodeKey}.`
    );
  }

  return value;
}

function classifyEdgeTrend(latest: number, baseline: number): SoulPathGraphTrendDirection {
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
): SoulPathGraphStrengthTrendDirection {
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

function parseSoulPathGraphContract(
  value: SoulPathGraphContract
): Readonly<SoulPathGraphContract> {
  return deepFreeze(SoulPathGraphContractSchema.parse(value));
}
