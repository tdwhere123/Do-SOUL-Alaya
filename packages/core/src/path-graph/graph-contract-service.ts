import { countStronglyConnectedComponents } from "@do-soul/alaya-graph-algorithms";
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
  findActiveAll(workspaceId: string): Promise<readonly Readonly<PathRelation>[]>;
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
    const relations = await this.dependencies.pathRelationRepo.findActiveAll(workspaceId);
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
    } catch (error) {
      // Optional history: the projection still returns without it; surface the swallow.
      process.emitWarning("[GraphContractService] optional snapshot-history read failed", {
        code: "ALAYA_GRAPH_CONTRACT_HISTORY_READ_FAILED",
        detail: JSON.stringify({
          workspace_id: workspaceId,
          error: error instanceof Error ? error.message : String(error)
        })
      });
      return undefined;
    }
  }
}

function buildPathGraph(relations: readonly Readonly<PathRelation>[]): BuiltPathGraph {
  const nodesByKey = new Map<string, NodeAccumulator>();
  const adjacency = new Map<string, Set<string>>();
  const edges = relations.map((relation) =>
    buildPathGraphEdge({
      relation,
      nodesByKey,
      adjacency
    })
  );
  const nodes = materializePathGraphNodes(nodesByKey);

  return {
    nodes,
    edges,
    topology: buildPathGraphTopology(nodes, relations.length, [...nodesByKey.keys()], adjacency)
  };
}

function buildPathGraphEdge(params: Readonly<{
  readonly relation: Readonly<PathRelation>;
  readonly nodesByKey: Map<string, NodeAccumulator>;
  readonly adjacency: Map<string, Set<string>>;
}>): SoulPathGraphContract["edges"][number] {
  const sourceId = serializePathAnchorRef(params.relation.anchors.source_anchor);
  const targetId = serializePathAnchorRef(params.relation.anchors.target_anchor);
  const source = getOrCreateNode(params.nodesByKey, sourceId, params.relation.anchors.source_anchor);
  const target = getOrCreateNode(params.nodesByKey, targetId, params.relation.anchors.target_anchor);
  source.out_degree += 1;
  target.in_degree += 1;
  recordAdjacencyEdge(params.adjacency, sourceId, targetId);
  return {
    id: params.relation.path_id,
    source_id: sourceId,
    target_id: targetId,
    source_anchor: params.relation.anchors.source_anchor,
    target_anchor: params.relation.anchors.target_anchor,
    relation_kind: params.relation.constitution.relation_kind,
    strength: params.relation.plasticity_state.strength,
    direction_bias: params.relation.plasticity_state.direction_bias,
    stability_class: params.relation.plasticity_state.stability_class,
    governance_class: params.relation.legitimacy.governance_class,
    effect_vector: params.relation.effect_vector,
    relation: params.relation,
    created_at: params.relation.created_at,
    updated_at: params.relation.updated_at
  };
}

function recordAdjacencyEdge(
  adjacency: Map<string, Set<string>>,
  sourceId: string,
  targetId: string
): void {
  const neighbors = adjacency.get(sourceId) ?? new Set<string>();
  neighbors.add(targetId);
  adjacency.set(sourceId, neighbors);
  if (!adjacency.has(targetId)) {
    adjacency.set(targetId, new Set<string>());
  }
}

function materializePathGraphNodes(
  nodesByKey: ReadonlyMap<string, Readonly<NodeAccumulator>>
): readonly SoulPathGraphContract["nodes"][number][] {
  return [...nodesByKey.values()].map((node) => ({
    id: node.id,
    anchor: node.anchor,
    label: node.id,
    out_degree: node.out_degree,
    in_degree: node.in_degree
  }));
}

function buildPathGraphTopology(
  nodes: readonly SoulPathGraphContract["nodes"][number][],
  totalEdges: number,
  nodeKeys: readonly string[],
  adjacency: ReadonlyMap<string, ReadonlySet<string>>
): SoulPathGraphContract["topology"] {
  const totalNodes = nodes.length;
  const totalDegree = nodes.reduce((sum, node) => sum + node.out_degree + node.in_degree, 0);
  return {
    total_nodes: totalNodes,
    total_edges: totalEdges,
    max_out_degree: maxValue(nodes.map((node) => node.out_degree)),
    max_in_degree: maxValue(nodes.map((node) => node.in_degree)),
    avg_degree: totalNodes === 0 ? 0 : totalDegree / totalNodes,
    strongly_connected_components: countStronglyConnectedComponents(
      nodeKeys,
      adjacency,
      "GraphContractService"
    )
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
