import { describe, expect, it } from "vitest";
import {
  ControlPlaneObjectKind,
  ControlPlaneObjectKindSchema,
  EventTypeSchema,
  GARDEN_ROLE_PERMISSIONS,
  GardenRole,
  GardenTaskKindSchema,
  ObjectKind,
  ObjectKindSchema
} from "../../index.js";

const validTimestamp = "2026-03-28T00:00:00.000Z";

describe("Phase 4B protocol schemas", () => {
  it("extends object kind unions for graph edges and orphan radar", () => {
    expect(ObjectKindSchema.parse("memory_graph_edge")).toBe("memory_graph_edge");
    expect(ControlPlaneObjectKindSchema.parse("orphan_radar")).toBe("orphan_radar");
    expect(ObjectKind.MEMORY_GRAPH_EDGE).toBe("memory_graph_edge");
    expect(ControlPlaneObjectKind.ORPHAN_RADAR).toBe("orphan_radar");
  });

  it("extends garden task kinds for pointer healing, orphan detection, tombstone gc, and path graph snapshots", () => {
    expect(GardenTaskKindSchema.parse("pointer_healing")).toBe("pointer_healing");
    expect(GardenTaskKindSchema.parse("orphan_detection")).toBe("orphan_detection");
    expect(GardenTaskKindSchema.parse("tombstone_gc")).toBe("tombstone_gc");
    expect(GardenTaskKindSchema.parse("path_graph_snapshot")).toBe("path_graph_snapshot");

    expect(GARDEN_ROLE_PERMISSIONS[GardenRole.AUDITOR].allowed_task_kinds).toContain("pointer_healing");
    expect(GARDEN_ROLE_PERMISSIONS[GardenRole.AUDITOR].allowed_task_kinds).toContain("orphan_detection");
    expect(GARDEN_ROLE_PERMISSIONS[GardenRole.LIBRARIAN].allowed_task_kinds).toContain(
      "path_graph_snapshot"
    );
    expect(GARDEN_ROLE_PERMISSIONS[GardenRole.JANITOR].allowed_task_kinds).not.toContain("pointer_healing");
  });

  it("parses the memory graph and orphan radar leaf schemas", async () => {
    const protocol = (await import("../../" + "index.js")) as Record<string, unknown>;
    const MemoryGraphEdgeSchema = protocol.MemoryGraphEdgeSchema as { parse: (value: unknown) => unknown };
    const GraphNeighborSchema = protocol.GraphNeighborSchema as { parse: (value: unknown) => unknown };
    const OrphanRadarSchema = protocol.OrphanRadarSchema as { parse: (value: unknown) => unknown };

    const edge = {
      edge_id: "edge-1",
      source_memory_id: "memory-1",
      target_memory_id: "memory-2",
      edge_type: "supports",
      workspace_id: "workspace-1",
      created_at: validTimestamp
    } as const;
    const neighbor = {
      memory_id: "memory-2",
      edge_type: "supports",
      direction: "outbound",
      edge_id: "edge-1"
    } as const;
    const radar = {
      radar_id: "radar-1",
      target_memory_id: "memory-3",
      workspace_id: "workspace-1",
      suspected_surface_gaps: ["surface-a", "surface-b"],
      suggested_action: "re_anchor_candidate",
      confidence: 0.6,
      detected_at: validTimestamp,
      expires_at: "2026-03-30T00:00:00.000Z",
      requires_review: true
    } as const;

    expect(MemoryGraphEdgeSchema.parse(edge)).toEqual(edge);
    expect(GraphNeighborSchema.parse(neighbor)).toEqual(neighbor);
    expect(OrphanRadarSchema.parse(radar)).toEqual(radar);
  });

  it("parses all graph-auditor payloads and adds them to the global event union", async () => {
    const protocol = (await import("../../" + "index.js")) as Record<string, unknown>;
    const GraphAuditorEventType = protocol.GraphAuditorEventType as Record<string, string>;
    const GraphAuditorEventTypeSchema = protocol.GraphAuditorEventTypeSchema as { options: readonly string[]; parse: (value: unknown) => unknown };
    const GraphAuditorEventUnionSchema = protocol.GraphAuditorEventUnionSchema as { parse: (value: unknown) => unknown };
    const parseGraphAuditorEventPayload = protocol.parseGraphAuditorEventPayload as (
      type: string,
      payload: Record<string, unknown>
    ) => unknown;

    const edgeCreatedPayload = {
      edge_id: "edge-1",
      source_memory_id: "memory-1",
      target_memory_id: "memory-2",
      edge_type: "supports",
      workspace_id: "workspace-1",
      occurred_at: validTimestamp
    } as const;
    expect(parseGraphAuditorEventPayload(GraphAuditorEventType.SOUL_GRAPH_EDGE_CREATED!, edgeCreatedPayload)).toEqual(
      edgeCreatedPayload
    );

    const edgeProposalCreatedPayload = {
      proposal_id: "edge-proposal-1",
      source_memory_id: "memory-1",
      target_memory_id: "memory-2",
      edge_type: "recalls",
      trigger_source: "recall_cross_link",
      confidence: 0.5,
      reason: "co-used in a recall report",
      source_signal_id: null,
      workspace_id: "workspace-1",
      occurred_at: validTimestamp
    } as const;
    expect(
      parseGraphAuditorEventPayload(
        GraphAuditorEventType.SOUL_GRAPH_EDGE_PROPOSAL_CREATED!,
        edgeProposalCreatedPayload
      )
    ).toEqual(edgeProposalCreatedPayload);

    const edgeProposalReviewedPayload = {
      proposal_id: "edge-proposal-1",
      status: "accepted",
      reviewer_identity: "user:reviewer",
      review_reason: "accepted by operator",
      workspace_id: "workspace-1",
      occurred_at: validTimestamp
    } as const;
    expect(
      parseGraphAuditorEventPayload(
        GraphAuditorEventType.SOUL_GRAPH_EDGE_PROPOSAL_REVIEWED!,
        edgeProposalReviewedPayload
      )
    ).toEqual(edgeProposalReviewedPayload);

    const exploreCompletedPayload = {
      exploration_kind: "memory_neighbors",
      source_memory_id: "memory-1",
      workspace_id: "workspace-1",
      direction: "both",
      neighbor_count: 2,
      occurred_at: validTimestamp
    } as const;
    expect(
      parseGraphAuditorEventPayload(GraphAuditorEventType.SOUL_GRAPH_EXPLORE_COMPLETED!, exploreCompletedPayload)
    ).toEqual(exploreCompletedPayload);

    expect(
      parseGraphAuditorEventPayload(GraphAuditorEventType.SOUL_GRAPH_EXPLORE_COMPLETED!, {
        source_memory_id: "memory-1",
        workspace_id: "workspace-1",
        direction: "both",
        neighbor_count: 2,
        occurred_at: validTimestamp
      })
    ).toEqual(exploreCompletedPayload);

    const topologyExploreCompletedPayload = {
      exploration_kind: "path_topology",
      workspace_id: "workspace-1",
      total_nodes: 4,
      total_edges: 3,
      strongly_connected_components: 2,
      occurred_at: validTimestamp
    } as const;
    expect(
      parseGraphAuditorEventPayload(GraphAuditorEventType.SOUL_GRAPH_EXPLORE_COMPLETED!, topologyExploreCompletedPayload)
    ).toEqual(topologyExploreCompletedPayload);

    const pointerHealedPayload = {
      source_object_id: "claim-1",
      source_object_kind: "claim_form",
      ref_kind: "evidence_ref",
      cleared_ref: "evidence-1",
      task_id: "task-1",
      workspace_id: "workspace-1",
      occurred_at: validTimestamp
    } as const;
    expect(parseGraphAuditorEventPayload(GraphAuditorEventType.SOUL_AUDITOR_POINTER_HEALED!, pointerHealedPayload)).toEqual(
      pointerHealedPayload
    );

    const orphanReportedPayload = {
      radar_id: "radar-1",
      target_memory_id: "memory-3",
      suggested_action: "archive_candidate",
      workspace_id: "workspace-1",
      occurred_at: validTimestamp
    } as const;
    expect(parseGraphAuditorEventPayload(GraphAuditorEventType.SOUL_ORPHAN_RADAR_REPORTED!, orphanReportedPayload)).toEqual(
      orphanReportedPayload
    );

    const edgeProposalPathMintFailedPayload = {
      proposal_id: "edge-proposal-1",
      source_memory_id: "memory-1",
      target_memory_id: "memory-2",
      edge_type: "recalls",
      reviewer_identity: "user:reviewer",
      failure_kind: "submit_returned_false",
      failure_detail: null,
      workspace_id: "workspace-1",
      occurred_at: validTimestamp
    } as const;
    expect(
      parseGraphAuditorEventPayload(
        GraphAuditorEventType.SOUL_GRAPH_EDGE_PROPOSAL_PATH_MINT_FAILED!,
        edgeProposalPathMintFailedPayload
      )
    ).toEqual(edgeProposalPathMintFailedPayload);

    expect(GraphAuditorEventTypeSchema.options).toEqual([
      GraphAuditorEventType.SOUL_GRAPH_EDGE_CREATED!,
      GraphAuditorEventType.SOUL_GRAPH_EDGE_PROPOSAL_CREATED!,
      GraphAuditorEventType.SOUL_GRAPH_EDGE_PROPOSAL_REVIEWED!,
      GraphAuditorEventType.SOUL_GRAPH_EDGE_PROPOSAL_PATH_MINT_FAILED!,
      GraphAuditorEventType.SOUL_GRAPH_EXPLORE_COMPLETED!,
      GraphAuditorEventType.SOUL_AUDITOR_POINTER_HEALED!,
      GraphAuditorEventType.SOUL_ORPHAN_RADAR_REPORTED!
    ]);

    expect(
      GraphAuditorEventUnionSchema.parse({
        type: GraphAuditorEventType.SOUL_ORPHAN_RADAR_REPORTED!,
        payload: orphanReportedPayload
      })
    ).toEqual({
      type: GraphAuditorEventType.SOUL_ORPHAN_RADAR_REPORTED!,
      payload: orphanReportedPayload
    });

    expect(EventTypeSchema.parse(GraphAuditorEventType.SOUL_GRAPH_EDGE_CREATED!)).toBe(
      GraphAuditorEventType.SOUL_GRAPH_EDGE_CREATED!
    );
    expect(EventTypeSchema.parse(GraphAuditorEventType.SOUL_GRAPH_EDGE_PROPOSAL_REVIEWED!)).toBe(
      GraphAuditorEventType.SOUL_GRAPH_EDGE_PROPOSAL_REVIEWED!
    );
    expect(EventTypeSchema.parse(GraphAuditorEventType.SOUL_AUDITOR_POINTER_HEALED!)).toBe(
      GraphAuditorEventType.SOUL_AUDITOR_POINTER_HEALED!
    );
  });

  it("rejects pointer-healed payloads missing required fields and deprecated field names", async () => {
    const protocol = (await import("../../" + "index.js")) as Record<string, unknown>;
    const GraphAuditorEventType = protocol.GraphAuditorEventType as Record<string, string>;
    const parseGraphAuditorEventPayload = protocol.parseGraphAuditorEventPayload as (
      type: string,
      payload: Record<string, unknown>
    ) => unknown;

    expect(() =>
      parseGraphAuditorEventPayload(GraphAuditorEventType.SOUL_AUDITOR_POINTER_HEALED!, {
        source_object_id: "claim-1",
        source_object_kind: "claim_form",
        ref_kind: "evidence_ref",
        workspace_id: "workspace-1",
        task_id: "task-1",
        occurred_at: validTimestamp
      })
    ).toThrow();

    expect(() =>
      parseGraphAuditorEventPayload(GraphAuditorEventType.SOUL_AUDITOR_POINTER_HEALED!, {
        source_object_id: "claim-1",
        source_object_kind: "claim_form",
        ref_kind: "evidence_ref",
        cleared_ref: "evidence-1",
        workspace_id: "workspace-1",
        occurred_at: validTimestamp
      })
    ).toThrow();

    expect(() =>
      parseGraphAuditorEventPayload(GraphAuditorEventType.SOUL_AUDITOR_POINTER_HEALED!, {
        source_object_id: "claim-1",
        source_object_kind: "claim_form",
        ref_kind: "evidence_ref",
        broken_ref: "evidence-1",
        cleared_ref: "evidence-1",
        action_taken: "ref_cleared",
        task_id: "task-1",
        workspace_id: "workspace-1",
        occurred_at: validTimestamp
      })
    ).toThrow();
  });
});
