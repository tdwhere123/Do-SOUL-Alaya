import {
  GraphNeighborSchema,
  MemoryGraphEdgeTypeSchema,
  EDGE_TYPE_RECALL_MODEL,
  GraphAuditorEventType,
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
import { CoreError } from "./errors.js";
import { parseObjectId } from "./shared/validators.js";

// invariant: soul.explore_graph reads the unified path plane, not
// memory_graph_edges. One-hop neighbors are PathRelation rows anchored on
// the source memory; relation_kind projects to the strict GraphNeighbor
// edge_type enum (mapRelationKindToGraphEdgeType) and path_id is the
// edge_id. countInbound* below also read the path plane: they count
// target-anchored recall-eligible paths (isPathRecallEligible) arriving at a
// candidate memory and feed recall graph_support scoring
// (RecallServiceGraphSupportPort). The result is positive-only: negative
// paths (recall_bias < 0) never contribute here — active suppression is the
// governance-gated recall-plane channel, not graph_support. Only `delete`
// still routes through the edge repo (the legacy edge table is read-dead for
// recall and retires with its repo).
export interface GraphExploreServicePathRepoPort {
  findByAnchors(
    workspaceId: string,
    anchorRefs: readonly PathAnchorRef[]
  ): Promise<readonly Readonly<PathRelation>[]>;
  findByTargetAnchor(
    workspaceId: string,
    anchorRef: PathAnchorRef
  ): Promise<readonly Readonly<PathRelation>[]>;
}

export interface GraphExploreServiceEdgeRepoPort {
  // invariant: edge writes do not enter through GraphExploreService, and
  // recall graph_support counts no longer read the edge repo (they read the
  // path plane via pathRepo). `delete` is the only remaining edge-repo touch
  // on this service and retires with the edge subsystem.
  delete(edgeId: string): Promise<void>;
}

export interface GraphExploreServiceEventLogRepoPort {
  append(entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry | Promise<EventLogEntry>;
}

export interface GraphExploreServiceDependencies {
  readonly pathRepo: GraphExploreServicePathRepoPort;
  readonly edgeRepo: GraphExploreServiceEdgeRepoPort;
  readonly eventLogRepo: GraphExploreServiceEventLogRepoPort;
  readonly now?: () => string;
}

export interface GraphExploreOptions {
  readonly edgeTypes?: readonly MemoryGraphEdgeTypeValue[];
  readonly direction?: GraphExploreDir;
  readonly runId?: string | null;
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
    const parsedMemoryId = parseObjectId(memoryId);
    const parsedWorkspaceId = parseObjectId(workspaceId);
    const parsedDirection = options.direction ?? "both";
    const parsedEdgeTypes = options.edgeTypes?.map(parseMemoryGraphEdgeType);
    const edgeTypeFilter = parsedEdgeTypes === undefined ? null : new Set(parsedEdgeTypes);

    const relations = await this.dependencies.pathRepo.findByAnchors(parsedWorkspaceId, [
      { kind: "object", object_id: parsedMemoryId }
    ]);

    const neighbors = relations.flatMap((relation): GraphNeighbor[] => {
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
      if (sourceId === parsedMemoryId && (parsedDirection === "outbound" || parsedDirection === "both")) {
        return [
          GraphNeighborSchema.parse({
            memory_id: targetId,
            edge_type: edgeType,
            direction: "outbound",
            edge_id: relation.path_id
          })
        ];
      }
      if (targetId === parsedMemoryId && (parsedDirection === "inbound" || parsedDirection === "both")) {
        return [
          GraphNeighborSchema.parse({
            memory_id: sourceId,
            edge_type: edgeType,
            direction: "inbound",
            edge_id: relation.path_id
          })
        ];
      }
      return [];
    });

    if (neighbors.length === 0) {
      return Object.freeze(neighbors);
    }

    await this.dependencies.eventLogRepo.append({
      event_type: GraphAuditorEventType.SOUL_GRAPH_EXPLORE_COMPLETED,
      entity_type: "memory_entry",
      entity_id: parsedMemoryId,
      workspace_id: parsedWorkspaceId,
      run_id: options.runId ?? null,
      caused_by: "system",
      payload_json: SoulGraphExploreCompletedPayloadSchema.parse({
        exploration_kind: "memory_neighbors",
        source_memory_id: parsedMemoryId,
        workspace_id: parsedWorkspaceId,
        direction: parsedDirection,
        neighbor_count: neighbors.length,
        occurred_at: this.now()
      })
    });

    return Object.freeze(neighbors);
  }

  /** @deprecated use `countInboundEdgesWeighted` for recall scoring;
   * retained for diagnostic surfaces only. */
  public async countInboundSupports(memoryId: string, workspaceId: string): Promise<number> {
    const paths = await this.findInboundRecallEligiblePaths(memoryId, workspaceId);
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
  // is intentionally NOT governance-gated — findInboundRecallEligiblePaths
  // filters only on active + recall_bias > 0, never on governance_class —
  // while negative-path suppression IS governance-gated (recall-service.ts).
  // Rationale: suppression can ERASE a true memory (high harm, so gated);
  // positive amplification only NUDGES and is self-limiting (the consuming
  // factor is clamped by normalizeGraphSupport to [0,3]/3 = max 1.0, then
  // scaled by a small graph_support weight), and is the intended Hebbian
  // recall mechanism. The asymmetry is by design, not an oversight.
  public async countInboundEdgesWeighted(memoryId: string, workspaceId: string): Promise<number> {
    const paths = await this.findInboundRecallEligiblePaths(memoryId, workspaceId);
    return paths.reduce((sum, path) => {
      const edgeType = mapRelationKindToGraphEdgeType(path.constitution.relation_kind);
      return sum + EDGE_TYPE_RECALL_MODEL[edgeType].contribution_weight;
    }, 0);
  }

  // The edge world counted literal edge_type='recalls'; on the path plane this
  // counts paths whose mapped edge_type === "recalls", so the recalls-tier
  // associative kinds (co_recalled / shares_entity / signal_graph_ref) that
  // mapRelationKindToGraphEdgeType folds to "recalls" now also count here. This
  // is mapper-consistent with countInboundEdgesWeighted (one mapper, one
  // semantic) and feeds the RECALLS_EDGE_COLD_THRESHOLD cold-start signal.
  public async countInboundRecalls(memoryId: string, workspaceId: string): Promise<number> {
    const paths = await this.findInboundRecallEligiblePaths(memoryId, workspaceId);
    return paths.reduce(
      (count, path) =>
        mapRelationKindToGraphEdgeType(path.constitution.relation_kind) === "recalls" ? count + 1 : count,
      0
    );
  }

  // Inbound = paths whose TARGET anchor is the candidate memory. Filtered to
  // recall-eligible (active lifecycle AND recall_bias > 0) so graph_support is
  // positive-only; negative paths are handled solely by the governance-gated
  // active-suppression channel in recall-service.ts.
  private async findInboundRecallEligiblePaths(
    memoryId: string,
    workspaceId: string
  ): Promise<readonly Readonly<PathRelation>[]> {
    const paths = await this.dependencies.pathRepo.findByTargetAnchor(parseObjectId(workspaceId), {
      kind: "object",
      object_id: parseObjectId(memoryId)
    });
    return paths.filter((path) => isPathRecallEligible(path));
  }

  public async deleteEdge(edgeId: string): Promise<void> {
    await this.dependencies.edgeRepo.delete(parseObjectId(edgeId));
  }
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
