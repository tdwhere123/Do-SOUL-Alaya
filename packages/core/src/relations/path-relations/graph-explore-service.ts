import {
  GraphNeighborSchema,
  MemoryGraphEdgeTypeSchema,
  EDGE_TYPE_RECALL_MODEL,
  GraphAuditorEventType,
  getPathAnchorBackingObjectId,
  isUnorderedPathRelationKind,
  SoulGraphExploreCompletedPayloadSchema,
  isPathActiveForRecall,
  isPathRecallEligible,
  mapRelationKindToGraphEdgeType,
  type EventLogEntry,
  type GraphExploreDir,
  type GraphNeighbor,
  type MemoryGraphEdgeTypeValue,
  type PathAnchorRef,
  type PathRelation
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import { parseObjectId } from "../../shared/validators.js";

// invariant: soul.explore_graph reads the unified path plane, not
// memory_graph_edges. One-hop neighbors are PathRelation rows anchored on
// the source memory; relation_kind projects to the strict GraphNeighbor
// edge_type enum (mapRelationKindToGraphEdgeType) and path_id is the
// edge_id. countInbound* below also read the path plane: directional paths
// contribute at their target, while unordered semantic paths contribute at
// both endpoints, and feed recall graph_support scoring
// (RecallServiceGraphSupportPort). The result is positive-only: negative
// paths (recall_bias < 0) never contribute here — active suppression is the
// governance-gated recall-plane channel, not graph_support. This service is
// path-only: it has no edge repo and exposes no edge-write surface.
export interface GraphExploreServicePathRepoPort {
  findByAnchors(
    workspaceId: string,
    anchorRefs: readonly PathAnchorRef[]
  ): Promise<readonly Readonly<PathRelation>[]>;
  findByTargetAnchor(
    workspaceId: string,
    anchorRef: PathAnchorRef
  ): Promise<readonly Readonly<PathRelation>[]>;
  findByBackingObjectId(
    workspaceId: string,
    objectId: string
  ): Promise<readonly Readonly<PathRelation>[]>;
  findByBackingObjectIds?(
    workspaceId: string,
    objectIds: readonly string[]
  ): Promise<readonly Readonly<PathRelation>[]>;
}

export interface GraphExploreServiceEventLogRepoPort {
  append(entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry | Promise<EventLogEntry>;
}

export interface GraphExploreServiceDependencies {
  readonly pathRepo: GraphExploreServicePathRepoPort;
  readonly eventLogRepo: GraphExploreServiceEventLogRepoPort;
  readonly now?: () => string;
}

export interface GraphExploreOptions {
  readonly edgeTypes?: readonly MemoryGraphEdgeTypeValue[];
  readonly direction?: GraphExploreDir;
  readonly runId?: string | null;
}

export interface InboundRecallMetrics {
  readonly weightedEdgeCount: number;
  readonly recallCount: number;
}

export class GraphExploreService {
  private readonly now: () => string;

  public constructor(private readonly dependencies: GraphExploreServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  public async exploreOneHop(
    memoryId: string,
    workspaceId: string,
    options: GraphExploreOptions = {}
  ): Promise<readonly GraphNeighbor[]> {
    const parsed = parseGraphExploreInput(memoryId, workspaceId, options);
    const relations = await this.dependencies.pathRepo.findByBackingObjectId(
      parsed.workspaceId,
      parsed.memoryId
    );
    const neighbors = buildGraphNeighbors(
      relations,
      parsed.memoryId,
      parsed.direction,
      parsed.edgeTypeFilter
    );
    if (neighbors.length === 0) {
      return Object.freeze(neighbors);
    }
    await this.appendGraphExploreEvent(parsed, neighbors.length, options.runId ?? null);
    return Object.freeze(neighbors);
  }

  private async appendGraphExploreEvent(
    parsed: Readonly<{
      readonly memoryId: string;
      readonly workspaceId: string;
      readonly direction: GraphExploreDir;
    }>,
    neighborCount: number,
    runId: string | null
  ): Promise<void> {
    await this.dependencies.eventLogRepo.append({
      event_type: GraphAuditorEventType.SOUL_GRAPH_EXPLORE_COMPLETED,
      entity_type: "memory_entry",
      entity_id: parsed.memoryId,
      workspace_id: parsed.workspaceId,
      run_id: runId,
      caused_by: "system",
      payload_json: SoulGraphExploreCompletedPayloadSchema.parse({
        exploration_kind: "memory_neighbors",
        source_memory_id: parsed.memoryId,
        workspace_id: parsed.workspaceId,
        direction: parsed.direction,
        neighbor_count: neighborCount,
        occurred_at: this.now()
      })
    });
  }

  /** @deprecated use `countInboundEdgesWeighted` for recall scoring;
   * retained for diagnostic surfaces only. */
  public async countInboundSupports(memoryId: string, workspaceId: string): Promise<number> {
    const paths = await this.findRecallContributionPaths(memoryId, workspaceId);
    return paths.reduce(
      (count, path) =>
        mapRelationKindToGraphEdgeType(path.constitution.relation_kind) === "supports" ? count + 1 : count,
      0
    );
  }

  // invariant: graph_support is 1:1 with the legacy edge world for the kinds
  // that world carried, PLUS the associative positive path families
  // (co_recalled / shares_entity / signal_graph_ref, which
  // mapRelationKindToGraphEdgeType folds to the `recalls` tier, weight 0.3)
  // now also count — the edge world never carried them. This is an intended
  // unification, not a pure zero-drift replacement.
  //
  // invariant (deliberate asymmetry): graph_support (positive amplification)
  // is intentionally NOT governance-gated — findRecallContributionPaths
  // filters only on active + recall_bias > 0, never on governance_class —
  // while negative-path suppression IS governance-gated (recall-service.ts).
  // Rationale: suppression can ERASE a true memory (high harm, so gated);
  // positive amplification only NUDGES and is self-limiting (the consuming
  // factor is clamped by normalizeGraphSupport to [0,3]/3 = max 1.0, then
  // scaled by a small graph_support weight), and is the intended Hebbian
  // recall mechanism. The asymmetry is by design, not an oversight.
  public async countInboundEdgesWeighted(memoryId: string, workspaceId: string): Promise<number> {
    const paths = await this.findRecallContributionPaths(memoryId, workspaceId);
    return paths.reduce((sum, path) => {
      const edgeType = mapRelationKindToGraphEdgeType(path.constitution.relation_kind);
      return sum + EDGE_TYPE_RECALL_MODEL[edgeType].contribution_weight;
    }, 0);
  }

  // The edge world counted literal edge_type='recalls'; on the path plane this
  // counts contributing paths whose mapped edge_type === "recalls", so the recalls-tier
  // associative kinds (co_recalled / shares_entity / signal_graph_ref) that
  // mapRelationKindToGraphEdgeType folds to "recalls" now also count here. This
  // is mapper-consistent with countInboundEdgesWeighted (one mapper, one
  // semantic) and feeds the RECALLS_EDGE_COLD_THRESHOLD cold-start signal.
  public async countInboundRecalls(memoryId: string, workspaceId: string): Promise<number> {
    const paths = await this.findRecallContributionPaths(memoryId, workspaceId);
    return paths.reduce(
      (count, path) =>
        mapRelationKindToGraphEdgeType(path.constitution.relation_kind) === "recalls" ? count + 1 : count,
      0
    );
  }

  public async countInboundRecallMetricsByMemoryId(
    memoryIds: readonly string[],
    workspaceId: string
  ): Promise<ReadonlyMap<string, Readonly<InboundRecallMetrics>>> {
    const parsedWorkspaceId = parseObjectId(workspaceId);
    const parsedMemoryIds = [...new Set(memoryIds.map((memoryId) => parseObjectId(memoryId)))];
    if (parsedMemoryIds.length === 0) {
      return new Map();
    }
    const paths = await this.findRecallContributionPathsBulk(parsedMemoryIds, parsedWorkspaceId);
    return buildInboundRecallMetrics(parsedMemoryIds, paths);
  }

  private async findRecallContributionPathsBulk(
    memoryIds: readonly string[],
    workspaceId: string
  ): Promise<readonly Readonly<PathRelation>[]> {
    const bulkReader = this.dependencies.pathRepo.findByBackingObjectIds;
    if (bulkReader !== undefined) {
      return await bulkReader.call(this.dependencies.pathRepo, workspaceId, memoryIds);
    }
    const pathGroups = await Promise.all(
      memoryIds.map((memoryId) =>
        this.dependencies.pathRepo.findByBackingObjectId(workspaceId, memoryId)
      )
    );
    return [...new Map(pathGroups.flat().map((path) => [path.path_id, path] as const)).values()];
  }

  // Directional relations contribute at their target; unordered semantic
  // relations contribute equally at both endpoints.
  private async findRecallContributionPaths(
    memoryId: string,
    workspaceId: string
  ): Promise<readonly Readonly<PathRelation>[]> {
    const parsedMemoryId = parseObjectId(memoryId);
    const paths = await this.dependencies.pathRepo.findByBackingObjectId(
      parseObjectId(workspaceId),
      parsedMemoryId
    );
    return [...new Map(paths
      .filter((path) => isPathRecallEligible(path))
      .filter((path) => pathContributesToObject(path, parsedMemoryId))
      .map((path) => [path.path_id, path] as const)).values()];
  }
}

function buildInboundRecallMetrics(
  memoryIds: readonly string[],
  paths: readonly Readonly<PathRelation>[]
): ReadonlyMap<string, Readonly<InboundRecallMetrics>> {
  const metrics = new Map<string, { weightedEdgeCount: number; recallCount: number }>(
    memoryIds.map((memoryId) => [memoryId, { weightedEdgeCount: 0, recallCount: 0 }])
  );
  for (const path of new Map(paths.map((entry) => [entry.path_id, entry] as const)).values()) {
    if (!isPathRecallEligible(path)) continue;
    const edgeType = mapRelationKindToGraphEdgeType(path.constitution.relation_kind);
    const weight = EDGE_TYPE_RECALL_MODEL[edgeType].contribution_weight;
    addPathMetrics(metrics, getPathAnchorBackingObjectId(path.anchors.target_anchor), weight, edgeType);
    if (isUnorderedPathRelationKind(path.constitution.relation_kind)) {
      const sourceId = getPathAnchorBackingObjectId(path.anchors.source_anchor);
      const targetId = getPathAnchorBackingObjectId(path.anchors.target_anchor);
      if (sourceId !== targetId) addPathMetrics(metrics, sourceId, weight, edgeType);
    }
  }
  return new Map([...metrics].map(([memoryId, value]) => [memoryId, Object.freeze(value)]));
}

function addPathMetrics(
  metrics: Map<string, { weightedEdgeCount: number; recallCount: number }>,
  memoryId: string | null,
  weight: number,
  edgeType: MemoryGraphEdgeTypeValue
): void {
  if (memoryId === null) return;
  const current = metrics.get(memoryId);
  if (current === undefined) return;
  current.weightedEdgeCount += weight;
  if (edgeType === "recalls") current.recallCount += 1;
}

function pathContributesToObject(path: Readonly<PathRelation>, objectId: string): boolean {
  const targetId = getPathAnchorBackingObjectId(path.anchors.target_anchor);
  if (targetId === objectId) return true;
  return isUnorderedPathRelationKind(path.constitution.relation_kind) &&
    getPathAnchorBackingObjectId(path.anchors.source_anchor) === objectId;
}

function parseGraphExploreInput(
  memoryId: string,
  workspaceId: string,
  options: GraphExploreOptions
): Readonly<{
  readonly memoryId: string;
  readonly workspaceId: string;
  readonly direction: GraphExploreDir;
  readonly edgeTypeFilter: ReadonlySet<MemoryGraphEdgeTypeValue> | null;
}> {
  const direction = options.direction ?? "both";
  const parsedEdgeTypes = options.edgeTypes?.map(parseMemoryGraphEdgeType);
  return Object.freeze({
    memoryId: parseObjectId(memoryId),
    workspaceId: parseObjectId(workspaceId),
    direction,
    edgeTypeFilter: parsedEdgeTypes === undefined ? null : new Set(parsedEdgeTypes)
  });
}

function buildGraphNeighbors(
  relations: readonly Readonly<PathRelation>[],
  memoryId: string,
  direction: GraphExploreDir,
  edgeTypeFilter: ReadonlySet<MemoryGraphEdgeTypeValue> | null
): readonly GraphNeighbor[] {
  return relations.flatMap((relation) =>
    buildGraphNeighborsForRelation(relation, memoryId, direction, edgeTypeFilter)
  );
}

function buildGraphNeighborsForRelation(
  relation: Readonly<PathRelation>,
  memoryId: string,
  direction: GraphExploreDir,
  edgeTypeFilter: ReadonlySet<MemoryGraphEdgeTypeValue> | null
): readonly GraphNeighbor[] {
  if (!isPathActiveForRecall(relation.lifecycle.status)) {
    return [];
  }
  const sourceId = anchorObjectId(relation.anchors.source_anchor);
  const targetId = anchorObjectId(relation.anchors.target_anchor);
  if (sourceId === undefined || targetId === undefined || sourceId === targetId) {
    return [];
  }
  const edgeType = mapRelationKindToGraphEdgeType(relation.constitution.relation_kind);
  if (edgeTypeFilter !== null && !edgeTypeFilter.has(edgeType)) {
    return [];
  }
  if (sourceId === memoryId && (direction === "outbound" || direction === "both")) {
    return [createGraphNeighbor(targetId, edgeType, "outbound", relation.path_id)];
  }
  if (targetId === memoryId && (direction === "inbound" || direction === "both")) {
    return [createGraphNeighbor(sourceId, edgeType, "inbound", relation.path_id)];
  }
  return [];
}

function createGraphNeighbor(
  memoryId: string,
  edgeType: MemoryGraphEdgeTypeValue,
  direction: "inbound" | "outbound",
  edgeId: string
): GraphNeighbor {
  return GraphNeighborSchema.parse({
    memory_id: memoryId,
    edge_type: edgeType,
    direction,
    edge_id: edgeId
  });
}

function parseMemoryGraphEdgeType(value: MemoryGraphEdgeTypeValue): MemoryGraphEdgeTypeValue {
  const result = MemoryGraphEdgeTypeSchema.safeParse(value);

  if (!result.success) {
    throw new CoreError("VALIDATION", "Invalid edge_type", { cause: result.error });
  }

  return result.data;
}

function anchorObjectId(anchor: PathAnchorRef): string | undefined {
  switch (anchor.kind) {
    case "object":
    case "object_facet":
      return anchor.object_id;
    case "obligation":
    case "risk_concern":
    case "time_concern":
      return anchor.source_object_id;
    default:
      return undefined;
  }
}
