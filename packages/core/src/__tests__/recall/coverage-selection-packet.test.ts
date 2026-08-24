import { FIELD_PINS } from "./fine-assessment-selection-fixtures.js";
import { describe, expect, it, vi } from "vitest";
import {
  orderByCoverageMarginalGain
} from "../../recall/delivery/coverage-selection.js";
import {
  selectFineAssessmentCandidates
} from "../../recall/delivery/fine-assessment-selection.js";
import {
  createCandidate,
  createRanks,
  createSupplementaryData
} from "./coverage-selection-test-support.js";

describe("coverage-aware delivery packet", () => {
  it("does not treat distinct facts from one source session as duplicates", () => {
    const anchor = createCandidate("cohort-anchor", 0.9);
    const sameCohort = createCandidate("same-cohort", 0.8);
    const otherCohort = createCandidate("other-cohort", 0.5);
    const ordered = orderByCoverageMarginalGain({
      candidates: [anchor, sameCohort, otherCohort],
      relevanceByCandidateKey: new Map([
        [anchor.fusion.candidate_key, 0.9],
        [sameCohort.fusion.candidate_key, 0.8],
        [otherCohort.fusion.candidate_key, 0.5]
      ]),
      supplementaryData: createSupplementaryData({
        evidenceGistsByMemoryId: {
          "cohort-anchor": "gist-a",
          "same-cohort": "gist-b",
          "other-cohort": "gist-c"
        },
        sourceCohortKeys: {
          "cohort-anchor": "cohort-1",
          "same-cohort": "cohort-1",
          "other-cohort": "cohort-2"
        }
      })
    });
    expect(ordered.map((candidate) => candidate.entry.object_id)).toEqual([
      "cohort-anchor",
      "same-cohort",
      "other-cohort"
    ]);
  });

  it("keeps the final packet in the coverage-selected order", () => {
    const highFusedDupA = createCandidate("dup-a", 0.99);
    const highFusedDupB = createCandidate("dup-b", 0.98);
    const lowFusedNovel = createCandidate("novel", 0.4);
    const result = selectFineAssessmentCandidates({
    ...FIELD_PINS,
      orderedCandidates: [highFusedDupA, highFusedDupB, lowFusedNovel],
      config: {
        conflict_awareness: false,
        budgets: {
          max_entries: 2,
          max_total_tokens: 100,
          per_dimension_limits: null
        }
      },
      supplementaryData: createSupplementaryData({
        evidenceGistsByMemoryId: {
          "dup-a": "same-gist",
          "dup-b": "same-gist",
          novel: "fresh-gist"
        }
      }),
      tokenEstimator: { estimate: () => 6 },
      rankByCandidateKey: createRanks([highFusedDupA, highFusedDupB, lowFusedNovel]),
      finalRelevanceByCandidateKey: new Map([
        [highFusedDupA.fusion.candidate_key, 0.99],
        [highFusedDupB.fusion.candidate_key, 0.98],
        [lowFusedNovel.fusion.candidate_key, 0.4]
      ]),
      coverageRelevanceByCandidateKey: new Map([
        [highFusedDupA.fusion.candidate_key, 0.2],
        [highFusedDupB.fusion.candidate_key, 0.15],
        [lowFusedNovel.fusion.candidate_key, 0.95]
      ])
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "novel",
      "dup-a"
    ]);
    expect(result.candidates.map((candidate) => candidate.relevance_score)).toEqual([
      0.4,
      0.99
    ]);
    // Coverage chooses both the admitted set and the final selector order.
    expect(result.candidates[0]).toMatchObject({
      score_factors: { relevance: 0.4 },
      budget_state: { remaining_entries: 1, remaining_tokens: 94 }
    });
    const diagnostics = new Map(result.diagnostics.map((row) => [row.object_id, row]));
    expect(diagnostics.get("novel")).toMatchObject({
      rank_after_coverage_selector: 1,
      final_rank: 1,
      post_rank: 1
    });
    expect(diagnostics.get("dup-a")).toMatchObject({
      rank_after_coverage_selector: 2,
      final_rank: 2,
      post_rank: 2
    });
  });

  it("does not perform a second public-order displacement", () => {
    const publicA = createCandidate("public-a", 0.99);
    const publicB = createCandidate("public-b", 0.98);
    const headA = createCandidate("head-a", 0.4);
    const candidates = [publicA, publicB, headA];
    const result = selectFineAssessmentCandidates({
    ...FIELD_PINS,
      orderedCandidates: candidates,
      config: {
        conflict_awareness: false,
        budgets: { max_entries: 3, max_total_tokens: 100, per_dimension_limits: null }
      },
      supplementaryData: createSupplementaryData(),
      tokenEstimator: { estimate: () => 6 },
      rankByCandidateKey: new Map([
        [headA.fusion.candidate_key, 1],
        [publicA.fusion.candidate_key, 2],
        [publicB.fusion.candidate_key, 3]
      ])
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "public-a",
      "public-b",
      "head-a"
    ]);
    expect(new Set(result.candidates.map((candidate) => candidate.object_id)))
      .toEqual(new Set(candidates.map((candidate) => candidate.entry.object_id)));
    const diagnostics = new Map(result.diagnostics.map((row) => [row.object_id, row]));
    expect(diagnostics.get("head-a")).toMatchObject({ final_rank: 3, post_rank: 3 });
    expect(result.candidates[1]?.budget_state).toMatchObject({
      remaining_entries: 1,
      remaining_tokens: 88
    });
  });

  it("still deduplicates object_id across provenance projections", () => {
    const local = createCandidate("shared", 0.9);
    const globalBase = createCandidate("shared", 0.8);
    const global = {
      ...globalBase,
      originPlane: "global" as const,
      fusion: {
        ...globalBase.fusion,
        candidate_key: "global:memory_entry:shared",
        fused_rank: 2,
        fused_score: 0.8
      }
    };
    const next = createCandidate("next", 0.7);
    const estimate = vi.fn(() => 6);

    const result = selectFineAssessmentCandidates({
    ...FIELD_PINS,
      orderedCandidates: [local, global, next],
      config: {
        conflict_awareness: false,
        budgets: {
          max_entries: 2,
          max_total_tokens: 100,
          per_dimension_limits: null
        }
      },
      supplementaryData: createSupplementaryData({
        evidenceGistsByMemoryId: {
          shared: "gist-a",
          next: "gist-b"
        }
      }),
      tokenEstimator: { estimate },
      rankByCandidateKey: new Map([
        [local.fusion.candidate_key, 1],
        [global.fusion.candidate_key, 2],
        [next.fusion.candidate_key, 3]
      ]),
      finalRelevanceByCandidateKey: new Map([
        [local.fusion.candidate_key, 0.9],
        [global.fusion.candidate_key, 0.8],
        [next.fusion.candidate_key, 0.7]
      ])
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual(["shared", "next"]);
    expect(result.diagnostics.map((row) => ({
      candidateKey: row.candidate_key,
      droppedReason: row.dropped_reason
    }))).toEqual([
      { candidateKey: local.fusion.candidate_key, droppedReason: null },
      { candidateKey: global.fusion.candidate_key, droppedReason: "duplicate" },
      { candidateKey: next.fusion.candidate_key, droppedReason: null }
    ]);
  });
});
