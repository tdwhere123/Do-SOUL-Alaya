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
  TransitionCausedBy,
  TransitionCausedBySchema,
  TransitionRecordSchema,
  parseMemoryGovernanceEventPayload
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

describe("MCP tool request/response schemas", () => {
  it("parses all request payloads round-trip", () => {
    const requestCases = [
      {
        schema: SoulEmitCandidateSignalRequestSchema,
        // gate-6-delta I5: workspace_id / run_id / surface_id are bound
        // from trusted MCP context; the public schema rejects them.
        value: {
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
          // p5-system-review-r3 MR-I03: proposed_changes is now
          // PublicMemoryEntryMutableFieldsSchema (strict). Allowed
          // keys: content, domain_tags, evidence_refs, storage_tier.
          target_object_id: "memory-1",
          proposed_changes: { content: "Use pnpm for scripts." },
          reason: "Align build docs with workspace tooling."
        }
      },
      {
        schema: SoulReviewMemoryProposalRequestSchema,
        value: {
          // A1 (HITL daemon backbone): reviewer_identity is required so
          // every review record carries an explicit reviewer string.
          proposal_id: "proposal-1",
          verdict: "accept",
          reason: "Confirmed by reviewer.",
          reviewer_identity: "user:alice"
        }
      },
      {
        schema: SoulReportContextUsageRequestSchema,
        value: {
          delivery_id: "delivery-1",
          usage_state: "used",
          used_object_ids: ["memory-1"],
          per_anchor_usage: [{ object_id: "memory-1", anchor_role: "target" }],
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
              evidence_pointers: ["evidence-1"],
              selection_reason: "Selected by lexical and activation ranking.",
              source_channels: ["workspace_local", "keyword"],
              score_factors: {
                activation: 0.8,
                relevance: 0.91,
                graph_support: 0,
                path_plasticity: 0,
                budget_penalty: 0
              },
              budget_state: {
                token_estimate: 8,
                max_entries: 3,
                max_total_tokens: 2000,
                remaining_entries: 2,
                remaining_tokens: 1992,
                within_budget: true
              }
            }
          ],
          total_count: 1,
          strategy_mix: {
            deterministic_match: true,
            precomputed_rank: true,
            semantic_supplement: true,
            graph_support: true,
            path_plasticity: true,
            global_recall: true
          },
          degradation_reason: null
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

  it("accepts recall cascade degradation_reason values", () => {
    const baseResponse = {
      delivery_id: "delivery-1",
      results: [],
      total_count: 0,
      strategy_mix: {
        deterministic_match: true,
        precomputed_rank: true,
        semantic_supplement: false,
        graph_support: false,
        path_plasticity: false,
        global_recall: false
      }
    };

    expect(SoulMemorySearchResponseSchema.parse({
      ...baseResponse,
      degradation_reason: "recall_explainability_partial"
    }).degradation_reason).toBe("recall_explainability_partial");
    expect(SoulMemorySearchResponseSchema.parse({
      ...baseResponse,
      degradation_reason: "warm_cascade_engaged"
    }).degradation_reason).toBe("warm_cascade_engaged");
    expect(SoulMemorySearchResponseSchema.parse({
      ...baseResponse,
      degradation_reason: "cold_cascade_engaged"
    }).degradation_reason).toBe("cold_cascade_engaged");
  });

  it("rejects unknown recall degradation_reason values", () => {
    const baseResponse = {
      delivery_id: "delivery-1",
      results: [],
      total_count: 0,
      strategy_mix: {
        deterministic_match: true,
        precomputed_rank: true,
        semantic_supplement: false,
        graph_support: false,
        path_plasticity: false,
        global_recall: false
      }
    };

    expect(SoulMemorySearchResponseSchema.safeParse({
      ...baseResponse,
      degradation_reason: "frozen_cascade_engaged"
    }).success).toBe(false);
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

  // gate-6-delta I5: SoulEmitCandidateSignalRequestSchema must reject
  // payload-supplied scope fields. The MCP daemon binds workspace_id /
  // run_id / surface_id from the trusted call context per §29 Default
  // Scope; allowing them in the public schema would teach attached
  // LLMs to learn and replay their own scope, reopening the
  // prompt-inject vector.
  it.each([
    { extraField: "workspace_id", extraValue: "workspace-other" },
    { extraField: "run_id", extraValue: "run-other" },
    { extraField: "surface_id", extraValue: "surface-other" }
  ])(
    "rejects soul.emit_candidate_signal payloads that supply $extraField",
    ({ extraField, extraValue }) => {
      const baseValue = {
        signal_kind: "potential_claim",
        object_kind: "claim_form",
        scope_hint: null,
        domain_tags: ["repo"] as readonly string[],
        confidence: 0.7,
        evidence_refs: ["message-1"] as readonly string[],
        raw_payload: { summary: "candidate signal" }
      };

      expect(() =>
        SoulEmitCandidateSignalRequestSchema.parse({
          ...baseValue,
          [extraField]: extraValue
        })
      ).toThrow();
    }
  );
});

describe("EventType and TransitionRecord", () => {
  it("includes Phase 0 + Phase 0.5 + Phase 1B+ event types", () => {
    const eventTypes = [
      WorkspaceRunEventType.RUN_CREATED,
      SignalEventType.SOUL_SIGNAL_EMITTED,
      MemoryGovernanceEventType.SOUL_EVIDENCE_CREATED,
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

  it("keeps caused_by enum complete and closed", () => {
    const expectedValues = ["user", "system", "review", "deterministic_rule", "auditor", "bootstrap"];
    expect(Object.values(TransitionCausedBy)).toEqual(expectedValues);
    expect(TransitionCausedBySchema.options).toEqual(expectedValues);
  });

  it("keeps MemoryGovernanceEventType enum complete and closed", () => {
    const expectedValues = [
      "soul.evidence.created",
      "soul.evidence.health_changed",
      "soul.memory.created",
      "soul.memory.updated",
      "soul.memory.archived",
      "soul.memory.state_changed",
      "soul.memory.retention_updated",
      "soul.memory.manifestation_changed",
      "soul.memory.tier_changed",
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
