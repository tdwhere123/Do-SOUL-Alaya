import { describe, expect, it } from "vitest";
import { EventTypeSchema } from "../event-log.js";
import {
  ContextDeliveryRecordSchema,
  TrustStateEventType,
  TrustStateEventTypeSchema,
  TrustStateSchema,
  TrustSummarySchema,
  UsageProofRecordSchema
} from "../soul/trust-state.js";

const DELIVERY_AT = "2026-04-30T00:00:00.000Z";
const REPORTED_AT = "2026-04-30T00:01:00.000Z";

describe("trust state schemas", () => {
  it("registers trust-state event types in the global EventType schema", () => {
    const expected = [
      "memory.delivered",
      "memory.usage_reported",
      "trust_state.installed.recorded",
      "trust_state.configured.recorded",
      "trust_state.unverifiable.recorded"
    ];

    expect(TrustStateEventTypeSchema.options).toEqual(expected);
    for (const eventType of expected) {
      expect(EventTypeSchema.parse(eventType)).toBe(eventType);
    }
    expect(TrustStateEventType.TRUST_STATE_INSTALLED_RECORDED).toBe("trust_state.installed.recorded");
    expect(TrustStateEventType.TRUST_STATE_CONFIGURED_RECORDED).toBe("trust_state.configured.recorded");
    expect(TrustStateEventType.TRUST_STATE_UNVERIFIABLE_RECORDED).toBe(
      "trust_state.unverifiable.recorded"
    );
  });

  it("parses all trust-state enum values", () => {
    expect(TrustStateSchema.options).toEqual([
      "installed",
      "configured",
      "delivered",
      "used",
      "skipped",
      "unverifiable",
      "mixed"
    ]);

    for (const state of TrustStateSchema.options) {
      expect(TrustStateSchema.parse(state)).toBe(state);
    }
  });

  it("parses a valid context delivery record", () => {
    const record = ContextDeliveryRecordSchema.parse({
      delivery_id: "delivery-1",
      agent_target: "codex",
      workspace_id: "workspace-1",
      run_id: "run-1",
      delivered_object_ids: ["memory-1", "memory-2"],
      delivered_at: DELIVERY_AT,
      audit_event_id: "event-1"
    });

    expect(record.delivery_id).toBe("delivery-1");
    expect(record.delivered_object_ids).toEqual(["memory-1", "memory-2"]);
    expect(record.delivered_at).toBe(DELIVERY_AT);
  });

  it("rejects invalid context delivery timestamps", () => {
    expect(() =>
      ContextDeliveryRecordSchema.parse({
        delivery_id: "delivery-1",
        agent_target: "codex",
        workspace_id: "workspace-1",
        run_id: "run-1",
        delivered_object_ids: ["memory-1"],
        delivered_at: "2026-04-30 00:00:00",
        audit_event_id: "event-1"
      })
    ).toThrow();
  });

  it("parses usage proof records for all usage states", () => {
    for (const state of ["used", "skipped", "not_applicable"] as const) {
      const record = UsageProofRecordSchema.parse({
        delivery_id: "delivery-1",
        usage_state: state,
        used_object_ids: state === "used" ? ["memory-1"] : [],
        ...(state === "used"
          ? { per_anchor_usage: [{ object_id: "memory-1", anchor_role: "target" }] }
          : {}),
        reason: null,
        reported_at: REPORTED_AT,
        audit_event_id: "event-usage-1"
      });

      expect(record.usage_state).toBe(state);
      expect(record.reported_at).toBe(REPORTED_AT);
      if (state === "used") {
        expect(record.per_anchor_usage).toEqual([{ object_id: "memory-1", anchor_role: "target" }]);
      }
    }
  });

  it("rejects invalid usage-state values", () => {
    expect(() =>
      UsageProofRecordSchema.parse({
        delivery_id: "delivery-1",
        usage_state: "ignored",
        used_object_ids: [],
        reason: null,
        reported_at: REPORTED_AT,
        audit_event_id: "event-usage-1"
      })
    ).toThrow();
  });

  it("parses a valid trust summary", () => {
    const summary = TrustSummarySchema.parse({
      agent_target: "codex",
      state: "mixed",
      installed_count: 1,
      configured_count: 1,
      delivered_count: 2,
      used_count: 1,
      skipped_count: 1,
      not_applicable_count: 0,
      unverifiable_count: 0,
      last_delivery_at: DELIVERY_AT,
      last_usage_report_at: REPORTED_AT
    });

    expect(summary.state).toBe("mixed");
    expect(summary.delivered_count).toBe(2);
  });

  it("rejects negative summary counters", () => {
    expect(() =>
      TrustSummarySchema.parse({
        agent_target: "codex",
        state: "installed",
        installed_count: -1,
        configured_count: 0,
        delivered_count: 0,
        used_count: 0,
        skipped_count: 0,
        not_applicable_count: 0,
        unverifiable_count: 0,
        last_delivery_at: null,
        last_usage_report_at: null
      })
    ).toThrow();
  });
});
