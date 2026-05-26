import {
  GraphNeighborSchema,
  MemoryGraphEdgeTypeSchema,
  GraphAuditorEventType,
  SoulGraphExploreCompletedPayloadSchema,
  type EventLogEntry,
  type GraphExploreDir,
  type GraphNeighbor,
  type MemoryGraphEdge,
  type MemoryGraphEdgeTypeValue
} from "@do-soul/alaya-protocol";
import { CoreError } from "./errors.js";
import { parseObjectId } from "./shared/validators.js";

export interface GraphExploreServiceEdgeRepoPort {
  // invariant: edge writes do not enter through GraphExploreService.
  // Durable edges may only be created by `EdgeProposalService` accept
  // path; this port is read-only + delete here.
  findByMemoryId(
    memoryId: string,
    workspaceId: string,
    edgeTypes?: readonly MemoryGraphEdgeTypeValue[]
  ): Promise<readonly Readonly<MemoryGraphEdge>[]>;
  /** @deprecated use `countInboundEdgesWeighted`. Retained for
   * diagnostic surfaces that still need a raw supports-only count. */
  countInboundSupports(memoryId: string, workspaceId: string): Promise<number>;
  countInboundEdgesWeighted(memoryId: string, workspaceId: string): Promise<number>;
  countInboundRecalls?(memoryId: string, workspaceId: string): Promise<number>;
  delete(edgeId: string): Promise<void>;
}

export interface GraphExploreServiceEventLogRepoPort {
  append(entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry | Promise<EventLogEntry>;
}

export interface GraphExploreServiceDependencies {
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

    const edges = await this.dependencies.edgeRepo.findByMemoryId(
      parsedMemoryId,
      parsedWorkspaceId,
      parsedEdgeTypes
    );

    const neighbors = edges.flatMap((edge) => {
      if (edge.source_memory_id === parsedMemoryId && (parsedDirection === "outbound" || parsedDirection === "both")) {
        return [
          GraphNeighborSchema.parse({
            memory_id: edge.target_memory_id,
            edge_type: edge.edge_type,
            direction: "outbound",
            edge_id: edge.edge_id
          })
        ];
      }

      if (edge.target_memory_id === parsedMemoryId && (parsedDirection === "inbound" || parsedDirection === "both")) {
        return [
          GraphNeighborSchema.parse({
            memory_id: edge.source_memory_id,
            edge_type: edge.edge_type,
            direction: "inbound",
            edge_id: edge.edge_id
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
    return await this.dependencies.edgeRepo.countInboundSupports(parseObjectId(memoryId), parseObjectId(workspaceId));
  }

  public async countInboundEdgesWeighted(memoryId: string, workspaceId: string): Promise<number> {
    return await this.dependencies.edgeRepo.countInboundEdgesWeighted(
      parseObjectId(memoryId),
      parseObjectId(workspaceId)
    );
  }

  public async countInboundRecalls(memoryId: string, workspaceId: string): Promise<number> {
    return await (this.dependencies.edgeRepo.countInboundRecalls?.(
      parseObjectId(memoryId),
      parseObjectId(workspaceId)
    ) ?? Promise.resolve(0));
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
