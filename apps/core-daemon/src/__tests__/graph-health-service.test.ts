import {
  RuntimeGovernanceEventType,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import { describe, expect, it, vi } from "vitest";
import { createGraphHealthService } from "../services/graph-health-service.js";

describe("GraphHealthService", () => {
  it("counts path relations by kind and reports the latest path event", async () => {
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
      pathRelationRepo: {
        findByWorkspace: vi.fn(async () => [
          { constitution: { relation_kind: "supports" } },
          { constitution: { relation_kind: "recalls" } },
          { constitution: { relation_kind: "recalls" } }
        ] as never)
      },
      eventLogRepo
    });

    const snapshot = await service.getStatus("workspace-1");

    expect(snapshot).toMatchObject({
      workspace_id: "workspace-1",
      status: "healthy",
      path_relations_total: 3,
      path_relations_by_kind: {
        supports: 1,
        recalls: 2
      },
      latest_path_event_at: "2026-05-12T00:00:00.000Z",
      warnings: [],
      hint: null
    });
    expect(eventLogRepo.queryByWorkspaceAndType).toHaveBeenCalledWith(
      "workspace-1",
      RuntimeGovernanceEventType.PATH_RELATION_REINFORCED
    );
  });

  it("marks sparse path workspaces degraded with an operator hint", async () => {
    const service = createGraphHealthService({
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
      path_relations_total: 0,
      path_relations_by_kind: {},
      latest_path_event_at: null,
      warnings: ["path_relations_empty"]
    });
    expect(snapshot.hint).toContain("new install");
  });
});

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
