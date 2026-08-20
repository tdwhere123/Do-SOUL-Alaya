import { describe, expect, it } from "vitest";
import {
  MemoryDimension,
  MemorySearchResultSchema,
  ScopeClass,
  SoulMemorySearchResponseSchema,
  type MemorySearchResult,
  type RecallCandidate,
  type RecallPolicy
} from "@do-soul/alaya-protocol";
import {
  buildMemorySearchResult,
  buildRecallStrategyMix,
  resolveMcpDegradationReason
} from "../../../mcp-memory/recall/recall-result.js";

const GOLDEN_MCP_RECALL_RESULT = Object.freeze({
  object_id: "memory-1",
  object_kind: "memory_entry",
  relevance_score: 0.5,
  content_preview: "Recall content",
  evidence_pointers: ["memory-1"],
  selection_reason:
    "Selected by workspace recall. Final fusion evidence score 0.500000; " +
    "diagnostic supporting signals: activation 0.800, graph support 0.400.",
  source_channels: ["ranked_recall", "workspace_local"],
  score_factors: Object.freeze({
    activation: 0.8,
    relevance: 0.5,
    graph_support: 0.4
  }),
  budget_state: Object.freeze({
    token_estimate: 4,
    max_entries: 10,
    max_total_tokens: 100,
    remaining_entries: 9,
    remaining_tokens: 96,
    within_budget: true
  })
});

describe("buildMemorySearchResult", () => {
  it("projects the final relevance scalar into MCP reason and score factors", () => {
    const candidate: RecallCandidate = {
      object_id: "memory-1",
      object_kind: "memory_entry",
      activation_score: 0.8,
      relevance_score: 0.5,
      content_preview: "Recall content",
      token_estimate: 4,
      manifestation: "full_eligible",
      dimension: MemoryDimension.PROCEDURE,
      scope_class: ScopeClass.PROJECT,
      origin_plane: "workspace_local",
      selection_reason: GOLDEN_MCP_RECALL_RESULT.selection_reason,
      score_factors: {
        activation: 0.8,
        relevance: 0.5,
        graph_support: 0.4
      }
    };

    const result = buildMemorySearchResult(candidate, createPolicy(), 0, 0);

    expect(result.relevance_score).toBe(0.5);
    expect(result.selection_reason).toBe(candidate.selection_reason);
    expect(result.selection_reason).toContain("Final fusion evidence score 0.500000");
    expect(result.selection_reason).toContain("diagnostic supporting signals");
    expect(result.score_factors).toMatchObject({
      activation: 0.8,
      relevance: 0.5,
      graph_support: 0.4
    });
  });

  it("freezes the MCP soul.recall result shape as a golden fixture", () => {
    const candidate: RecallCandidate = {
      object_id: GOLDEN_MCP_RECALL_RESULT.object_id,
      object_kind: "memory_entry",
      activation_score: GOLDEN_MCP_RECALL_RESULT.score_factors.activation,
      relevance_score: GOLDEN_MCP_RECALL_RESULT.relevance_score,
      content_preview: GOLDEN_MCP_RECALL_RESULT.content_preview,
      token_estimate: GOLDEN_MCP_RECALL_RESULT.budget_state.token_estimate,
      manifestation: "full_eligible",
      dimension: MemoryDimension.PROCEDURE,
      scope_class: ScopeClass.PROJECT,
      origin_plane: "workspace_local",
      selection_reason: GOLDEN_MCP_RECALL_RESULT.selection_reason,
      source_channels: GOLDEN_MCP_RECALL_RESULT.source_channels,
      score_factors: { ...GOLDEN_MCP_RECALL_RESULT.score_factors }
    };

    const result = buildMemorySearchResult(candidate, createPolicy(), 0, 0);
    const parsed = MemorySearchResultSchema.parse(result);

    expect(parsed).toEqual(GOLDEN_MCP_RECALL_RESULT);
    expect(Object.keys(parsed.score_factors).sort()).toEqual(
      ["activation", "graph_support", "relevance"].sort()
    );
    expect(typeof parsed.selection_reason).toBe("string");
    expect(typeof parsed.score_factors.activation).toBe("number");
    expect(typeof parsed.score_factors.relevance).toBe("number");
  });
});

describe("buildRecallStrategyMix", () => {
  it("keeps semantic_supplement false when embedding is disabled even if scores look semantic", () => {
    const results: MemorySearchResult[] = [
      {
        object_id: "memory-1",
        object_kind: "memory_entry",
        relevance_score: 0.9,
        content_preview: "semantic-looking hit",
        evidence_pointers: ["memory-1"],
        selection_reason: "Selected by workspace recall.",
        source_channels: ["ranked_recall", "workspace_local", "semantic_supplement"],
        score_factors: {
          activation: 0.5,
          relevance: 0.9,
          embedding_similarity: 0.88
        },
        budget_state: {
          token_estimate: 4,
          max_entries: 10,
          max_total_tokens: 100,
          remaining_entries: 9,
          remaining_tokens: 96,
          within_budget: true
        }
      }
    ];

    const mix = buildRecallStrategyMix(createPolicy(), results, {
      embedding_supplement_status: "disabled"
    });

    expect(mix.semantic_supplement).toBe(false);
  });

  it("sets semantic_supplement true only when embedding_supplement_status is requested", () => {
    const mix = buildRecallStrategyMix(createPolicy(), [], {
      embedding_supplement_status: "requested"
    });
    expect(mix.semantic_supplement).toBe(true);

    expect(
      buildRecallStrategyMix(createPolicy(), [], {
        embedding_supplement_status: "provider_missing"
      }).semantic_supplement
    ).toBe(false);
  });
});

describe("resolveMcpDegradationReason", () => {
  it("maps provider_missing and no_stored_vectors to non-null MCP degradation_reason", () => {
    expect(
      resolveMcpDegradationReason(
        {
          diagnostics: {
            embedding_supplement_status: "provider_missing"
          }
        },
        false
      )
    ).toBe("provider_missing");

    expect(
      resolveMcpDegradationReason(
        {
          diagnostics: {
            embedding_supplement_status: "not_attempted",
            provider_degradation_reason: "no_stored_vectors"
          }
        },
        false
      )
    ).toBe("no_stored_vectors");
  });

  it("maps provider unavailable/failed diagnostics without leaving null", () => {
    expect(
      resolveMcpDegradationReason(
        {
          diagnostics: {
            embedding_supplement_status: "requested",
            provider_degradation_reason: "provider_unavailable"
          }
        },
        false
      )
    ).toBe("provider_unavailable");

    expect(
      resolveMcpDegradationReason(
        {
          diagnostics: {
            embedding_supplement_status: "requested",
            embedding_provider_status: "provider_failed"
          }
        },
        false
      )
    ).toBe("provider_failed");
  });

  it("maps query_embedding_unusable to MCP provider_failed instead of null", () => {
    expect(
      resolveMcpDegradationReason(
        {
          diagnostics: {
            embedding_supplement_status: "requested",
            embedding_provider_status: "query_embedding_unusable",
            provider_degradation_reason: "query_embedding_unusable"
          }
        },
        false
      )
    ).toBe("provider_failed");

    expect(
      resolveMcpDegradationReason(
        {
          diagnostics: {
            embedding_supplement_status: "requested",
            embedding_provider_status: "query_embedding_unusable"
          }
        },
        false
      )
    ).toBe("provider_failed");
  });

  it("does not invent degradation when embedding was intentionally disabled", () => {
    expect(
      resolveMcpDegradationReason(
        {
          diagnostics: {
            embedding_supplement_status: "disabled",
            embedding_provider_status: "provider_not_requested",
            provider_degradation_reason: null
          }
        },
        false
      )
    ).toBeNull();
  });

  it("does not invent provider_unavailable from provider_warmup_pending when embedding is disabled", () => {
    expect(
      resolveMcpDegradationReason(
        {
          diagnostics: {
            embedding_supplement_status: "disabled",
            provider_degradation_reason: "provider_warmup_pending"
          }
        },
        false
      )
    ).toBeNull();
  });

  it("still surfaces hard embedding failures when supplement status is disabled", () => {
    expect(
      resolveMcpDegradationReason(
        {
          diagnostics: {
            embedding_supplement_status: "disabled",
            provider_degradation_reason: "query_embedding_failed"
          }
        },
        false
      )
    ).toBe("provider_failed");
  });

  it("does not invent MCP degradation_reason for unknown provider_degradation_reason strings", () => {
    expect(
      resolveMcpDegradationReason(
        {
          diagnostics: {
            embedding_supplement_status: "requested",
            provider_degradation_reason: "totally_unknown_diagnostic"
          }
        },
        false
      )
    ).toBeNull();
  });

  it("preserves cascade degradation_reason over embedding mapping", () => {
    expect(
      resolveMcpDegradationReason(
        {
          degradation_reason: "cold_cascade_engaged",
          diagnostics: {
            embedding_supplement_status: "provider_missing"
          }
        },
        false
      )
    ).toBe("cold_cascade_engaged");
  });

  it("emits schema-valid SoulMemorySearchResponse degradation_reason values", () => {
    for (const reason of [
      "provider_missing",
      "provider_unavailable",
      "provider_failed",
      "no_stored_vectors"
    ] as const) {
      const parsed = SoulMemorySearchResponseSchema.parse({
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
        },
        degradation_reason: reason
      });
      expect(parsed.degradation_reason).toBe(reason);
    }
  });
});

function createPolicy(): RecallPolicy {
  return {
    coarse_filter: {
      precomputed_rank: {
        max_candidates: 10
      }
    },
    fine_assessment: {
      conflict_awareness: false,
      budgets: {
        max_entries: 10,
        max_total_tokens: 100,
        per_dimension_limits: null
      }
    }
  } as RecallPolicy;
}
