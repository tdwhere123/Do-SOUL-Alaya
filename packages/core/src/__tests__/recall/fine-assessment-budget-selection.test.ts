import { describe, expect, it, vi } from "vitest";

import { selectFineAssessmentCandidates } from "../../recall/delivery/fine-assessment-selection.js";
import {
  createCandidate,
  createConfig,
  createRankedCandidate,
  createRanks,
  createSupplementaryData,
  rankMap,
  stageRanks
} from "./fine-assessment-selection-fixtures.js";

describe("selectFineAssessmentCandidates", () => {
  it("uses a single token estimate per candidate that reaches token-budget evaluation", () => {
    const estimate = vi.fn(() => 6);

    const result = selectFineAssessmentCandidates({
      orderedCandidates: [
        createCandidate("memory-1"),
        createCandidate("memory-2")
      ],
      config: {
        conflict_awareness: false,
        budgets: {
          max_entries: 10,
          max_total_tokens: 10,
          per_dimension_limits: null
        }
      },
      supplementaryData: createSupplementaryData(),
      tokenEstimator: { estimate },
      rankByCandidateKey: createRanks()
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.diagnostics[1]?.dropped_reason).toBe("max_total_tokens");
    expect(estimate).toHaveBeenCalledTimes(2);
  });

  it("keeps real coverage ranks when an oversized candidate cannot advance coverage", () => {
    const first = createRankedCandidate("first", 1, 1);
    const oversized = createRankedCandidate("oversized", 2, 0.9);
    const unrelated = createRankedCandidate("unrelated", 3, 0.6);
    const sharedAfterSkip = createRankedCandidate("shared-after-skip", 4, 0.85);
    const candidates = [first, oversized, unrelated, sharedAfterSkip];
    const result = selectFineAssessmentCandidates({
      orderedCandidates: candidates,
      config: {
        ...createConfig(),
        budgets: { ...createConfig().budgets, max_total_tokens: 12 }
      },
      supplementaryData: createSupplementaryData({
        evidenceGistsByMemoryId: {
          first: "first gist",
          oversized: "shared gist",
          unrelated: "unrelated gist",
          "shared-after-skip": "shared gist"
        },
        sourceCohortKeys: {
          first: "session-a",
          oversized: "session-b",
          unrelated: "session-c",
          "shared-after-skip": "session-b"
        }
      }),
      tokenEstimator: {
        estimate: vi.fn((content: string) => content.includes("oversized") ? 100 : 6)
      },
      rankByCandidateKey: rankMap(candidates),
      coverageRelevanceByCandidateKey: new Map(candidates.map((candidate) => [
        candidate.fusion.candidate_key,
        candidate.fusion.fused_score
      ]))
    });

    const oversizedDiagnostic = result.diagnostics.find(
      (candidate) => candidate.object_id === "oversized"
    );
    expect(oversizedDiagnostic).toMatchObject({
      final_rank: null,
      dropped_reason: "max_total_tokens",
      rank_after_feature_rerank: 2,
      rank_after_coverage_selector: 2,
      rank_after_session_coverage: 2,
      coverage_selector_action: "kept",
      session_coverage_action: "noop"
    });
    expect(stageRanks(result, "shared-after-skip")).toEqual([4, 3, "promoted", "noop"]);
    expect(stageRanks(result, "unrelated")).toEqual([3, 4, "displaced", "noop"]);
  });
});
