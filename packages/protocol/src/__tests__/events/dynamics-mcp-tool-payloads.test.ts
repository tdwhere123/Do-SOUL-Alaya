import { describe, expect, it } from "vitest";
import {
  MemoryDimension,
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
  SoulReviewMemoryProposalResponseSchema} from "../../index.js";




describe("MCP tool request/response schemas", () => {
  it("parses all request payloads round-trip", () => {
    const requestCases = [
      {
        schema: SoulEmitCandidateSignalRequestSchema,
        // workspace_id / run_id / surface_id are bound from trusted MCP
        // context; the public schema rejects them.
        value: {
          signal_kind: "potential_claim",
          object_kind: "claim_form",
          scope_hint: null,
          domain_tags: ["repo"],
          confidence: 0.7,
          evidence_refs: ["message-1"],
          source_memory_refs: [],
          supersedes_refs: [],
          exception_to_refs: [],
          contradicts_refs: [],
          incompatible_with_refs: [],
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
          // workspace_id is bound from MCP call context server-side per
          // invariants §29, not accepted from public tool input.
          memory_id: "memory-1",
          edge_types: ["supports", "incompatible_with"],
          direction: "both"
        }
      },
      {
        schema: SoulProposeMemoryUpdateRequestSchema,
        value: {
          // proposed_changes is strict PublicMemoryEntryMutableFieldsSchema.
          // Allowed keys include content, domain_tags, evidence_refs,
          // storage_tier, confidence, and retention_state.
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
          protocol_version: 1,
          results: [
            {
              object_id: "memory-1",
              object_kind: "memory_entry",
              relevance_score: 0.91,
              content_preview: "Use pnpm for monorepo commands.",
              evidence_pointers: ["evidence-1"],
              selection_reason:
                "Selected by workspace recall. Final fusion evidence score 0.910000; " +
                "diagnostic supporting signals: activation 0.800.",
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
          // content is an explicit projection (object_id / object_kind /
          // schema_version / content / domain_tags / evidence_refs);
          // MemoryEntry internals such as lifecycle_state and created_by
          // do not leak.
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

  it("parses active constraints on recall response without requiring them on older payloads", () => {
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

    expect(SoulMemorySearchResponseSchema.parse(baseResponse).active_constraints).toBeUndefined();
    expect(SoulMemorySearchResponseSchema.parse({
      ...baseResponse,
      active_constraints: [
        {
          object_id: "memory-constraint-1",
          object_kind: "memory_entry",
          content: "Do not push directly to main.",
          dimension: "constraint",
          scope_class: "project",
          governance_state: {
            claim_status: "active",
            governance_class: null,
            source_channels: ["claim_status"]
          }
        }
      ],
      active_constraints_count: 1
    }).active_constraints_count).toBe(1);
    expect(SoulMemorySearchRequestSchema.parse({
      query: "repo workflow",
      scope_class: null,
      dimension: null,
      domain_tags: null,
      max_results: 5,
      active_constraints_cap: 50
    }).active_constraints_cap).toBe(50);
    expect(SoulMemorySearchRequestSchema.safeParse({
      query: "repo workflow",
      scope_class: null,
      dimension: null,
      domain_tags: null,
      max_results: 5,
      active_constraints_cap: 51
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

  // SoulEmitCandidateSignalRequestSchema must reject payload-supplied
  // scope fields. The MCP daemon binds workspace_id / run_id / surface_id
  // from the trusted call context per §29 Default Scope; allowing them in
  // the public schema would teach attached LLMs to learn and replay their
  // own scope, reopening the prompt-inject vector.
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

