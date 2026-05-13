import { describe, expect, it, vi } from "vitest";
import {
  GraphAuditorEventType,
  type EventLogEntry,
  type MemoryGraphEdge,
  type MemoryGraphEdgeTypeValue
} from "@do-soul/alaya-protocol";
import { GraphExploreService } from "../graph-explore-service.js";

function createEventLogEntry(event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry {
  return {
    event_id: `event-${event.event_type}-${event.entity_id}`,
    created_at: "2026-03-28T10:00:00.000Z",
    revision: 0,
    ...event
  };
}

function createEdge(overrides: Partial<MemoryGraphEdge> = {}): MemoryGraphEdge {
  return {
    edge_id: "edge-existing",
    source_memory_id: "memory-a",
    target_memory_id: "memory-b",
    edge_type: "supports",
    workspace_id: "workspace-1",
    created_at: "2026-03-28T10:00:00.000Z",
    ...overrides
  };
}

describe("GraphExploreService", () => {
  it("adds an edge, appends the audit event before persistence, and notifies runtime listeners", async () => {
    let persisted = false;
    const edgeRepo = {
      create: vi.fn(async (edge: Readonly<MemoryGraphEdge>) => {
        persisted = true;
        return edge;
      }),
      findByMemoryId: vi.fn(async () => []),
      findBySourceAndTarget: vi.fn(async () => null),
      countInboundSupports: vi.fn(async () => 0),

      countInboundEdgesWeighted: vi.fn(async () => 0),
      delete: vi.fn(async () => undefined)
    };
    const append = vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => {
      expect(persisted).toBe(false);
      return createEventLogEntry(event);
    });
    const service = new GraphExploreService({
      memoryRepo: {
        findById: vi.fn(async (objectId: string) =>
          objectId === "memory-a" || objectId === "memory-b" ? { object_id: objectId } : null
        )
      },
      edgeRepo,
      eventLogRepo: { append },
      runtimeNotifier: { notifyEntry: vi.fn(async () => undefined) },
      generateId: () => "generated",
      now: () => "2026-03-28T10:00:00.000Z"
    });

    const created = await service.addEdge({
      sourceMemoryId: "memory-a",
      targetMemoryId: "memory-b",
      edgeType: "supports",
      workspaceId: "workspace-1",
      runId: "run-1"
    });

    expect(created).toMatchObject({
      edge_id: "edge_generated",
      source_memory_id: "memory-a",
      target_memory_id: "memory-b",
      edge_type: "supports",
      workspace_id: "workspace-1"
    });
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: GraphAuditorEventType.SOUL_GRAPH_EDGE_CREATED,
        entity_type: "memory_graph_edge",
        entity_id: "edge_generated",
        workspace_id: "workspace-1",
        run_id: "run-1"
      })
    );
    expect(edgeRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        edge_id: "edge_generated"
      })
    );
  });

  it("returns existing edge when addEdge is called idempotently", async () => {
    const existing = createEdge();
    const service = new GraphExploreService({
      memoryRepo: {
        findById: vi.fn(async () => ({ object_id: "memory-a" }))
      },
      edgeRepo: {
        create: vi.fn(async (edge: Readonly<MemoryGraphEdge>) => edge),
        findByMemoryId: vi.fn(async () => []),
        findBySourceAndTarget: vi.fn(async () => existing),
        countInboundSupports: vi.fn(async () => 0),

        countInboundEdgesWeighted: vi.fn(async () => 0),
        delete: vi.fn(async () => undefined)
      },
      eventLogRepo: { append: vi.fn(async (event) => createEventLogEntry(event)) },
      runtimeNotifier: { notifyEntry: vi.fn(async () => undefined) }
    });

    await expect(
      service.addEdge({
        sourceMemoryId: "memory-a",
        targetMemoryId: "memory-b",
        edgeType: "supports",
        workspaceId: "workspace-1"
      })
    ).resolves.toEqual(existing);
  });

  it("explores one-hop neighbors in both directions by default and emits an explore event", async () => {
    const append = vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) =>
      createEventLogEntry(event)
    );
    const service = new GraphExploreService({
      memoryRepo: {
        findById: vi.fn(async () => ({ object_id: "memory-a" }))
      },
      edgeRepo: {
        create: vi.fn(async (edge: Readonly<MemoryGraphEdge>) => edge),
        findByMemoryId: vi.fn(async () => [
          createEdge({ edge_id: "edge-out", source_memory_id: "memory-a", target_memory_id: "memory-b" }),
          createEdge({ edge_id: "edge-in", source_memory_id: "memory-c", target_memory_id: "memory-a" })
        ]),
        findBySourceAndTarget: vi.fn(async () => null),
        countInboundSupports: vi.fn(async () => 1),

        countInboundEdgesWeighted: vi.fn(async () => 1),
        delete: vi.fn(async () => undefined)
      },
      eventLogRepo: { append },
      runtimeNotifier: { notifyEntry: vi.fn(async () => undefined) },
      now: () => "2026-03-28T10:00:00.000Z"
    });

    const neighbors = await service.exploreOneHop("memory-a", "workspace-1");

    expect(neighbors).toEqual([
      {
        memory_id: "memory-b",
        edge_type: "supports",
        direction: "outbound",
        edge_id: "edge-out"
      },
      {
        memory_id: "memory-c",
        edge_type: "supports",
        direction: "inbound",
        edge_id: "edge-in"
      }
    ]);
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: GraphAuditorEventType.SOUL_GRAPH_EXPLORE_COMPLETED,
        entity_type: "memory_entry",
        entity_id: "memory-a",
        payload_json: expect.objectContaining({
          exploration_kind: "memory_neighbors",
          source_memory_id: "memory-a",
          workspace_id: "workspace-1",
          direction: "both",
          neighbor_count: 2
        })
      })
    );
  });

  it("returns an empty neighbor list without emitting an explore event when no edges match", async () => {
    const append = vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) =>
      createEventLogEntry(event)
    );
    const service = new GraphExploreService({
      memoryRepo: {
        findById: vi.fn(async () => ({ object_id: "memory-a" }))
      },
      edgeRepo: {
        create: vi.fn(async (edge: Readonly<MemoryGraphEdge>) => edge),
        findByMemoryId: vi.fn(async () => []),
        findBySourceAndTarget: vi.fn(async () => null),
        countInboundSupports: vi.fn(async () => 0),

        countInboundEdgesWeighted: vi.fn(async () => 0),
        delete: vi.fn(async () => undefined)
      },
      eventLogRepo: { append },
      runtimeNotifier: { notifyEntry: vi.fn(async () => undefined) }
    });

    await expect(service.exploreOneHop("memory-a", "workspace-1")).resolves.toEqual([]);
    expect(append).not.toHaveBeenCalled();
  });

  it("translates invalid edge_types into a validation error", async () => {
    const edgeRepo = {
      create: vi.fn(async (edge: Readonly<MemoryGraphEdge>) => edge),
      findByMemoryId: vi.fn(async () => []),
      findBySourceAndTarget: vi.fn(async () => null),
      countInboundSupports: vi.fn(async () => 0),

      countInboundEdgesWeighted: vi.fn(async () => 0),
      delete: vi.fn(async () => undefined)
    };
    const service = new GraphExploreService({
      memoryRepo: {
        findById: vi.fn(async () => ({ object_id: "memory-a" }))
      },
      edgeRepo,
      eventLogRepo: { append: vi.fn(async (event) => createEventLogEntry(event)) },
      runtimeNotifier: { notifyEntry: vi.fn(async () => undefined) }
    });

    await expect(
      service.exploreOneHop("memory-a", "workspace-1", {
        edgeTypes: ["not-a-real-edge"] as unknown as readonly MemoryGraphEdgeTypeValue[]
      })
    ).rejects.toMatchObject({
      name: "CoreError",
      code: "VALIDATION",
      message: "Invalid edge_type"
    });
    expect(edgeRepo.findByMemoryId).not.toHaveBeenCalled();
  });
});
