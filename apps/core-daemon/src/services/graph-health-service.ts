import {
  MemoryGraphEdgeType,
  RuntimeGovernanceEventType,
  type EventLogEntry,
  type MemoryGraphEdgeTypeValue
} from "@do-soul/alaya-protocol";
import type {
  EventLogRepo,
  MemoryGraphEdgeRepo,
  PathRelationRepo
} from "@do-soul/alaya-storage";

export type GraphHealthStatus = "healthy" | "degraded";
export type GraphHealthWarning =
  | "memory_graph_edges_empty"
  | "path_relations_empty";

export interface GraphHealthSnapshot {
  readonly workspace_id: string;
  readonly status: GraphHealthStatus;
  readonly memory_graph_edges_total: number;
  readonly memory_graph_edges_by_type: Readonly<Record<MemoryGraphEdgeTypeValue, number>>;
  readonly path_relations_total: number;
  readonly latest_path_event_at: string | null;
  readonly warnings: readonly GraphHealthWarning[];
  readonly hint: string | null;
}

export interface GraphHealthService {
  getStatus(workspaceId: string): Promise<GraphHealthSnapshot>;
}

const MEMORY_GRAPH_EDGE_TYPES = Object.values(MemoryGraphEdgeType);

const PATH_RELATION_EVENT_TYPES = [
  RuntimeGovernanceEventType.PATH_RELATION_CREATED,
  RuntimeGovernanceEventType.PATH_RELATION_REINFORCED,
  RuntimeGovernanceEventType.PATH_RELATION_WEAKENED,
  RuntimeGovernanceEventType.PATH_RELATION_REDIRECTED,
  RuntimeGovernanceEventType.PATH_RELATION_RETIRED
] as const;

const SPARSE_GRAPH_HINT =
  "Graph/path evidence is sparse; this is expected for a new install or workspace before recall/report and Garden path activity.";

export function createGraphHealthService(deps: {
  readonly memoryGraphEdgeRepo: Pick<MemoryGraphEdgeRepo, "findByWorkspace">;
  readonly pathRelationRepo: Pick<PathRelationRepo, "findByWorkspace">;
  readonly eventLogRepo: Pick<EventLogRepo, "queryByWorkspaceAndType">;
}): GraphHealthService {
  return Object.freeze({
    getStatus: async (workspaceId: string): Promise<GraphHealthSnapshot> => {
      const [memoryGraphEdges, pathRelations, pathEventBatches] = await Promise.all([
        deps.memoryGraphEdgeRepo.findByWorkspace(workspaceId),
        deps.pathRelationRepo.findByWorkspace(workspaceId),
        Promise.all(
          PATH_RELATION_EVENT_TYPES.map(
            async (eventType) => await deps.eventLogRepo.queryByWorkspaceAndType(workspaceId, eventType)
          )
        )
      ]);

      const edgeCounts = createZeroedEdgeCounts();
      for (const edge of memoryGraphEdges) {
        edgeCounts[edge.edge_type] += 1;
      }

      const warnings: GraphHealthWarning[] = [];
      if (memoryGraphEdges.length === 0) {
        warnings.push("memory_graph_edges_empty");
      }
      if (pathRelations.length === 0) {
        warnings.push("path_relations_empty");
      }

      return Object.freeze({
        workspace_id: workspaceId,
        status: warnings.length === 0 ? "healthy" : "degraded",
        memory_graph_edges_total: memoryGraphEdges.length,
        memory_graph_edges_by_type: Object.freeze(edgeCounts),
        path_relations_total: pathRelations.length,
        latest_path_event_at: latestEventCreatedAt(pathEventBatches.flat()),
        warnings: Object.freeze(warnings),
        hint: warnings.length === 0 ? null : SPARSE_GRAPH_HINT
      });
    }
  });
}

export function createEmptyGraphHealthSnapshot(workspaceId: string): GraphHealthSnapshot {
  const warnings: readonly GraphHealthWarning[] = [
    "memory_graph_edges_empty",
    "path_relations_empty"
  ];
  return Object.freeze({
    workspace_id: workspaceId,
    status: "degraded",
    memory_graph_edges_total: 0,
    memory_graph_edges_by_type: Object.freeze(createZeroedEdgeCounts()),
    path_relations_total: 0,
    latest_path_event_at: null,
    warnings: Object.freeze(warnings),
    hint: SPARSE_GRAPH_HINT
  });
}

function createZeroedEdgeCounts(): Record<MemoryGraphEdgeTypeValue, number> {
  return Object.fromEntries(MEMORY_GRAPH_EDGE_TYPES.map((edgeType) => [edgeType, 0])) as Record<
    MemoryGraphEdgeTypeValue,
    number
  >;
}

function latestEventCreatedAt(events: readonly Readonly<EventLogEntry>[]): string | null {
  let latest: string | null = null;
  for (const event of events) {
    if (latest === null || event.created_at > latest) {
      latest = event.created_at;
    }
  }
  return latest;
}
