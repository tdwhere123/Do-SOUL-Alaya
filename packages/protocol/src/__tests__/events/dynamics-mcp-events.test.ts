import { describe, expect, it } from "vitest";
import {
  DYNAMICS_CONSTANTS,
  EventTypeSchema,
  MemoryDimension,
  SignalEventType,
  WorkspaceRunEventType,
  MemoryGovernanceEventType,
  MemoryGovernanceEventTypeSchema,
  ScopeClass,
  SoulEmitCandidateSignalRequestSchema,
  SoulEmitCandidateSignalResponseSchema,
  SoulExploreGraphRequestSchema,
  SoulExploreGraphResponseSchema,
  SoulMemorySearchRequestSchema,
  SoulMemorySearchResponseSchema,
  SoulOpenPointerRequestSchema,
  SoulOpenPointerResponseSchema,
  SoulProposeMemoryUpdateRequestSchema,
  SoulProposeMemoryUpdateResponseSchema,
  SoulReportContextUsageRequestSchema,
  SoulReportContextUsageResponseSchema,
  SoulReviewMemoryProposalRequestSchema,
  SoulReviewMemoryProposalResponseSchema,
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

describe("DYNAMICS_CONSTANTS", () => {
  it("is a readonly frozen object", () => {
    expect(Object.isFrozen(DYNAMICS_CONSTANTS)).toBe(true);
  });

  it("has the expected decay profiles", () => {
    expect(DYNAMICS_CONSTANTS.decay_profiles).toEqual({
      pinned: { half_life: Infinity, r_min: 0.8 },
      stable: { half_life: 90 * 24 * 3600 * 1000, r_min: 0.3 },
      normal: { half_life: 30 * 24 * 3600 * 1000, r_min: 0.1 },
      volatile: { half_life: 7 * 24 * 3600 * 1000, r_min: 0.05 },
      hazard: { half_life: 365 * 24 * 3600 * 1000, r_min: 0.5 }
    });
  });

  it("has the expected karma amounts", () => {
    expect(DYNAMICS_CONSTANTS.karma).toEqual({
      accept_gain: 0.15,
      reuse_gain: 0.05,
      evidence_gain: 0.1,
      supersede_penalty: -0.2,
      reject_penalty: -0.3
    });
  });

  it("keeps activation weights normalized to 1.0", () => {
    const total = Object.values(DYNAMICS_CONSTANTS.activation_weights_phase1b).reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it("keeps manifestation thresholds monotonic", () => {
    const { hidden_max, hint_max, excerpt_max, full_min } = DYNAMICS_CONSTANTS.manifestation_thresholds;
    expect(hidden_max).toBeLessThan(hint_max);
    expect(hint_max).toBeLessThan(excerpt_max);
    expect(excerpt_max).toBeLessThanOrEqual(full_min);
  });
});
