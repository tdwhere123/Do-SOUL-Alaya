import {
  isPathRecallEligible,
  type MemoryEntry,
  type PathAnchorRef,
  type PathRelation
} from "@do-soul/alaya-protocol";
import {
  EDGE_TYPE_HOP_DECAY,
  graphTraversalScoreFromPath,
  type GraphExpansionCandidateDraft,
  type GraphExpansionFrontierNode
} from "./graph-expansion.js";
import { collectPathGraphNeighbors } from "./path-relations.js";
import { recordRecallDegradation } from "./diagnostics.js";
import { clamp01, errorNameOf, toErrorMessage } from "./recall-service-helpers.js";
import type {
  RecallServiceDependencies,
  RecallServiceWarnPort
} from "./recall-service-types.js";

type ExpandGraphFrontierParams = Readonly<{
  readonly workspaceId: string;
  readonly byId: ReadonlyMap<string, Readonly<MemoryEntry>>;
  readonly pathExpansionPort: NonNullable<RecallServiceDependencies["pathExpansionPort"]>;
  readonly seedEntries: readonly Readonly<MemoryEntry>[];
  readonly maxGraphHops: number;
  readonly dynamicRecallEdgeFanout: number;
  readonly warn: RecallServiceWarnPort;
  readonly degradationReasons?: Set<import("./recall-service-types.js").RecallDegradationReason>;
  readonly onCandidate: (candidate: Readonly<GraphExpansionCandidateDraft>) => void;
}>;

export async function expandGraphFrontier(params: ExpandGraphFrontierParams): Promise<void> {
  if (params.seedEntries.length === 0) {
    return;
  }
  const expandedIds = new Set<string>();
  let frontier = createInitialGraphFrontier(params.seedEntries);

  for (let hop = 1; hop <= params.maxGraphHops && frontier.length > 0; hop += 1) {
    const frontierIds = collectFrontierIdsToExpand(frontier, expandedIds);
    if (frontierIds.length === 0) {
      break;
    }
    const eligiblePaths = await loadEligibleGraphExpansionPaths(params, frontierIds);
    if (eligiblePaths === null) {
      break;
    }
    frontier = expandGraphFrontierHop(
      params,
      frontier,
      eligiblePaths,
      expandedIds,
      frontierIds,
      hop as 1 | 2
    );
  }
}

function createInitialGraphFrontier(
  seedEntries: readonly Readonly<MemoryEntry>[]
): readonly GraphExpansionFrontierNode[] {
  return seedEntries.map((entry) => ({
    memoryId: entry.object_id,
    pathScore: 1,
    arrivalRelationKind: null
  }));
}

function collectFrontierIdsToExpand(
  frontier: readonly GraphExpansionFrontierNode[],
  expandedIds: ReadonlySet<string>
): readonly string[] {
  return frontier
    .map((node) => node.memoryId)
    .filter((memoryId) => !expandedIds.has(memoryId));
}

async function loadEligibleGraphExpansionPaths(
  params: Readonly<{
    readonly workspaceId: string;
    readonly pathExpansionPort: NonNullable<RecallServiceDependencies["pathExpansionPort"]>;
    readonly warn: RecallServiceWarnPort;
    readonly degradationReasons?: Set<import("./recall-service-types.js").RecallDegradationReason>;
  }>,
  frontierIds: readonly string[]
): Promise<readonly Readonly<PathRelation>[] | null> {
  const anchorRefs: PathAnchorRef[] = frontierIds.map((object_id) => ({
    kind: "object",
    object_id
  }));
  try {
    const paths = await params.pathExpansionPort.findByAnchors(params.workspaceId, anchorRefs);
    return paths.filter((path) => isPathRecallEligible(path));
  } catch (error) {
    recordRecallDegradation(params, "graph_expansion_failed");
    params.warn("graph expansion path lookup failed", {
      workspace_id: params.workspaceId,
      seed_count: frontierIds.length,
      operation: "graph_expansion_path_lookup",
      errorName: errorNameOf(error),
      error: toErrorMessage(error)
    });
    return null;
  }
}

function expandGraphFrontierHop(
  params: ExpandGraphFrontierParams,
  frontier: readonly GraphExpansionFrontierNode[],
  eligiblePaths: readonly Readonly<PathRelation>[],
  expandedIds: Set<string>,
  frontierIds: readonly string[],
  hop: 1 | 2
): readonly GraphExpansionFrontierNode[] {
  const nextFrontier = new Map<string, GraphExpansionFrontierNode>();
  const frontierIdSet = new Set(frontierIds);
  for (const node of frontier) {
    expandGraphFrontierNode(
      params,
      node,
      hop,
      eligiblePaths,
      expandedIds,
      frontierIdSet,
      nextFrontier
    );
  }
  return [...nextFrontier.values()].sort((left, right) => left.memoryId.localeCompare(right.memoryId));
}

function expandGraphFrontierNode(
  params: ExpandGraphFrontierParams,
  node: GraphExpansionFrontierNode,
  hop: 1 | 2,
  eligiblePaths: readonly Readonly<PathRelation>[],
  expandedIds: Set<string>,
  frontierIdSet: ReadonlySet<string>,
  nextFrontier: Map<string, GraphExpansionFrontierNode>
): void {
  if (expandedIds.has(node.memoryId)) {
    return;
  }
  expandedIds.add(node.memoryId);
  const nodeNeighbors = collectPathGraphNeighbors(eligiblePaths, node.memoryId)
    .slice(0, params.dynamicRecallEdgeFanout);
  for (const neighbor of nodeNeighbors) {
    const candidate = buildGraphExpansionCandidate(params.byId, node, neighbor, hop, expandedIds);
    if (candidate === null) {
      continue;
    }
    params.onCandidate(candidate);
    queueGraphFrontierNeighbor(
      params.maxGraphHops,
      frontierIdSet,
      expandedIds,
      nextFrontier,
      neighbor.neighborId,
      candidate.score,
      neighbor.relationKind,
      hop
    );
  }
}

function buildGraphExpansionCandidate(
  byId: ReadonlyMap<string, Readonly<MemoryEntry>>,
  node: GraphExpansionFrontierNode,
  neighbor: ReturnType<typeof collectPathGraphNeighbors>[number],
  hop: 1 | 2,
  expandedIds: ReadonlySet<string>
): Readonly<GraphExpansionCandidateDraft> | null {
  const edgeScore = graphTraversalScoreFromPath(neighbor.edgeType) * neighbor.weight;
  if (edgeScore <= 0 || expandedIds.has(neighbor.neighborId)) {
    return null;
  }
  const entry = byId.get(neighbor.neighborId);
  if (entry === undefined) {
    return null;
  }
  if (hop > 1 && node.arrivalRelationKind !== null && neighbor.relationKind === node.arrivalRelationKind) {
    return null;
  }
  const score = hop === 1
    ? edgeScore
    : clamp01(node.pathScore * EDGE_TYPE_HOP_DECAY[neighbor.edgeType] * edgeScore);
  if (score <= 0) {
    return null;
  }
  return Object.freeze({
    entry,
    score,
    hop,
    edgeType: neighbor.edgeType
  });
}

function queueGraphFrontierNeighbor(
  maxGraphHops: number,
  frontierIdSet: ReadonlySet<string>,
  expandedIds: ReadonlySet<string>,
  nextFrontier: Map<string, GraphExpansionFrontierNode>,
  neighborId: string,
  pathScore: number,
  relationKind: string,
  hop: 1 | 2
): void {
  if (hop >= maxGraphHops || expandedIds.has(neighborId) || frontierIdSet.has(neighborId)) {
    return;
  }
  const queued = nextFrontier.get(neighborId);
  if (queued === undefined || pathScore > queued.pathScore) {
    nextFrontier.set(neighborId, {
      memoryId: neighborId,
      pathScore,
      arrivalRelationKind: relationKind
    });
  }
}
