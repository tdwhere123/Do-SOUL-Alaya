import { describe, expect, it } from "vitest";
import {
  EventLogEntrySchema,
  EventTypeSchema,
  SoulGardenEventLogOrphanDetectedEventSchema,
  SoulGardenEventLogOrphanDetectedEventType,
  SoulGardenEventLogOrphanDetectedEventTypeSchema,
  SoulGardenEventLogOrphanDetectedPayloadSchema
} from "../../index.js";

const detectedAt = "2026-05-01T00:00:00.000Z";

describe("event log orphan protocol event", () => {
  it("parses strict detected payloads and registers the event type", () => {
    const payload = {
      audit_event_id: "event-1",
      event_type: "memory.delivered",
      expected_table: "trust_context_delivery",
      detected_at: detectedAt
    } as const;

    expect(SoulGardenEventLogOrphanDetectedPayloadSchema.parse(payload)).toEqual(payload);
    expect(
      SoulGardenEventLogOrphanDetectedEventTypeSchema.parse(
        SoulGardenEventLogOrphanDetectedEventType.SOUL_GARDEN_EVENT_LOG_ORPHAN_DETECTED
      )
    ).toBe("soul.garden.event_log_orphan_detected");
    expect(
      EventTypeSchema.parse(SoulGardenEventLogOrphanDetectedEventType.SOUL_GARDEN_EVENT_LOG_ORPHAN_DETECTED)
    ).toBe("soul.garden.event_log_orphan_detected");
    expect(
      SoulGardenEventLogOrphanDetectedEventSchema.parse({
        type: SoulGardenEventLogOrphanDetectedEventType.SOUL_GARDEN_EVENT_LOG_ORPHAN_DETECTED,
        payload
      })
    ).toEqual({
      type: SoulGardenEventLogOrphanDetectedEventType.SOUL_GARDEN_EVENT_LOG_ORPHAN_DETECTED,
      payload
    });
  });

  it("rejects empty fields, unknown tables, invalid timestamps, and extra payload keys", () => {
    const validPayload = {
      audit_event_id: "event-1",
      event_type: "memory.usage_reported",
      expected_table: "trust_usage_proof",
      detected_at: detectedAt
    } as const;

    expect(() =>
      SoulGardenEventLogOrphanDetectedPayloadSchema.parse({
        ...validPayload,
        audit_event_id: ""
      })
    ).toThrow();
    expect(() =>
      SoulGardenEventLogOrphanDetectedPayloadSchema.parse({
        ...validPayload,
        expected_table: "memory_entries"
      })
    ).toThrow();
    expect(() =>
      SoulGardenEventLogOrphanDetectedPayloadSchema.parse({
        ...validPayload,
        detected_at: "not-a-date"
      })
    ).toThrow();
    expect(() =>
      SoulGardenEventLogOrphanDetectedPayloadSchema.parse({
        ...validPayload,
        extra: true
      })
    ).toThrow();
  });

  it("accepts the event log envelope for detected orphan events", () => {
    const entry = {
      event_id: "event-log-entry-1",
      event_type: SoulGardenEventLogOrphanDetectedEventType.SOUL_GARDEN_EVENT_LOG_ORPHAN_DETECTED,
      entity_type: "orphan_radar",
      entity_id: "radar-1",
      workspace_id: "workspace-1",
      run_id: null,
      caused_by: "auditor",
      revision: 0,
      payload_json: {
        audit_event_id: "event-1",
        event_type: "memory.delivered",
        expected_table: "trust_context_delivery",
        detected_at: detectedAt
      },
      created_at: detectedAt
    } as const;

    expect(EventLogEntrySchema.parse(entry)).toEqual(entry);
  });
});
