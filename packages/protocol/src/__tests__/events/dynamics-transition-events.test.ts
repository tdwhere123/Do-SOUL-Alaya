import { describe, expect, it } from "vitest";
import {
  EventTypeSchema,
  SignalEventType,
  WorkspaceRunEventType,
  MemoryGovernanceEventType,
  MemoryGovernanceEventTypeSchema,
  StorageTier,
  TransitionCausedBy,
  TransitionCausedBySchema,
  TransitionRecordSchema,
  parseMemoryGovernanceEventPayload
} from "../../index.js";

const validTimestamp = "2026-03-20T00:00:00.000Z";

const transitionBase = {
  object_id: "object-1",
  object_kind: "memory_entry",
  workspace_id: "workspace-1",
  run_id: "run-1",
  from_state: "draft",
  to_state: "active",
  reason_code: "review_accepted",
  caused_by: TransitionCausedBy.REVIEW,
  evidence_refs: ["evidence-1"],
  occurred_at: validTimestamp
} as const;

function transitionPayloadFor(eventType: string): Record<string, unknown> {
  if (eventType === MemoryGovernanceEventType.SOUL_MEMORY_RETENTION_UPDATED) {
    return {
      ...transitionBase,
      retention_score: 0.88
    };
  }

  return { ...transitionBase };
}

describe("EventType and TransitionRecord", () => {
  it("includes Phase 0 + Phase 0.5 + Phase 1B+ event types", () => {
    const eventTypes = [
      WorkspaceRunEventType.RUN_CREATED,
      SignalEventType.SOUL_SIGNAL_EMITTED,
      MemoryGovernanceEventType.SOUL_EVIDENCE_CREATED,
      MemoryGovernanceEventType.SOUL_EVIDENCE_DELETED,
      MemoryGovernanceEventType.SOUL_MEMORY_STATE_CHANGED,
      MemoryGovernanceEventType.SOUL_REVIEW_COMPLETED
    ] as const;

    for (const eventType of eventTypes) {
      expect(EventTypeSchema.parse(eventType)).toBe(eventType);
    }
  });

  it("parses TransitionRecord round-trip", () => {
    const value = {
      from_state: "draft",
      to_state: "active",
      reason_code: "review_accepted",
      caused_by: TransitionCausedBy.REVIEW,
      evidence_refs: ["evidence-1"],
      occurred_at: validTimestamp
    } as const;

    expect(TransitionRecordSchema.parse(value)).toEqual(value);
  });

  it("requires TransitionRecord fields for transition events", () => {
    const transitionEventTypes = [
      MemoryGovernanceEventType.SOUL_EVIDENCE_HEALTH_CHANGED,
      MemoryGovernanceEventType.SOUL_EVIDENCE_DELETED,
      MemoryGovernanceEventType.SOUL_MEMORY_STATE_CHANGED,
      MemoryGovernanceEventType.SOUL_MEMORY_RETENTION_UPDATED,
      MemoryGovernanceEventType.SOUL_MEMORY_MANIFESTATION_CHANGED,
      MemoryGovernanceEventType.SOUL_SYNTHESIS_PROMOTED,
      MemoryGovernanceEventType.SOUL_CLAIM_LIFECYCLE_CHANGED,
      MemoryGovernanceEventType.SOUL_CLAIM_WON,
      MemoryGovernanceEventType.SOUL_CLAIM_SUPERSEDED,
      MemoryGovernanceEventType.SOUL_PROPOSAL_RESOLVED,
      MemoryGovernanceEventType.SOUL_REVIEW_COMPLETED
    ] as const;

    for (const eventType of transitionEventTypes) {
      const validPayload = transitionPayloadFor(eventType);
      expect(parseMemoryGovernanceEventPayload(eventType, validPayload)).toEqual(validPayload);

      const missingFromState = { ...validPayload };
      delete missingFromState.from_state;

      expect(() => parseMemoryGovernanceEventPayload(eventType, missingFromState)).toThrow();
    }
  });

  it("parses recall-hit tier promotion payloads", () => {
    const payload = {
      object_id: "memory-1",
      object_kind: "memory_entry",
      workspace_id: "workspace-1",
      run_id: "run-1",
      from_tier: StorageTier.WARM,
      to_tier: StorageTier.HOT,
      reason: "recall_hit",
      occurred_at: validTimestamp
    } as const;

    expect(
      parseMemoryGovernanceEventPayload(
        MemoryGovernanceEventType.SOUL_MEMORY_TIER_PROMOTED,
        payload
      )
    ).toEqual(payload);

    expect(() =>
      parseMemoryGovernanceEventPayload(
        MemoryGovernanceEventType.SOUL_MEMORY_TIER_PROMOTED,
        { ...payload, reason: "not-a-promotion-reason" }
      )
    ).toThrow();
  });

  it("keeps caused_by enum complete and closed", () => {
    const expectedValues = ["user", "system", "review", "deterministic_rule", "auditor", "bootstrap"];
    expect(Object.values(TransitionCausedBy)).toEqual(expectedValues);
    expect(TransitionCausedBySchema.options).toEqual(expectedValues);
  });

  it("keeps MemoryGovernanceEventType enum complete and closed", () => {
    const expectedValues = [
      "soul.evidence.created",
      "soul.evidence.health_changed",
      "soul.evidence.deleted",
      "soul.memory.created",
      "soul.memory.updated",
      "soul.memory.archived",
      "soul.memory.state_changed",
      "soul.memory.retention_updated",
      "soul.memory.manifestation_changed",
      "soul.memory.tier_changed",
      "soul.memory.tier_promoted",
      "soul.synthesis.created",
      "soul.synthesis.status_changed",
      "soul.synthesis.promoted",
      "soul.claim.created",
      "soul.claim.lifecycle_changed",
      "soul.claim.contested",
      "soul.claim.won",
      "soul.claim.superseded",
      "soul.proposal.created",
      "soul.proposal.resolved",
      "soul.review.created",
      "soul.review.completed"
    ];
    expect(Object.values(MemoryGovernanceEventType)).toEqual(expectedValues);
    expect(MemoryGovernanceEventTypeSchema.options).toEqual(expectedValues);
  });

  it("keeps Phase 0 event types backward-compatible in EventType union", () => {
    expect(EventTypeSchema.parse(WorkspaceRunEventType.WORKSPACE_CREATED)).toBe(WorkspaceRunEventType.WORKSPACE_CREATED);
  });
});
