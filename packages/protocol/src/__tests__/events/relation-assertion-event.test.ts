import { describe, expect, it } from "vitest";
import { EventTypeSchema } from "../../events/event-log.js";
import {
  RuntimeGovernanceEventType,
  parseRuntimeGovernanceEventPayload
} from "../../events/runtime-governance.js";

const timestamp = "2026-07-17T00:00:00.000Z";

describe("RelationAssertion EventLog contracts", () => {
  it("registers a typed immutable-assertion admission", () => {
    const payload = {
      assertion_id: "assertion-1",
      workspace_id: "workspace-1",
      evidence_receipts: [{
        evidence_id: "evidence-1",
        source_event_anchor: {
          event_type: "soul.signal.emitted",
          event_id: "source-event-1",
          occurred_at: "2026-07-16T23:59:00.000Z"
        }
      }],
      formation_receipt: {
        operator_id: "test_relation_operator_v1",
        operator_sha256: "a".repeat(64),
        parameters: { threshold: 3 },
        parameter_sha256: "b".repeat(64),
        source_observations: [{
          source_kind: "event_log_entry",
          source_id: "observation-1",
          source_sha256: "c".repeat(64)
        }],
        decision: { matched: true },
        decision_sha256: "d".repeat(64)
      },
      anchors: {
        source_anchor: { kind: "object", object_id: "object-1" },
        target_anchor: { kind: "object", object_id: "object-2" }
      },
      relation_kind: "supports",
      validity: {
        kind: "bounded",
        valid_from: "2026-07-01T00:00:00.000Z",
        valid_to: "2026-08-01T00:00:00.000Z"
      },
      admitted_at: timestamp
    } as const;

    expect(EventTypeSchema.parse("relation.assertion_admitted")).toBe(
      "relation.assertion_admitted"
    );
    expect(
      parseRuntimeGovernanceEventPayload(RuntimeGovernanceEventType.RELATION_ASSERTION_ADMITTED, payload)
    ).toEqual(payload);
  });

  it("registers only typed append-only resolutions", () => {
    const payload = {
      resolution_id: "resolution-1",
      assertion_id: "assertion-1",
      workspace_id: "workspace-1",
      resolution_kind: "retracted",
      resolved_at: timestamp,
      reason: "evidence withdrawn"
    } as const;

    expect(EventTypeSchema.parse("relation.assertion_resolved")).toBe(
      "relation.assertion_resolved"
    );
    expect(
      parseRuntimeGovernanceEventPayload(RuntimeGovernanceEventType.RELATION_ASSERTION_RESOLVED, payload)
    ).toEqual(payload);
    expect(() =>
      parseRuntimeGovernanceEventPayload(RuntimeGovernanceEventType.RELATION_ASSERTION_RESOLVED, {
        ...payload,
        resolution_kind: "deleted"
      })
    ).toThrow();
  });
});
