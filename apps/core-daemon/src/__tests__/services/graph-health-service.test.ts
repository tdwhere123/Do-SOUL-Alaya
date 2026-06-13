import {
  RuntimeGovernanceEventType,
  type EventLogEntry,
  type PathRelation
} from "@do-soul/alaya-protocol";
import { describe, expect, it, vi } from "vitest";
import { createGraphHealthService } from "../../services/graph-health-service.js";

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
          createRelation("supports", "active"),
          createRelation("recalls", "active"),
          createRelation("recalls", "dormant"),
          createRelation("contradicts", "retired")
        ])
      },
      eventLogRepo
    });

    const snapshot = await service.getStatus("workspace-1");

    expect(snapshot).toMatchObject({
      workspace_id: "workspace-1",
      status: "healthy",
      path_relations_total: 2,
      path_relations_by_kind: {
        supports: 1,
        recalls: 1
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

  it("a later dormant/revived/merged event wins latest_path_event_at", async () => {
    const eventLogRepo = {
      queryByWorkspaceAndType: vi.fn(async (_workspaceId: string, eventType: string) => {
        if (eventType === RuntimeGovernanceEventType.PATH_RELATION_CREATED) {
          return [createEvent(eventType, "2026-05-10T00:00:00.000Z")];
        }
        // A later dormancy and a later-still consolidation merge / revival
        // each mutate path lifecycle/topology, so the freshest of them must
        // win latest_path_event_at rather than leaving it stale at CREATED.
        if (eventType === RuntimeGovernanceEventType.PATH_RELATION_DORMANT) {
          return [createEvent(eventType, "2026-05-14T00:00:00.000Z")];
        }
        if (eventType === RuntimeGovernanceEventType.PATH_RELATION_REVIVED) {
          return [createEvent(eventType, "2026-05-16T00:00:00.000Z")];
        }
        if (eventType === RuntimeGovernanceEventType.PATH_RELATION_MERGED) {
          return [createEvent(eventType, "2026-05-20T00:00:00.000Z")];
        }
        return [];
      })
    };
    const service = createGraphHealthService({
      pathRelationRepo: {
        findByWorkspace: vi.fn(async () => [
          createRelation("supports", "active")
        ])
      },
      eventLogRepo
    });

    const snapshot = await service.getStatus("workspace-1");

    expect(snapshot.latest_path_event_at).toBe("2026-05-20T00:00:00.000Z");
    expect(eventLogRepo.queryByWorkspaceAndType).toHaveBeenCalledWith(
      "workspace-1",
      RuntimeGovernanceEventType.PATH_RELATION_MERGED
    );
    expect(eventLogRepo.queryByWorkspaceAndType).toHaveBeenCalledWith(
      "workspace-1",
      RuntimeGovernanceEventType.PATH_RELATION_REVIVED
    );
    // A refused candidate never became topology, so graph health never queries
    // PATH_RELATION_REJECTED — even a later rejection cannot move the timestamp.
    expect(eventLogRepo.queryByWorkspaceAndType).not.toHaveBeenCalledWith(
      "workspace-1",
      RuntimeGovernanceEventType.PATH_RELATION_REJECTED
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

  it("treats dormant or merged-away lifecycle rows as inactive for health counts", async () => {
    const service = createGraphHealthService({
      pathRelationRepo: {
        findByWorkspace: vi.fn(async () => [
          createRelation("supports", "dormant"),
          createRelation("recalls", "retired")
        ])
      },
      eventLogRepo: {
        queryByWorkspaceAndType: vi.fn(async () => [])
      }
    });

    const snapshot = await service.getStatus("workspace-inactive");

    expect(snapshot).toMatchObject({
      workspace_id: "workspace-inactive",
      status: "degraded",
      path_relations_total: 0,
      path_relations_by_kind: {},
      warnings: ["path_relations_empty"]
    });
  });
});

function createRelation(
  relationKind: string,
  status: "active" | "dormant" | "retired"
): Readonly<PathRelation> {
  return {
    constitution: { relation_kind: relationKind },
    lifecycle: {
      status,
      retirement_rule: "manual"
    }
  } as Readonly<PathRelation>;
}

function createEvent(eventType: string, createdAt: string): EventLogEntry {
  return {
    event_id: `event-${createdAt}`,
    event_type: eventType as EventLogEntry["event_type"],
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
