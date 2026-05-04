import {
  GraphAuditorEventType,
  parseGraphAuditorEventPayload,
  type EventLogEntry,
  type TopologyExplorationResult
} from "@do-soul/alaya-protocol";

export interface SoulTopologyAuditEventLogRepo {
  append(
    entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision"> & {
      readonly revision?: number;
    }
  ): Promise<EventLogEntry>;
}

export interface SoulTopologyAuditServiceDependencies {
  readonly eventLogRepo: SoulTopologyAuditEventLogRepo;
}

export class SoulTopologyAuditService {
  public constructor(private readonly deps: SoulTopologyAuditServiceDependencies) {}

  public async appendPathTopologyExploreCompleted(
    topology: Readonly<TopologyExplorationResult>
  ): Promise<EventLogEntry> {
    const workspaceId = topology.workspace_id;

    return await this.deps.eventLogRepo.append({
      event_type: GraphAuditorEventType.SOUL_GRAPH_EXPLORE_COMPLETED,
      entity_type: "workspace",
      entity_id: workspaceId,
      workspace_id: workspaceId,
      run_id: null,
      caused_by: "system",
      payload_json: parseGraphAuditorEventPayload(GraphAuditorEventType.SOUL_GRAPH_EXPLORE_COMPLETED, {
        exploration_kind: "path_topology",
        workspace_id: workspaceId,
        total_nodes: topology.total_nodes,
        total_edges: topology.total_edges,
        strongly_connected_components: topology.strongly_connected_components,
        occurred_at: topology.explored_at
      })
    });
  }
}
