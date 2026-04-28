import { randomUUID } from "node:crypto";
import {
  GraphNeighborSchema,
  MemoryGraphEdgeSchema,
  MemoryGraphEdgeTypeSchema,
  Phase4BEventType,
  SoulGraphEdgeCreatedPayloadSchema,
  SoulGraphExploreCompletedPayloadSchema,
  type EventLogEntry,
  type GraphExploreDir,
  type GraphNeighbor,
  type MemoryGraphEdge,
  type MemoryGraphEdgeTypeValue
} from "@do-what/protocol";
import { CoreError } from "./errors.js";
import { parseObjectId } from "./shared/validators.js";

export interface GraphExploreServiceMemoryRepoPort {
  findById(objectId: string): Promise<{ readonly object_id: string } | null>;
}

export interface GraphExploreServiceEdgeRepoPort {
  create(edge: Readonly<MemoryGraphEdge>): Promise<Readonly<MemoryGraphEdge>>;
  findByMemoryId(
    memoryId: string,
    workspaceId: string,
    edgeTypes?: readonly MemoryGraphEdgeTypeValue[]
  ): Promise<readonly Readonly<MemoryGraphEdge>[]>;
  findBySourceAndTarget(
    sourceMemoryId: string,
    targetMemoryId: string,
    edgeType: MemoryGraphEdgeTypeValue,
    workspaceId: string
  ): Promise<Readonly<MemoryGraphEdge> | null>;
  countInboundSupports(memoryId: string, workspaceId: string): Promise<number>;
  delete(edgeId: string): Promise<void>;
}

export interface GraphExploreServiceEventLogRepoPort {
  append(entry: Omit<EventLogEntry, "event_id" | "created_at">): Promise<EventLogEntry>;
}

export interface GraphExploreServiceSseBroadcaster {
  broadcastEntry(entry: EventLogEntry): void | Promise<void>;
}

export interface GraphExploreServiceDependencies {
  readonly memoryRepo: GraphExploreServiceMemoryRepoPort;
  readonly edgeRepo: GraphExploreServiceEdgeRepoPort;
  readonly eventLogRepo: GraphExploreServiceEventLogRepoPort;
  readonly sseBroadcaster: GraphExploreServiceSseBroadcaster;
  readonly generateId?: () => string;
  readonly now?: () => string;
}

export interface GraphExploreAddEdgeParams {
  readonly sourceMemoryId: string;
  readonly targetMemoryId: string;
  readonly edgeType: MemoryGraphEdgeTypeValue;
  readonly workspaceId: string;
  readonly runId?: string | null;
}

export interface GraphExploreOptions {
  readonly edgeTypes?: readonly MemoryGraphEdgeTypeValue[];
  readonly direction?: GraphExploreDir;
  readonly runId?: string | null;
}

export class GraphExploreService {
  private readonly generateId: () => string;
  private readonly now: () => string;

  public constructor(private readonly dependencies: GraphExploreServiceDependencies) {
    this.generateId = dependencies.generateId ?? randomUUID;
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  public async addEdge(params: GraphExploreAddEdgeParams): Promise<Readonly<MemoryGraphEdge>> {
    const sourceMemoryId = parseObjectId(params.sourceMemoryId);
    const targetMemoryId = parseObjectId(params.targetMemoryId);
    const workspaceId = parseObjectId(params.workspaceId);
    const edgeType = parseMemoryGraphEdgeType(params.edgeType);

    if (sourceMemoryId === targetMemoryId) {
      throw new CoreError("VALIDATION", "Source and target memory must be different.");
    }

    const existing = await this.dependencies.edgeRepo.findBySourceAndTarget(
      sourceMemoryId,
      targetMemoryId,
      edgeType,
      workspaceId
    );

    if (existing !== null) {
      return existing;
    }

    await this.requireMemory(sourceMemoryId, "Source");
    await this.requireMemory(targetMemoryId, "Target");

    const createdAt = this.now();
    const edge = MemoryGraphEdgeSchema.parse({
      edge_id: `edge_${this.generateId()}`,
      source_memory_id: sourceMemoryId,
      target_memory_id: targetMemoryId,
      edge_type: edgeType,
      workspace_id: workspaceId,
      created_at: createdAt
    });

    const event = await this.dependencies.eventLogRepo.append({
      event_type: Phase4BEventType.SOUL_GRAPH_EDGE_CREATED,
      entity_type: "memory_graph_edge",
      entity_id: edge.edge_id,
      workspace_id: workspaceId,
      run_id: params.runId ?? null,
      caused_by: "system",
      revision: 0,
      payload_json: SoulGraphEdgeCreatedPayloadSchema.parse({
        edge_id: edge.edge_id,
        source_memory_id: sourceMemoryId,
        target_memory_id: targetMemoryId,
        edge_type: edgeType,
        workspace_id: workspaceId,
        occurred_at: createdAt
      })
    });

    const created = await this.dependencies.edgeRepo.create(edge);
    await this.dependencies.sseBroadcaster.broadcastEntry(event);
    return created;
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
      event_type: Phase4BEventType.SOUL_GRAPH_EXPLORE_COMPLETED,
      entity_type: "memory_entry",
      entity_id: parsedMemoryId,
      workspace_id: parsedWorkspaceId,
      run_id: options.runId ?? null,
      caused_by: "system",
      revision: 0,
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

  public async countInboundSupports(memoryId: string, workspaceId: string): Promise<number> {
    return await this.dependencies.edgeRepo.countInboundSupports(parseObjectId(memoryId), parseObjectId(workspaceId));
  }

  public async deleteEdge(edgeId: string): Promise<void> {
    await this.dependencies.edgeRepo.delete(parseObjectId(edgeId));
  }

  private async requireMemory(memoryId: string, label: string): Promise<void> {
    const memory = await this.dependencies.memoryRepo.findById(memoryId);

    if (memory === null) {
      throw new CoreError("NOT_FOUND", `${label} memory not found: ${memoryId}`);
    }
  }
}

function parseMemoryGraphEdgeType(value: MemoryGraphEdgeTypeValue): MemoryGraphEdgeTypeValue {
  const result = MemoryGraphEdgeTypeSchema.safeParse(value);

  if (!result.success) {
    throw new CoreError("VALIDATION", "Invalid edge_type", { cause: result.error });
  }

  return result.data;
}
