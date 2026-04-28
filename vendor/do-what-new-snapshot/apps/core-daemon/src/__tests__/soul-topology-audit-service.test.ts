import { describe, expect, it, vi } from "vitest";
import type { EventLogEntry, TopologyExplorationResult } from "@do-what/protocol";
import { Phase4BEventType } from "@do-what/protocol";
import { SoulTopologyAuditService } from "../services/soul-topology-audit-service.js";

describe("SoulTopologyAuditService", () => {
  it("delegates revision allocation to the event log repo instead of hardcoding it in the caller", async () => {
    const append = vi.fn(
      async (
        entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision"> & { readonly revision?: number }
      ): Promise<EventLogEntry> => ({
        event_id: "event-topology-1",
        created_at: "2026-04-21T08:00:01.000Z",
        revision: 3,
        ...entry
      })
    );
    const service = new SoulTopologyAuditService({
      eventLogRepo: {
        append
      }
    });

    await service.appendPathTopologyExploreCompleted(createTopologyFixture());

    expect(append).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith({
      event_type: Phase4BEventType.SOUL_GRAPH_EXPLORE_COMPLETED,
      entity_type: "workspace",
      entity_id: "workspace-1",
      workspace_id: "workspace-1",
      run_id: null,
      caused_by: "system",
      payload_json: {
        exploration_kind: "path_topology",
        workspace_id: "workspace-1",
        total_nodes: 3,
        total_edges: 2,
        strongly_connected_components: 2,
        occurred_at: "2026-04-21T08:00:00.000Z"
      }
    });
    expect(append.mock.calls[0]?.[0]).not.toHaveProperty("revision");
  });
});

function createTopologyFixture(): Readonly<TopologyExplorationResult> {
  return {
    exploration_id: "topology-explore:workspace-1:2026-04-21T08:00:00.000Z",
    workspace_id: "workspace-1",
    total_nodes: 3,
    total_edges: 2,
    max_out_degree: 2,
    max_in_degree: 1,
    avg_degree: 4 / 3,
    strongly_connected_components: 2,
    explored_at: "2026-04-21T08:00:00.000Z"
  };
}
