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

// invariant: GraphExploreService exposes no edge-creation surface.
// Durable graph edges may only be created via `EdgeProposalService`
// accept path; this service is read-only (explore + count) plus
// delete. See `.do-it/findings/v0.3.11-codex-audit.md` §I0-2.
describe("GraphExploreService", () => {
  it("explores one-hop neighbors in both directions by default and emits an explore event", async () => {
    const append = vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) =>
      createEventLogEntry(event)
    );
    const service = new GraphExploreService({
      edgeRepo: {
        findByMemoryId: vi.fn(async () => [
          createEdge({ edge_id: "edge-out", source_memory_id: "memory-a", target_memory_id: "memory-b" }),
          createEdge({ edge_id: "edge-in", source_memory_id: "memory-c", target_memory_id: "memory-a" })
        ]),
        countInboundSupports: vi.fn(async () => 1),
        countInboundEdgesWeighted: vi.fn(async () => 1),
        delete: vi.fn(async () => undefined)
      },
      eventLogRepo: { append },
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
      edgeRepo: {
        findByMemoryId: vi.fn(async () => []),
        countInboundSupports: vi.fn(async () => 0),
        countInboundEdgesWeighted: vi.fn(async () => 0),
        delete: vi.fn(async () => undefined)
      },
      eventLogRepo: { append }
    });

    await expect(service.exploreOneHop("memory-a", "workspace-1")).resolves.toEqual([]);
    expect(append).not.toHaveBeenCalled();
  });

  it("translates invalid edge_types into a validation error", async () => {
    const edgeRepo = {
      findByMemoryId: vi.fn(async () => []),
      countInboundSupports: vi.fn(async () => 0),
      countInboundEdgesWeighted: vi.fn(async () => 0),
      delete: vi.fn(async () => undefined)
    };
    const service = new GraphExploreService({
      edgeRepo,
      eventLogRepo: { append: vi.fn(async (event) => createEventLogEntry(event)) }
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
