import { describe, expect, it } from "vitest";
import {
  EventTypeSchema,
  RecallContextEventType,
  RecallContextEventTypeSchema,
  parseRecallContextEventPayload
} from "../../index.js";

const validTimestamp = "2026-03-23T00:00:00.000Z";

describe("Phase 3A event schemas", () => {
  it("keeps RecallContextEventType enum complete and closed", () => {
    const expected = [
      "soul.task_surface.created",
      "soul.recall.completed",
      "soul.context_lens.assembled",
      "soul.recall.weight_transfer",
      "soul.recall.delivered",
      "soul.context_usage.reported",
      "soul.single_used_anchor"
    ];

    expect(Object.values(RecallContextEventType)).toEqual(expected);
    expect(RecallContextEventTypeSchema.options).toEqual(expected);
  });

  it("parses soul.task_surface.created payload", () => {
    const payload = {
      runtime_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
      object_kind: "task_object_surface",
      surface_kind: "build",
      display_name: "Implement recall",
      node_strategy: "build",
      run_id: "run-1",
      workspace_id: "workspace-1",
      expires_at: "2026-03-23T00:30:00.000Z",
      occurred_at: validTimestamp
    } as const;

    expect(parseRecallContextEventPayload(RecallContextEventType.SOUL_TASK_SURFACE_CREATED, payload)).toEqual(payload);
  });

  it("parses soul.recall.completed payload", () => {
    const payload = {
      task_surface_ref: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
      node_strategy: "analyze",
      total_scanned: 12,
      coarse_filter_count: 8,
      fine_assessment_count: 4,
      workspace_id: "workspace-1",
      occurred_at: validTimestamp
    } as const;

    expect(parseRecallContextEventPayload(RecallContextEventType.SOUL_RECALL_COMPLETED, payload)).toEqual(payload);
  });

  it("parses soul.context_lens.assembled payload", () => {
    const payload = {
      runtime_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
      task_surface_ref: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
      lens_entry_count: 6,
      total_token_estimate: 512,
      run_id: "run-1",
      workspace_id: "workspace-1",
      occurred_at: validTimestamp
    } as const;

    expect(parseRecallContextEventPayload(RecallContextEventType.SOUL_CONTEXT_LENS_ASSEMBLED, payload)).toEqual(payload);
  });

  it("parses soul.recall.weight_transfer payload", () => {
    const payload = {
      workspace_id: "workspace-1",
      run_id: "run-1",
      cold_score: 0.5,
      recalls_edge_count: 25,
      recalls_threshold: 50,
      transferred_amount: 0.1,
      occurred_at: validTimestamp
    } as const;

    expect(parseRecallContextEventPayload(RecallContextEventType.SOUL_RECALL_WEIGHT_TRANSFER, payload)).toEqual(payload);
  });

  it("parses soul.recall.delivered payload", () => {
    const payload = {
      delivery_id: "delivery_70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
      session_id: "session_70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
      run_id: "run-1",
      agent_target: "claude-code",
      query_hash: "abc123def456",
      pointer_count: 5,
      latency_ms: 142,
      workspace_id: "workspace-1",
      occurred_at: validTimestamp
    } as const;

    expect(parseRecallContextEventPayload(RecallContextEventType.SOUL_RECALL_DELIVERED, payload)).toEqual(payload);
  });

  it("parses soul.recall.delivered payload with null run_id", () => {
    const payload = {
      delivery_id: "delivery_no-run",
      session_id: "mcp-session-no-run",
      run_id: null,
      agent_target: "claude-code",
      query_hash: "abc123def456",
      pointer_count: 0,
      latency_ms: 8,
      workspace_id: "workspace-1",
      occurred_at: validTimestamp
    } as const;

    expect(parseRecallContextEventPayload(RecallContextEventType.SOUL_RECALL_DELIVERED, payload)).toEqual(payload);
  });

  it("parses soul.context_usage.reported payload for each usage_state", () => {
    const states = ["used", "skipped", "not_applicable"] as const;
    for (const usageState of states) {
      const payload = {
        delivery_id: "delivery_70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
        session_id: "session_70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
        run_id: "run-1",
        agent_target: "claude-code",
        usage_state: usageState,
        workspace_id: "workspace-1",
        occurred_at: validTimestamp
      } as const;

      expect(parseRecallContextEventPayload(RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED, payload)).toEqual(
        payload
      );
    }
  });

  it("rejects soul.context_usage.reported with unknown usage_state", () => {
    expect(() =>
      parseRecallContextEventPayload(RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED, {
        delivery_id: "delivery_x",
        session_id: "session_x",
        run_id: "run-1",
        agent_target: "claude-code",
        usage_state: "rejected",
        workspace_id: "workspace-1",
        occurred_at: validTimestamp
      })
    ).toThrow();
  });

  it("throws for unknown recall-context event types", () => {
    expect(() =>
      parseRecallContextEventPayload("soul.unknown.event" as never, {
        occurred_at: validTimestamp
      })
    ).toThrow();
  });

  it("accepts recall-context event types in EventType union", () => {
    expect(EventTypeSchema.parse(RecallContextEventType.SOUL_TASK_SURFACE_CREATED)).toBe(
      RecallContextEventType.SOUL_TASK_SURFACE_CREATED
    );
    expect(EventTypeSchema.parse(RecallContextEventType.SOUL_RECALL_COMPLETED)).toBe(
      RecallContextEventType.SOUL_RECALL_COMPLETED
    );
    expect(EventTypeSchema.parse(RecallContextEventType.SOUL_RECALL_WEIGHT_TRANSFER)).toBe(
      RecallContextEventType.SOUL_RECALL_WEIGHT_TRANSFER
    );
    expect(EventTypeSchema.parse(RecallContextEventType.SOUL_RECALL_DELIVERED)).toBe(
      RecallContextEventType.SOUL_RECALL_DELIVERED
    );
    expect(EventTypeSchema.parse(RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED)).toBe(
      RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED
    );
    expect(EventTypeSchema.parse(RecallContextEventType.SOUL_SINGLE_USED_ANCHOR)).toBe(
      RecallContextEventType.SOUL_SINGLE_USED_ANCHOR
    );
  });

  it("parses soul.single_used_anchor payload with and without anchor object id", () => {
    const withAnchor = {
      delivery_id: "delivery_single",
      session_id: "session_single",
      run_id: "run-1",
      agent_target: "claude-code",
      used_anchor_object_id: "obj-anchor-1",
      workspace_id: "workspace-1",
      occurred_at: validTimestamp
    } as const;
    expect(
      parseRecallContextEventPayload(RecallContextEventType.SOUL_SINGLE_USED_ANCHOR, withAnchor)
    ).toEqual(withAnchor);

    const withoutAnchor = { ...withAnchor, used_anchor_object_id: null };
    expect(
      parseRecallContextEventPayload(RecallContextEventType.SOUL_SINGLE_USED_ANCHOR, withoutAnchor)
    ).toEqual(withoutAnchor);
  });
});
