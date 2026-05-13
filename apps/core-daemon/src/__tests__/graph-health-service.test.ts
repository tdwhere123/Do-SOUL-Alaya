import {
  MemoryGraphEdgeType,
  RuntimeGovernanceEventType,
  type EventLogEntry,
  type MemoryGraphEdge
} from "@do-soul/alaya-protocol";
import { describe, expect, it, vi } from "vitest";
import { createGraphHealthService } from "../services/graph-health-service.js";

describe("GraphHealthService", () => {
  it("counts graph edges by type, path relations, and latest path event", async () => {
    const eventLogRepo = {
      queryByWorkspaceAndType: vi.fn(async (_workspaceId: string, eventType: string) => {
        if (eventType === RuntimeGovernanceEventType.PATH_RELATION_CREATED) {
          return [createEvent(eventType, "2026-05-10T00:00:00.000Z")];
        }
        if (eventType === RuntimeGovernanceEventType.PATH_RELATION_REINFORCED) {
          return [createEvent(eventType, "2026-05-12T00:00:00.000Z")];
        }
        return [];
      })
    };
    const service = createGraphHealthService({
      memoryGraphEdgeRepo: {
        findByWorkspace: vi.fn(async () => [
          createEdge(MemoryGraphEdgeType.SUPPORTS, "1"),
          createEdge(MemoryGraphEdgeType.RECALLS, "2"),
          createEdge(MemoryGraphEdgeType.RECALLS, "3")
        ])
      },
      pathRelationRepo: {
        findByWorkspace: vi.fn(async () => [{ path_id: "path-1" }, { path_id: "path-2" }] as never)
      },
      eventLogRepo
    });

    const snapshot = await service.getStatus("workspace-1");

    expect(snapshot).toMatchObject({
      workspace_id: "workspace-1",
      status: "healthy",
      memory_graph_edges_total: 3,
      memory_graph_edges_by_type: {
        supports: 1,
        recalls: 2,
        supersedes: 0
      },
      path_relations_total: 2,
      latest_path_event_at: "2026-05-12T00:00:00.000Z",
      warnings: [],
      hint: null
    });
    expect(eventLogRepo.queryByWorkspaceAndType).toHaveBeenCalledWith(
      "workspace-1",
      RuntimeGovernanceEventType.PATH_RELATION_REINFORCED
    );
  });

  it("marks sparse graph/path workspaces degraded with an operator hint", async () => {
    const service = createGraphHealthService({
      memoryGraphEdgeRepo: {
        findByWorkspace: vi.fn(async () => [])
      },
      pathRelationRepo: {
        findByWorkspace: vi.fn(async () => [])
      },
      eventLogRepo: {
        queryByWorkspaceAndType: vi.fn(async () => [])
      }
    });

    const snapshot = await service.getStatus("workspace-empty");

    expect(snapshot).toMatchObject({
      workspace_id: "workspace-empty",
      status: "degraded",
      memory_graph_edges_total: 0,
      path_relations_total: 0,
      latest_path_event_at: null,
      warnings: ["memory_graph_edges_empty", "path_relations_empty"]
    });
    expect(snapshot.hint).toContain("new install");
  });
});

function createEdge(edgeType: MemoryGraphEdge["edge_type"], suffix: string): MemoryGraphEdge {
  return {
    edge_id: `edge-${edgeType}-${suffix}`,
    source_memory_id: "memory-source",
    target_memory_id: "memory-target",
    edge_type: edgeType,
    workspace_id: "workspace-1",
    created_at: "2026-05-12T00:00:00.000Z"
  };
}

function createEvent(eventType: string, createdAt: string): EventLogEntry {
  return {
    event_id: `event-${createdAt}`,
    event_type: eventType,
    entity_type: "path_relation",
    entity_id: "path-1",
    workspace_id: "workspace-1",
    run_id: null,
    caused_by: "system",
    revision: 0,
    payload_json: {},
    created_at: createdAt
  };
}
