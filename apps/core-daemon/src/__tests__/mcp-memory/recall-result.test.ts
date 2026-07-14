import { describe, expect, it } from "vitest";
import {
  MemoryDimension,
  MemorySearchResultSchema,
  ScopeClass,
  type RecallCandidate,
  type RecallPolicy
} from "@do-soul/alaya-protocol";
import { buildMemorySearchResult } from "../../mcp-memory/recall-result.js";

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

function createPolicy(): RecallPolicy {
  return {
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
