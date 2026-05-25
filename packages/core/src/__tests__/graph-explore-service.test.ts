import { describe, expect, it, vi } from "vitest";
import {
  GraphAuditorEventType,
  type EventLogEntry,
  type MemoryGraphEdge,
  type MemoryGraphEdgeTypeValue
} from "@do-soul/alaya-protocol";
import {
  GraphExploreService,
  type GraphExploreEventPublisherPort
} from "../graph-explore-service.js";

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

interface PublisherHarness {
  publisher: GraphExploreEventPublisherPort;
  appendManyWithMutation: ReturnType<typeof vi.fn>;
}

// Mirrors `better-sqlite3` BEGIN IMMEDIATE / COMMIT semantics: staged
// event rows are NOT visible until the synchronous `mutate` returns
// without throwing. If mutate throws the staged events are discarded so
// the test surface matches the production rollback path.
function createPublisher(events: EventLogEntry[] = [], onAppend?: (event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => void): PublisherHarness {
  const appendManyWithMutation = vi.fn(
    async <T,>(
      eventInputs: readonly Omit<EventLogEntry, "event_id" | "created_at" | "revision">[],
      mutate: (entries: readonly EventLogEntry[]) => T
    ): Promise<T> => {
      const staged: EventLogEntry[] = eventInputs.map((entry) => {
        if (onAppend !== undefined) {
          onAppend(entry);
        }
        return createEventLogEntry(entry);
      });
      const result = mutate(staged);
      for (const event of staged) {
        events.push(event);
      }
      return result;
    }
  );
  return {
    publisher: { appendManyWithMutation } as unknown as GraphExploreEventPublisherPort,
    appendManyWithMutation
  };
}

describe("GraphExploreService", () => {
  it("adds an edge via atomic append+insert (audit row precedes row insert in the transactional callback)", async () => {
    let persisted = false;
    const edgeRepo = {
      create: vi.fn((edge: Readonly<MemoryGraphEdge>) => {
        persisted = true;
        return edge;
      }),
      findByMemoryId: vi.fn(async () => []),
      findBySourceAndTarget: vi.fn(async () => null),
      countInboundSupports: vi.fn(async () => 0),
      countInboundEdgesWeighted: vi.fn(async () => 0),
      delete: vi.fn(async () => undefined)
    };
    const events: EventLogEntry[] = [];
    const { publisher, appendManyWithMutation } = createPublisher(events, () => {
      // EventLog input is materialised before mutate fires the row insert.
      expect(persisted).toBe(false);
    });
    const service = new GraphExploreService({
      memoryRepo: {
        findById: vi.fn(async (objectId: string) =>
          objectId === "memory-a" || objectId === "memory-b"
            ? { object_id: objectId, workspace_id: "workspace-1" }
            : null
        )
      },
      edgeRepo,
      eventLogRepo: { append: vi.fn(async (event) => createEventLogEntry(event)) },
      runtimeNotifier: { notifyEntry: vi.fn(async () => undefined) },
      eventPublisher: publisher,
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
    expect(appendManyWithMutation).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: GraphAuditorEventType.SOUL_GRAPH_EDGE_CREATED,
      entity_type: "memory_graph_edge",
      entity_id: "edge_generated",
      workspace_id: "workspace-1",
      run_id: "run-1"
    });
    expect(edgeRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        edge_id: "edge_generated"
      })
    );
  });

  it("rolls back the staged SOUL_GRAPH_EDGE_CREATED row when the edge insert throws", async () => {
    const events: EventLogEntry[] = [];
    const { publisher, appendManyWithMutation } = createPublisher(events);
    const edgeRepo = {
      create: vi.fn(() => {
        throw new Error("simulated edge insert failure");
      }),
      findByMemoryId: vi.fn(async () => []),
      findBySourceAndTarget: vi.fn(async () => null),
      countInboundSupports: vi.fn(async () => 0),
      countInboundEdgesWeighted: vi.fn(async () => 0),
      delete: vi.fn(async () => undefined)
    };
    const service = new GraphExploreService({
      memoryRepo: {
        findById: vi.fn(async (objectId: string) => ({ object_id: objectId, workspace_id: "workspace-1" }))
      },
      edgeRepo,
      eventLogRepo: { append: vi.fn(async (event) => createEventLogEntry(event)) },
      runtimeNotifier: { notifyEntry: vi.fn(async () => undefined) },
      eventPublisher: publisher,
      generateId: () => "rollback"
    });

    await expect(
      service.addEdge({
        sourceMemoryId: "memory-a",
        targetMemoryId: "memory-b",
        edgeType: "supports",
        workspaceId: "workspace-1"
      })
    ).rejects.toThrow("simulated edge insert failure");

    expect(appendManyWithMutation).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(0);
  });

  it("returns existing edge when addEdge is called idempotently (no event published)", async () => {
    const existing = createEdge();
    const { publisher, appendManyWithMutation } = createPublisher();
    const service = new GraphExploreService({
      memoryRepo: {
        findById: vi.fn(async () => ({ object_id: "memory-a", workspace_id: "workspace-1" }))
      },
      edgeRepo: {
        create: vi.fn((edge: Readonly<MemoryGraphEdge>) => edge),
        findByMemoryId: vi.fn(async () => []),
        findBySourceAndTarget: vi.fn(async () => existing),
        countInboundSupports: vi.fn(async () => 0),
        countInboundEdgesWeighted: vi.fn(async () => 0),
        delete: vi.fn(async () => undefined)
      },
      eventLogRepo: { append: vi.fn(async (event) => createEventLogEntry(event)) },
      runtimeNotifier: { notifyEntry: vi.fn(async () => undefined) },
      eventPublisher: publisher
    });

    await expect(
      service.addEdge({
        sourceMemoryId: "memory-a",
        targetMemoryId: "memory-b",
        edgeType: "supports",
        workspaceId: "workspace-1"
      })
    ).resolves.toEqual(existing);
    expect(appendManyWithMutation).not.toHaveBeenCalled();
  });

  it("validates endpoint workspace before returning an existing edge", async () => {
    const existing = createEdge();
    const findBySourceAndTarget = vi.fn(async () => existing);
    const { publisher, appendManyWithMutation } = createPublisher();
    const service = new GraphExploreService({
      memoryRepo: {
        findById: vi.fn(async (objectId: string) => ({
          object_id: objectId,
          workspace_id: objectId === "memory-b" ? "workspace-2" : "workspace-1"
        }))
      },
      edgeRepo: {
        create: vi.fn((edge: Readonly<MemoryGraphEdge>) => edge),
        findByMemoryId: vi.fn(async () => []),
        findBySourceAndTarget,
        countInboundSupports: vi.fn(async () => 0),
        countInboundEdgesWeighted: vi.fn(async () => 0),
        delete: vi.fn(async () => undefined)
      },
      eventLogRepo: { append: vi.fn(async (event) => createEventLogEntry(event)) },
      runtimeNotifier: { notifyEntry: vi.fn(async () => undefined) },
      eventPublisher: publisher
    });

    await expect(
      service.addEdge({
        sourceMemoryId: "memory-a",
        targetMemoryId: "memory-b",
        edgeType: "supports",
        workspaceId: "workspace-1"
      })
    ).rejects.toMatchObject({
      name: "CoreError",
      code: "VALIDATION",
      message: "Target memory does not belong to workspace workspace-1: memory-b"
    });
    expect(findBySourceAndTarget).not.toHaveBeenCalled();
    expect(appendManyWithMutation).not.toHaveBeenCalled();
  });

  it("rejects an edge whose source memory belongs to another workspace", async () => {
    const edgeRepo = {
      create: vi.fn((edge: Readonly<MemoryGraphEdge>) => edge),
      findByMemoryId: vi.fn(async () => []),
      findBySourceAndTarget: vi.fn(async () => null),
      countInboundSupports: vi.fn(async () => 0),
      countInboundEdgesWeighted: vi.fn(async () => 0),
      delete: vi.fn(async () => undefined)
    };
    const { publisher, appendManyWithMutation } = createPublisher();
    const service = new GraphExploreService({
      memoryRepo: {
        findById: vi.fn(async (objectId: string) => ({
          object_id: objectId,
          workspace_id: objectId === "memory-a" ? "workspace-2" : "workspace-1"
        }))
      },
      edgeRepo,
      eventLogRepo: { append: vi.fn(async (event) => createEventLogEntry(event)) },
      runtimeNotifier: { notifyEntry: vi.fn(async () => undefined) },
      eventPublisher: publisher
    });

    await expect(
      service.addEdge({
        sourceMemoryId: "memory-a",
        targetMemoryId: "memory-b",
        edgeType: "supports",
        workspaceId: "workspace-1"
      })
    ).rejects.toMatchObject({
      name: "CoreError",
      code: "VALIDATION",
      message: "Source memory does not belong to workspace workspace-1: memory-a"
    });
    expect(edgeRepo.create).not.toHaveBeenCalled();
    expect(appendManyWithMutation).not.toHaveBeenCalled();
  });

  it("rejects an edge whose target memory belongs to another workspace", async () => {
    const edgeRepo = {
      create: vi.fn((edge: Readonly<MemoryGraphEdge>) => edge),
      findByMemoryId: vi.fn(async () => []),
      findBySourceAndTarget: vi.fn(async () => null),
      countInboundSupports: vi.fn(async () => 0),
      countInboundEdgesWeighted: vi.fn(async () => 0),
      delete: vi.fn(async () => undefined)
    };
    const { publisher, appendManyWithMutation } = createPublisher();
    const service = new GraphExploreService({
      memoryRepo: {
        findById: vi.fn(async (objectId: string) => ({
          object_id: objectId,
          workspace_id: objectId === "memory-b" ? "workspace-2" : "workspace-1"
        }))
      },
      edgeRepo,
      eventLogRepo: { append: vi.fn(async (event) => createEventLogEntry(event)) },
      runtimeNotifier: { notifyEntry: vi.fn(async () => undefined) },
      eventPublisher: publisher
    });

    await expect(
      service.addEdge({
        sourceMemoryId: "memory-a",
        targetMemoryId: "memory-b",
        edgeType: "supports",
        workspaceId: "workspace-1"
      })
    ).rejects.toMatchObject({
      name: "CoreError",
      code: "VALIDATION",
      message: "Target memory does not belong to workspace workspace-1: memory-b"
    });
    expect(edgeRepo.create).not.toHaveBeenCalled();
    expect(appendManyWithMutation).not.toHaveBeenCalled();
  });

  it("explores one-hop neighbors in both directions by default and emits an explore event", async () => {
    const append = vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) =>
      createEventLogEntry(event)
    );
    const { publisher } = createPublisher();
    const service = new GraphExploreService({
      memoryRepo: {
        findById: vi.fn(async () => ({ object_id: "memory-a", workspace_id: "workspace-1" }))
      },
      edgeRepo: {
        create: vi.fn((edge: Readonly<MemoryGraphEdge>) => edge),
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
      eventPublisher: publisher,
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
    const { publisher } = createPublisher();
    const service = new GraphExploreService({
      memoryRepo: {
        findById: vi.fn(async () => ({ object_id: "memory-a", workspace_id: "workspace-1" }))
      },
      edgeRepo: {
        create: vi.fn((edge: Readonly<MemoryGraphEdge>) => edge),
        findByMemoryId: vi.fn(async () => []),
        findBySourceAndTarget: vi.fn(async () => null),
        countInboundSupports: vi.fn(async () => 0),
        countInboundEdgesWeighted: vi.fn(async () => 0),
        delete: vi.fn(async () => undefined)
      },
      eventLogRepo: { append },
      runtimeNotifier: { notifyEntry: vi.fn(async () => undefined) },
      eventPublisher: publisher
    });

    await expect(service.exploreOneHop("memory-a", "workspace-1")).resolves.toEqual([]);
    expect(append).not.toHaveBeenCalled();
  });

  it("translates invalid edge_types into a validation error", async () => {
    const edgeRepo = {
      create: vi.fn((edge: Readonly<MemoryGraphEdge>) => edge),
      findByMemoryId: vi.fn(async () => []),
      findBySourceAndTarget: vi.fn(async () => null),
      countInboundSupports: vi.fn(async () => 0),
      countInboundEdgesWeighted: vi.fn(async () => 0),
      delete: vi.fn(async () => undefined)
    };
    const { publisher } = createPublisher();
    const service = new GraphExploreService({
      memoryRepo: {
        findById: vi.fn(async () => ({ object_id: "memory-a", workspace_id: "workspace-1" }))
      },
      edgeRepo,
      eventLogRepo: { append: vi.fn(async (event) => createEventLogEntry(event)) },
      runtimeNotifier: { notifyEntry: vi.fn(async () => undefined) },
      eventPublisher: publisher
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
