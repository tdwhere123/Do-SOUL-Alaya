import { describe, expect, it } from "vitest";
import {
  DYNAMICS_CONSTANTS,
  EventTypeSchema,
  MemoryDimension,
  Phase05EventType,
  Phase0EventType,
  Phase1BEventType,
  Phase1BEventTypeSchema,
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
  TransitionCausedBy,
  TransitionCausedBySchema,
  TransitionRecordSchema,
  parsePhase1BEventPayload
} from "../index.js";

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
  if (eventType === Phase1BEventType.SOUL_MEMORY_RETENTION_UPDATED) {
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

describe("MCP tool request/response schemas", () => {
  it("parses all request payloads round-trip", () => {
    const requestCases = [
      {
        schema: SoulEmitCandidateSignalRequestSchema,
        value: {
          workspace_id: "workspace-1",
          run_id: "run-1",
          surface_id: null,
          signal_kind: "potential_claim",
          object_kind: "claim_form",
          scope_hint: null,
          domain_tags: ["repo"],
          confidence: 0.7,
          evidence_refs: ["message-1"],
          raw_payload: { summary: "candidate signal" }
        }
      },
      {
        schema: SoulMemorySearchRequestSchema,
        value: {
          query: "pnpm",
          scope_class: ScopeClass.PROJECT,
          dimension: MemoryDimension.PROCEDURE,
          domain_tags: ["repo", "tooling"],
          max_results: 20
        }
      },
      {
        schema: SoulOpenPointerRequestSchema,
        value: {
          object_id: "memory-1"
        }
      },
      {
        schema: SoulExploreGraphRequestSchema,
        value: {
          // p5-system-review-r2 F-r2-001: workspace_id removed from public schema;
          // bound from MCP call context server-side per invariants §29.
          memory_id: "memory-1",
          edge_types: ["supports", "incompatible_with"],
          direction: "both"
        }
      },
      {
        schema: SoulProposeMemoryUpdateRequestSchema,
        value: {
          target_object_id: "memory-1",
          proposed_changes: { summary: "Use pnpm for scripts." },
          reason: "Align build docs with workspace tooling."
        }
      },
      {
        schema: SoulReviewMemoryProposalRequestSchema,
        value: {
          proposal_id: "proposal-1",
          verdict: "accept",
          reason: "Confirmed by reviewer."
        }
      },
      {
        schema: SoulReportContextUsageRequestSchema,
        value: {
          delivery_id: "delivery-1",
          usage_state: "used",
          used_object_ids: ["memory-1"],
          reason: "The final answer cited this memory."
        }
      }
    ] as const;

    for (const { schema, value } of requestCases) {
      expect(schema.parse(value)).toEqual(value);
    }
  });

  it("parses all response payloads round-trip", () => {
    const responseCases = [
      {
        schema: SoulEmitCandidateSignalResponseSchema,
        value: {
          signal_id: "signal-1",
          status: "emitted"
        }
      },
      {
        schema: SoulMemorySearchResponseSchema,
        value: {
          delivery_id: "delivery-1",
          results: [
            {
              object_id: "memory-1",
              object_kind: "memory_entry",
              relevance_score: 0.91,
              content_preview: "Use pnpm for monorepo commands.",
              evidence_pointers: ["evidence-1"]
            }
          ],
          total_count: 1
        }
      },
      {
        schema: SoulOpenPointerResponseSchema,
        value: {
          // p5-system-review-r3 MR-I05: content is now an explicit
          // projection (object_id / object_kind / schema_version /
          // content / domain_tags / evidence_refs); MemoryEntry
          // internals (lifecycle_state, created_by, ...) no longer leak.
          object_id: "memory-1",
          object_kind: "memory_entry",
          content: {
            object_id: "memory-1",
            object_kind: "memory_entry",
            schema_version: 1,
            content: "Use pnpm for workspace commands.",
            domain_tags: [],
            evidence_refs: []
          }
        }
      },
      {
        schema: SoulExploreGraphResponseSchema,
        value: {
          source_memory_id: "memory-1",
          neighbors: [
            {
              memory_id: "memory-2",
              edge_type: "supports",
              direction: "outbound",
              edge_id: "edge-1"
            }
          ],
          count: 1
        }
      },
      {
        schema: SoulProposeMemoryUpdateResponseSchema,
        value: {
          proposal_id: "proposal-1",
          status: "created"
        }
      },
      {
        schema: SoulReviewMemoryProposalResponseSchema,
        value: {
          proposal_id: "proposal-1",
          resolution_state: "accepted"
        }
      },
      {
        schema: SoulReportContextUsageResponseSchema,
        value: {
          delivery_id: "delivery-1",
          status: "recorded"
        }
      }
    ] as const;

    for (const { schema, value } of responseCases) {
      expect(schema.parse(value)).toEqual(value);
    }
  });

  it("rejects the legacy generic graph explore contract", () => {
    expect(() =>
      SoulExploreGraphRequestSchema.parse({
        root_object_id: "claim-1",
        depth: 1,
        edge_types: ["supports"]
      })
    ).toThrow();

    expect(() =>
      SoulExploreGraphResponseSchema.parse({
        nodes: [{ object_id: "claim-1", object_kind: "claim_form", label: "Use pnpm" }],
        edges: [{ source_id: "claim-1", target_id: "memory-1", edge_type: "supports" }]
      })
    ).toThrow();
  });
});

describe("EventType and TransitionRecord", () => {
  it("includes Phase 0 + Phase 0.5 + Phase 1B+ event types", () => {
    const eventTypes = [
      Phase0EventType.RUN_CREATED,
      Phase05EventType.SOUL_SIGNAL_EMITTED,
      Phase1BEventType.SOUL_EVIDENCE_CREATED,
      Phase1BEventType.SOUL_MEMORY_STATE_CHANGED,
      Phase1BEventType.SOUL_REVIEW_COMPLETED
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
      Phase1BEventType.SOUL_EVIDENCE_HEALTH_CHANGED,
      Phase1BEventType.SOUL_MEMORY_STATE_CHANGED,
      Phase1BEventType.SOUL_MEMORY_RETENTION_UPDATED,
      Phase1BEventType.SOUL_MEMORY_MANIFESTATION_CHANGED,
      Phase1BEventType.SOUL_SYNTHESIS_PROMOTED,
      Phase1BEventType.SOUL_CLAIM_LIFECYCLE_CHANGED,
      Phase1BEventType.SOUL_CLAIM_WON,
      Phase1BEventType.SOUL_CLAIM_SUPERSEDED,
      Phase1BEventType.SOUL_PROPOSAL_RESOLVED,
      Phase1BEventType.SOUL_REVIEW_COMPLETED
    ] as const;

    for (const eventType of transitionEventTypes) {
      const validPayload = transitionPayloadFor(eventType);
      expect(parsePhase1BEventPayload(eventType, validPayload)).toEqual(validPayload);

      const missingFromState = { ...validPayload };
      delete missingFromState.from_state;

      expect(() => parsePhase1BEventPayload(eventType, missingFromState)).toThrow();
    }
  });

  it("keeps caused_by enum complete and closed", () => {
    const expectedValues = ["user", "system", "review", "deterministic_rule", "auditor", "bootstrap"];
    expect(Object.values(TransitionCausedBy)).toEqual(expectedValues);
    expect(TransitionCausedBySchema.options).toEqual(expectedValues);
  });

  it("keeps Phase1BEventType enum complete and closed", () => {
    const expectedValues = [
      "soul.evidence.created",
      "soul.evidence.health_changed",
      "soul.memory.created",
      "soul.memory.updated",
      "soul.memory.archived",
      "soul.memory.state_changed",
      "soul.memory.retention_updated",
      "soul.memory.manifestation_changed",
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
    expect(Object.values(Phase1BEventType)).toEqual(expectedValues);
    expect(Phase1BEventTypeSchema.options).toEqual(expectedValues);
  });

  it("keeps Phase 0 event types backward-compatible in EventType union", () => {
    expect(EventTypeSchema.parse(Phase0EventType.WORKSPACE_CREATED)).toBe(Phase0EventType.WORKSPACE_CREATED);
  });
});
