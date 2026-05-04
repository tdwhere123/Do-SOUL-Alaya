import { describe, expect, it } from "vitest";
import {
  EventTypeSchema,
  SlotEventType,
  SlotEventTypeSchema,
  ScopeClass,
  TransitionCausedBy,
  canonicalGovernanceSubject,
  parseSlotEventPayload
} from "../index.js";

const validTimestamp = "2026-03-21T00:00:00.000Z";

describe("Phase 2A event schemas", () => {
  it("keeps SlotEventType enum complete and closed", () => {
    const expected = [
      "soul.slot.created",
      "soul.slot.winner_changed",
      "soul.conflict_matrix_edge.created"
    ];

    expect(Object.values(SlotEventType)).toEqual(expected);
    expect(SlotEventTypeSchema.options).toEqual(expected);
  });

  it("parses soul.slot.created payload", () => {
    const payload = {
      object_id: "slot-1",
      object_kind: "slot",
      workspace_id: "workspace-1",
      run_id: null,
      governance_subject: canonicalGovernanceSubject("security", { category: "secrets" }),
      claim_kind: "constraint",
      scope_class: ScopeClass.PROJECT,
      winner_claim_id: "claim-1"
    } as const;

    expect(parseSlotEventPayload(SlotEventType.SOUL_SLOT_CREATED, payload)).toEqual(payload);
  });

  it("parses soul.slot.winner_changed payload", () => {
    const payload = {
      object_id: "slot-1",
      object_kind: "slot",
      workspace_id: "workspace-1",
      run_id: null,
      from_claim_id: "claim-1",
      to_claim_id: "claim-2",
      reason_code: "scope_escalation",
      caused_by: TransitionCausedBy.SYSTEM,
      evidence_refs: ["evidence-1"],
      occurred_at: validTimestamp
    } as const;

    expect(parseSlotEventPayload(SlotEventType.SOUL_SLOT_WINNER_CHANGED, payload)).toEqual(payload);
  });

  it("accepts slot event types in EventType union", () => {
    expect(EventTypeSchema.parse(SlotEventType.SOUL_SLOT_CREATED)).toBe(SlotEventType.SOUL_SLOT_CREATED);
    expect(EventTypeSchema.parse(SlotEventType.SOUL_SLOT_WINNER_CHANGED)).toBe(
      SlotEventType.SOUL_SLOT_WINNER_CHANGED
    );
  });
});
