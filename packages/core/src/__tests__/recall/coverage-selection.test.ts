import { describe, expect, it, vi } from "vitest";
import {
  MemoryDimension,
  ScopeClass,
  type MemoryEntry,
  type RecallScoreFactors
} from "@do-soul/alaya-protocol";
import { orderByCoverageMarginalGain } from "../../recall/delivery/coverage-selection.js";
import {
  selectFineAssessmentCandidates,
  type FineAssessmentCandidate
} from "../../recall/delivery/fine-assessment-selection.js";
import { buildEmptyRecallFusionBreakdown } from "../../recall/delivery/fusion-delivery-scoring.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import type { RecallSupplementaryData } from "../../recall/runtime/recall-service-types.js";

describe("coverage-aware delivery", () => {
  it("orders a new-gist item ahead of a higher-rank duplicate-gist item", () => {
    const sharedGistFirst = createCandidate("dup-1", 0.99);
    const sharedGistSecond = createCandidate("dup-2", 0.98);
    const novel = createCandidate("novel", 0.5);
    const ordered = orderByCoverageMarginalGain({
      candidates: [sharedGistFirst, sharedGistSecond, novel],
      relevanceByCandidateKey: new Map([
        [sharedGistFirst.fusion.candidate_key, 0.99],
        [sharedGistSecond.fusion.candidate_key, 0.98],
        [novel.fusion.candidate_key, 0.5]
      ]),
      supplementaryData: createSupplementaryData({
        evidenceGistsByMemoryId: {
          "dup-1": "same-gist",
          "dup-2": "same-gist",
          novel: "fresh-gist"
        }
      })
    });

    expect(ordered.map((candidate) => candidate.entry.object_id)).toEqual([
      "dup-1",
      "novel",
      "dup-2"
    ]);
  });

  it("fills toward the token budget instead of stopping early with unused tokens", () => {
    const candidates = Array.from({ length: 6 }, (_, index) =>
      createCandidate(`mem-${index + 1}`, 1 - index * 0.05)
    );
    const result = selectFineAssessmentCandidates({
      orderedCandidates: candidates,
      config: {
        conflict_awareness: false,
        budgets: {
          max_entries: 10,
          max_total_tokens: 30,
          per_dimension_limits: null
        }
      },
      supplementaryData: createSupplementaryData({
        evidenceGistsByMemoryId: Object.fromEntries(
          candidates.map((candidate, index) => [candidate.entry.object_id, `gist-${index}`])
        )
      }),
      tokenEstimator: { estimate: () => 6 },
      rankByCandidateKey: createRanks(candidates),
      finalRelevanceByCandidateKey: relevanceMap(candidates)
    });

    expect(result.candidates).toHaveLength(5);
    expect(result.candidates.reduce((sum, candidate) => sum + candidate.token_estimate, 0)).toBe(30);
    expect(result.diagnostics.filter((row) => row.dropped_reason === "max_total_tokens")).toHaveLength(1);
  });

  it("does not let a token-rejected candidate consume coverage", () => {
    const rejected = createCandidate("rejected-shared", 0.99);
    const deliverableShared = createCandidate("deliverable-shared", 0.8);
    const novel = createCandidate("novel", 0.6);
    const candidates = [rejected, deliverableShared, novel];
    const result = selectFineAssessmentCandidates({
      orderedCandidates: candidates,
      config: {
        conflict_awareness: false,
        budgets: {
          max_entries: 1,
          max_total_tokens: 5,
          per_dimension_limits: null
        }
      },
      supplementaryData: createSupplementaryData({
        evidenceGistsByMemoryId: {
          "rejected-shared": "shared-gist",
          "deliverable-shared": "shared-gist",
          novel: "novel-gist"
        }
      }),
      tokenEstimator: {
        estimate: (content) => content.includes("rejected-shared") ? 6 : 5
      },
      rankByCandidateKey: createRanks(candidates),
      finalRelevanceByCandidateKey: relevanceMap(candidates)
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "deliverable-shared"
    ]);
    expect(result.diagnostics.find(
      (candidate) => candidate.object_id === "rejected-shared"
    )?.dropped_reason).toBe("max_total_tokens");
  });

  it("does not let duplicate or dimension rejections consume coverage", () => {
    const anchor = createCandidate("shared", 1);
    const duplicateBase = createCandidate("shared", 0.95);
    const duplicate = {
      ...duplicateBase,
      originPlane: "global" as const,
      fusion: {
        ...duplicateBase.fusion,
        candidate_key: "global:memory_entry:shared"
      }
    };
    const dimensionRejected = createCandidate("dimension-rejected", 0.9);
    const deliverableShared = withDimension(
      createCandidate("deliverable-shared", 0.8),
      MemoryDimension.FACT
    );
    const novel = withDimension(createCandidate("novel", 0.35), MemoryDimension.PREFERENCE);
    const candidates = [anchor, duplicate, dimensionRejected, deliverableShared, novel];
    const result = selectFineAssessmentCandidates({
      orderedCandidates: candidates,
      config: {
        conflict_awareness: false,
        budgets: {
          max_entries: 2,
          max_total_tokens: 100,
          per_dimension_limits: { [MemoryDimension.PROCEDURE]: 1 }
        }
      },
      supplementaryData: createSupplementaryData({
        evidenceGistsByMemoryId: {
          shared: "shared-gist",
          "dimension-rejected": "shared-gist",
          "deliverable-shared": "shared-gist",
          novel: "novel-gist"
        }
      }),
      tokenEstimator: { estimate: () => 5 },
      rankByCandidateKey: createRanks(candidates),
      finalRelevanceByCandidateKey: relevanceMap(candidates)
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "shared",
      "deliverable-shared"
    ]);
    expect(result.diagnostics.find(
      (candidate) => candidate.candidate_key === duplicate.fusion.candidate_key
    )?.dropped_reason).toBe("duplicate");
    expect(result.diagnostics.find(
      (candidate) => candidate.object_id === "dimension-rejected"
    )?.dropped_reason).toBe("dimension_limit");
  });

  it("replans coverage without a dominance-evicted candidate", () => {
    const conflict = createCandidate("conflict", 0.99);
    const protectedWinner = createCandidate("protected", 0.9);
    const embeddingBase = createCandidate("embedding-head", 0.7);
    const embeddingHead = {
      ...embeddingBase,
      fusion: {
        ...embeddingBase.fusion,
        per_stream_rank: {
          ...embeddingBase.fusion.per_stream_rank,
          embedding_similarity: 1
        }
      }
    };
    const novel = createCandidate("novel", 0.4);
    const candidates = [conflict, protectedWinner, embeddingHead, novel];
    const result = selectFineAssessmentCandidates({
      orderedCandidates: candidates,
      config: {
        conflict_awareness: false,
        budgets: { max_entries: 2, max_total_tokens: 100, per_dimension_limits: null }
      },
      supplementaryData: createSupplementaryData({
        evidenceGistsByMemoryId: {
          conflict: "shared-gist",
          protected: "protected-gist",
          "embedding-head": "shared-gist",
          novel: "novel-gist"
        },
        embeddingSimilarityScores: { conflict: 0.2, "embedding-head": 0.9 }
      }),
      tokenEstimator: { estimate: () => 5 },
      rankByCandidateKey: createRanks(candidates),
      finalRelevanceByCandidateKey: relevanceMap(candidates),
      answerRelevanceRankByCandidateKey: new Map([
        [protectedWinner.fusion.candidate_key, 1]
      ])
    });
    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "protected",
      "embedding-head"
    ]);
    expect(result.diagnostics.find(
      (candidate) => candidate.object_id === "conflict"
    )?.dropped_reason).toBe("embedding_head_dominance");
  });

  it("uses diminishing returns without discarding repeated-gist items", () => {
    const candidates = Array.from({ length: 4 }, (_, index) =>
      createCandidate(`same-gist-${index + 1}`, 1 - index * 0.01)
    );
    const result = selectFineAssessmentCandidates({
      orderedCandidates: candidates,
      config: {
        conflict_awareness: false,
        budgets: {
          max_entries: 10,
          max_total_tokens: 100,
          per_dimension_limits: null
        }
      },
      supplementaryData: createSupplementaryData({
        evidenceGistsByMemoryId: Object.fromEntries(
          candidates.map((candidate) => [candidate.entry.object_id, "shared"])
        )
      }),
      tokenEstimator: { estimate: () => 6 },
      rankByCandidateKey: createRanks(candidates),
      finalRelevanceByCandidateKey: relevanceMap(candidates)
    });

    expect(result.candidates).toHaveLength(candidates.length);
    expect(result.diagnostics.filter((row) => row.dropped_reason === "duplicate")).toHaveLength(0);
  });

  it("does not let fused_score fallback outrank a tiny CE deep-head map", () => {
    const ceWinner = createCandidate("ce-winner", 0.04);
    const fusedTail = createCandidate("fused-tail", 0.08);
    const ordered = orderByCoverageMarginalGain({
      candidates: [fusedTail, ceWinner],
      relevanceByCandidateKey: new Map([
        [ceWinner.fusion.candidate_key, 0.002]
      ]),
      supplementaryData: createSupplementaryData({
        evidenceGistsByMemoryId: {
          "ce-winner": "gist-a",
          "fused-tail": "gist-b"
        }
      })
    });
    expect(ordered.map((candidate) => candidate.entry.object_id)).toEqual([
      "ce-winner",
      "fused-tail"
    ]);
  });

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

  it("packs by coverageRelevance even when public finalRelevance stays fused", () => {
    const highFusedDupA = createCandidate("dup-a", 0.99);
    const highFusedDupB = createCandidate("dup-b", 0.98);
    const lowFusedNovel = createCandidate("novel", 0.4);
    const result = selectFineAssessmentCandidates({
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
      ]),
      finalOrderAfterCoverage: "public_relevance"
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "dup-a",
      "novel"
    ]);
    expect(result.candidates.map((candidate) => candidate.relevance_score)).toEqual([
      0.99,
      0.4
    ]);
    // Coverage chooses the admitted set; public delivery remains relevance-ordered.
    expect(result.candidates[0]).toMatchObject({
      score_factors: { relevance: 0.99 },
      budget_state: { remaining_entries: 1, remaining_tokens: 94 }
    });
    const diagnostics = new Map(result.diagnostics.map((row) => [row.object_id, row]));
    expect(diagnostics.get("novel")).toMatchObject({
      rank_after_coverage_selector: 1,
      final_rank: 2,
      post_rank: 2
    });
    expect(diagnostics.get("dup-a")).toMatchObject({
      rank_after_coverage_selector: 2,
      final_rank: 1,
      post_rank: 1
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
      { candidateKey: next.fusion.candidate_key, droppedReason: null },
      { candidateKey: global.fusion.candidate_key, droppedReason: "duplicate" }
    ]);
  });
});

function createCandidate(objectId: string, fusedScore: number): FineAssessmentCandidate {
  const breakdown = buildEmptyRecallFusionBreakdown(objectId);
  return {
    entry: createMemoryEntry(objectId),
    effectiveScore: fusedScore,
    effectiveFactors: createScoreFactors(),
    fusion: {
      ...breakdown,
      fused_rank: Math.round((1 - fusedScore) * 100) + 1,
      fused_score: fusedScore
    }
  };
}

function createMemoryEntry(objectId: string): MemoryEntry {
  return {
    object_id: objectId,
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-05-13T00:00:00.000Z",
    updated_at: "2026-05-13T00:00:00.000Z",
    created_by: "system",
    dimension: MemoryDimension.PROCEDURE,
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: ScopeClass.PROJECT,
    content: `Recall content for ${objectId}.`,
    domain_tags: ["repo"],
    evidence_refs: [],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: "hot",
    activation_score: 0.7,
    retention_score: null,
    manifestation_state: null,
    retention_state: null,
    decay_profile: null,
    confidence: null,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: null,
    contradiction_count: null,
    superseded_by: null
  };
}

function withDimension(
  candidate: FineAssessmentCandidate,
  dimension: MemoryDimension
): FineAssessmentCandidate {
  return { ...candidate, entry: { ...candidate.entry, dimension } };
}

function createScoreFactors(): RecallScoreFactors {
  return {
    activation: 0.7,
    relevance: 0.6,
    graph_support: 0,
    path_plasticity: 0,
    budget_penalty: 0,
    conflict_penalty: 0
  };
}

function createRanks(candidates: readonly FineAssessmentCandidate[]): ReadonlyMap<string, number> {
  return new Map(candidates.map((candidate, index) => [candidate.fusion.candidate_key, index + 1]));
}

function relevanceMap(candidates: readonly FineAssessmentCandidate[]): ReadonlyMap<string, number> {
  return new Map(candidates.map((candidate) => [
    candidate.fusion.candidate_key,
    candidate.fusion.fused_score
  ]));
}

function createSupplementaryData(
  overrides: Partial<RecallSupplementaryData> = {}
): RecallSupplementaryData {
  return {
    queryProbes: compileRecallQueryProbes(null),
    ftsRanks: {},
    trigramFtsRanks: {},
    synthesisFtsRanks: {},
    evidenceFtsRanks: {},
    sourceProximityScores: {},
    sourceCohortKeys: {},
    structuralScores: {},
    graphExpansionScores: {},
    entitySeedScores: {},
    pathExpansionScores: {},
    pathSuppressionScores: {},
    embeddingSimilarityScores: {},
    graphSupportCounts: {},
    budgetPenaltyFactor: 0,
    plasticityFactors: {},
    graphAndPathColdScore: 0,
    recallsEdgeCount: 0,
    weightTransferAmount: 0,
    evidenceGistsByMemoryId: {},
    governanceCeilingByMemoryId: {},
    ...overrides
  };
}
