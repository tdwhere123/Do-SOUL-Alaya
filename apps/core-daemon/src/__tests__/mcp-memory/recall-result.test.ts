import { describe, expect, it } from "vitest";
import {
  MemoryDimension,
  ScopeClass,
  type RecallCandidate,
  type RecallPolicy
} from "@do-soul/alaya-protocol";
import { buildMemorySearchResult } from "../../mcp-memory/recall-result.js";

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
      selection_reason:
        "Selected by workspace recall. Final fusion evidence score 0.500000; " +
        "diagnostic supporting signals: activation 0.800, graph support 0.400.",
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
