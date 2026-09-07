import { describe, expect, it } from "vitest";
import { SoulMemorySearchRequestSchema, SoulMemorySearchResponseSchema } from "../../../surfaces/mcp-memory-search-types.js";

const request = { query: "source", scope_class: null, dimension: null, domain_tags: null, max_results: 5 };
const response = {
  delivery_id: "delivery", results: [], total_count: 0,
  strategy_mix: {
    deterministic_match: false, precomputed_rank: false, semantic_supplement: false,
    graph_support: false, path_plasticity: false, global_recall: false
  }
};

// Public compatibility remains until the minor deprecation window in invariant §25 closes.
describe("retired Recall surface sibling compatibility", () => {
  it("retains old response fields as parseable history without requiring them on new responses", () => {
    for (const delivery_path of ["legacy", "canonical"] as const) {
      for (const ranking_authority of ["prefix_sk", "select_gamma"] as const) {
        expect(SoulMemorySearchResponseSchema.parse({ ...response, delivery_path, ranking_authority }))
          .toEqual({ ...response, delivery_path, ranking_authority });
      }
    }
    expect(SoulMemorySearchResponseSchema.parse(response)).toEqual(response);
  });

  it("retains recent_turn parsing but rejects explicit legacy selector requests", () => {
    expect(SoulMemorySearchRequestSchema.parse({ ...request, recent_turn: "old client context" }).recent_turn)
      .toBe("old client context");
    for (const selector of [{ delivery_path: "legacy" }, { delivery_path: "canonical" },
      { ranking_authority: "prefix_sk" }, { ranking_authority: "select_gamma" }]) {
      expect(SoulMemorySearchRequestSchema.safeParse({ ...request, ...selector }).success).toBe(false);
    }
  });

  it("keeps results and strategy_mix required for sibling consumers", () => {
    const { results: _results, ...missingResults } = response;
    const { strategy_mix: _mix, ...missingMix } = response;
    expect(SoulMemorySearchResponseSchema.safeParse(missingResults).success).toBe(false);
    expect(SoulMemorySearchResponseSchema.safeParse(missingMix).success).toBe(false);
  });
});
