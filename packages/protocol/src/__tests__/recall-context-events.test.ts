import { describe, expect, it } from "vitest";
import {
  EventTypeSchema,
  RecallContextEventType,
  RecallContextEventTypeSchema,
  parseRecallContextEventPayload
} from "../index.js";

const validTimestamp = "2026-03-23T00:00:00.000Z";

describe("Phase 3A event schemas", () => {
  it("keeps RecallContextEventType enum complete and closed", () => {
    const expected = [
      "soul.task_surface.created",
      "soul.recall.completed",
      "soul.context_lens.assembled"
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
  });
});