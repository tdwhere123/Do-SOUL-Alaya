import { describe, expect, it } from "vitest";
import {
  MemoryDimension,
  ScopeClass,
  type MemoryEntry,
  type RecallScoreFactors
} from "@do-soul/alaya-protocol";
import {
  selectFineAssessmentCandidates,
  type FineAssessmentCandidate
} from "../../recall/delivery/fine-assessment-selection.js";
import { buildEmptyRecallFusionBreakdown } from "../../recall/delivery/fusion-delivery-scoring.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import type { RecallSupplementaryData } from "../../recall/runtime/recall-service-types.js";

describe("embedding-head dominance at the admission boundary", () => {
  it("preserves a CE winner's order while replacing an admitted conflict", () => {
    const conflict = withFusionRanks(createCandidate("conflict", 0.99), 3);
    const ceWinner = withFusionRanks(createCandidate("ce-winner", 0.9), 4);
    const embeddingHead = withFusionRanks(createCandidate("embedding-head", 0.8), 2);

    const result = runSelection([conflict, ceWinner, embeddingHead], {
      answerRerankedCandidateKeys: [ceWinner.fusion.candidate_key],
      embeddingSimilarityScores: {
        conflict: 0.2,
        "ce-winner": 0.1,
        "embedding-head": 0.9
      }
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "ce-winner",
      "embedding-head"
    ]);
    const evicted = result.diagnostics.find((candidate) => candidate.object_id === "conflict");
    expect(evicted?.dropped_reason).toBe("embedding_head_dominance");
    expect(evicted?.eviction_reason).toBe("embedding_head_dominance");
  });

  it("evicts the weakest feasible conflict instead of the first one", () => {
    const strong = withFusionRanks(createCandidate("strong", 0.99), 3);
    const weak = withFusionRanks(createCandidate("weak", 0.98), 4);
    const embeddingHead = withFusionRanks(createCandidate("embedding-head", 0.97), 2);

    const result = runSelection([strong, weak, embeddingHead], {
      embeddingSimilarityScores: {
        strong: 0.8,
        weak: 0.2,
        "embedding-head": 0.9
      }
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "strong",
      "embedding-head"
    ]);
  });

  it.each([
    ["worse rank when scores are absent", 3, 4, {}, "left"],
    ["worse rank when positive scores tie", 4, 3, {
      left: 0.2,
      right: 0.2,
      "embedding-head": 0.9
    }, "right"]
  ] as const)("evicts by %s", (_case, leftRank, rightRank, scores, retained) => {
    const left = withFusionRanks(createCandidate("left", 0.99), leftRank);
    const right = withFusionRanks(createCandidate("right", 0.98), rightRank);
    const embeddingHead = withFusionRanks(createCandidate("embedding-head", 0.97), 2);

    const result = runSelection([left, right, embeddingHead], {
      embeddingSimilarityScores: scores
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      retained,
      "embedding-head"
    ]);
  });

  it("does not treat a token-rejected prefix candidate as a delivered slot", () => {
    const rejectedConflict = withFusionRanks(
      createCandidate("token-rejected-conflict", 0.99),
      3
    );
    const ceWinner = withFusionRanks(createCandidate("ce-winner", 0.9), 4);
    const embeddingHead = withFusionRanks(createCandidate("embedding-head", 0.8), 2);

    const result = runSelection([rejectedConflict, ceWinner, embeddingHead], {
      answerRerankedCandidateKeys: [ceWinner.fusion.candidate_key],
      embeddingSimilarityScores: {
        "token-rejected-conflict": 0.2,
        "ce-winner": 0.1,
        "embedding-head": 0.9
      },
      tokenEstimate: (content) => content.includes("token-rejected-conflict") ? 11 : 5,
      maxTotalTokens: 10
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "ce-winner",
      "embedding-head"
    ]);
    expect(result.diagnostics.find(
      (candidate) => candidate.object_id === "token-rejected-conflict"
    )?.dropped_reason).toBe("max_total_tokens");
  });

  it("does not admit a token-heavy head by dropping a later CE peer", () => {
    const conflict = withFusionRanks(createCandidate("conflict", 0.99), 4);
    const embeddingHead = withFusionRanks(createCandidate("embedding-head", 0.9), 1);
    const ceWinner = withFusionRanks(createCandidate("ce-winner", 0.8), 5);

    const result = runSelection([conflict, embeddingHead, ceWinner], {
      answerRerankedCandidateKeys: [ceWinner.fusion.candidate_key],
      embeddingSimilarityScores: {
        conflict: 0.2,
        "embedding-head": 0.9,
        "ce-winner": 0.1
      },
      maxEntries: 3,
      maxTotalTokens: 10,
      tokenEstimate: (content) => {
        if (content.includes("conflict")) return 6;
        if (content.includes("embedding-head")) return 8;
        return 4;
      }
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "conflict",
      "ce-winner"
    ]);
  });

  it("does not let a dimension-rejected prefix displace a query winner", () => {
    const anchor = withFusionRanks(createCandidate("anchor", 1), 1);
    const rejectedConflict = withFusionRanks(createCandidate("dimension-conflict", 0.99), 3);
    const queryWinner = withFusionRanks(
      withDimension(createCandidate("query-winner", 0.9), MemoryDimension.FACT),
      4,
      { lexical_fts: 1 }
    );
    const embeddingHead = withFusionRanks(
      withDimension(createCandidate("embedding-head", 0.8), MemoryDimension.PREFERENCE),
      2
    );

    const result = runSelection([anchor, rejectedConflict, queryWinner, embeddingHead], {
      embeddingSimilarityScores: {
        anchor: 0.95,
        "dimension-conflict": 0.2,
        "query-winner": 0.1,
        "embedding-head": 0.9
      },
      perDimensionLimits: { [MemoryDimension.PROCEDURE]: 1 }
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "anchor",
      "query-winner"
    ]);
    expect(result.diagnostics.find(
      (candidate) => candidate.object_id === "dimension-conflict"
    )?.dropped_reason).toBe("dimension_limit");
  });

  it("does not treat a duplicate prefix projection as a delivered slot", () => {
    const anchor = withFusionRanks(createCandidate("shared", 1), 1);
    const duplicate = withCandidateKey(
      withFusionRanks(createCandidate("shared", 0.99), 3),
      "global:memory_entry:shared"
    );
    const queryWinner = withFusionRanks(
      createCandidate("query-winner", 0.4),
      4,
      { lexical_fts: 1 }
    );
    const embeddingHead = withFusionRanks(createCandidate("embedding-head", 0.3), 2);

    const result = runSelection([anchor, duplicate, queryWinner, embeddingHead], {
      embeddingSimilarityScores: {
        shared: 0.2,
        "query-winner": 0.1,
        "embedding-head": 0.9
      }
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "shared",
      "query-winner"
    ]);
    expect(result.diagnostics.find(
      (candidate) => candidate.candidate_key === duplicate.fusion.candidate_key
    )?.dropped_reason).toBe("duplicate");
  });

  it("uses rank to break a boundary cosine tie", () => {
    const anchor = withFusionRanks(createCandidate("anchor", 0.9), 1);
    const conflict = withFusionRanks(createCandidate("tied-conflict", 0.8), 3);
    const embeddingHead = withFusionRanks(createCandidate("tied-head", 0.7), 2);

    const result = runSelection([anchor, conflict, embeddingHead], {
      embeddingSimilarityScores: {
        anchor: 0.9,
        "tied-conflict": 0.8,
        "tied-head": 0.8
      }
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "anchor",
      "tied-head"
    ]);
  });

  it("repairs a conflict flood without reordering surviving heads", () => {
    const structuralOnly = {
      evidence_structural_agreement: 1,
      source_proximity: 1,
      source_evidence_agreement: 1
    };
    const conflictA = withFusionRanks(createCandidate("conflict-a", 0.99), 5, structuralOnly);
    const headA = withFusionRanks(createCandidate("head-a", 0.98), 1);
    const conflictB = withFusionRanks(createCandidate("conflict-b", 0.97), 4, structuralOnly);
    const headB = withFusionRanks(createCandidate("head-b", 0.96), 2);
    const headC = withFusionRanks(createCandidate("head-c", 0.95), 3);

    const result = runSelection([conflictA, headA, conflictB, headB, headC], {
      maxEntries: 3,
      embeddingSimilarityScores: {
        "conflict-a": 0.2,
        "head-a": 0.95,
        "conflict-b": 0.1,
        "head-b": 0.9,
        "head-c": 0.85
      }
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "head-a",
      "head-b",
      "head-c"
    ]);
  });

  it.each(["lexical_fts", "evidence_fts"] as const)(
    "lets a %s-supported challenger keep its delivery win",
    (queryStream) => {
      const anchor = withFusionRanks(createCandidate("anchor", 0.9), 1);
      const queryWinner = withFusionRanks(
        createCandidate("query-winner", 0.85),
        3,
        { [queryStream]: 1 }
      );
      const embeddingHead = withFusionRanks(createCandidate("embedding-head", 0.8), 2);

      const result = runSelection([anchor, queryWinner, embeddingHead], {
        embeddingSimilarityScores: {
          anchor: 0.95,
          "query-winner": 0.2,
          "embedding-head": 0.9
        }
      });

      expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
        "anchor",
        "query-winner"
      ]);
    }
  );

  it("lets a temporal-query challenger keep its delivery win", () => {
    const anchor = withFusionRanks(createCandidate("anchor", 0.9), 1);
    const temporalWinner = withFusionRanks(
      createCandidate("temporal-winner", 0.85),
      3,
      { temporal_recency: 1 }
    );
    const embeddingHead = withFusionRanks(createCandidate("embedding-head", 0.8), 2);

    const result = runSelection([anchor, temporalWinner, embeddingHead], {
      embeddingSimilarityScores: {
        anchor: 0.95,
        "temporal-winner": 0.2,
        "embedding-head": 0.9
      },
      queryText: "What happened in March 2026?"
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "anchor",
      "temporal-winner"
    ]);
  });
});

type SelectionOverrides = Readonly<{
  readonly answerRerankedCandidateKeys?: readonly string[];
  readonly embeddingSimilarityScores?: Readonly<Record<string, number>>;
  readonly maxEntries?: number;
  readonly maxTotalTokens?: number;
  readonly perDimensionLimits?: Readonly<Record<string, number>>;
  readonly queryText?: string | null;
  readonly tokenEstimate?: (content: string) => number;
}>;

function runSelection(
  candidates: readonly FineAssessmentCandidate[],
  overrides: SelectionOverrides = {}
) {
  return selectFineAssessmentCandidates({
    orderedCandidates: candidates,
    config: {
      conflict_awareness: false,
      budgets: {
        max_entries: overrides.maxEntries ?? 2,
        max_total_tokens: overrides.maxTotalTokens ?? 100,
        per_dimension_limits: overrides.perDimensionLimits ?? null
      }
    },
    supplementaryData: createSupplementaryData({
      queryProbes: compileRecallQueryProbes(overrides.queryText ?? null),
      embeddingSimilarityScores: overrides.embeddingSimilarityScores ?? {},
      evidenceGistsByMemoryId: Object.fromEntries(
        candidates.map((candidate) => [candidate.entry.object_id, candidate.entry.object_id])
      )
    }),
    tokenEstimator: { estimate: overrides.tokenEstimate ?? (() => 5) },
    rankByCandidateKey: createRanks(candidates),
    finalRelevanceByCandidateKey: relevanceMap(candidates),
    coverageRelevanceByCandidateKey: relevanceMap(candidates),
    answerRelevanceRankByCandidateKey: new Map(
      (overrides.answerRerankedCandidateKeys ?? []).map((key, index) => [key, index + 1])
    )
  });
}

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

function withFusionRanks(
  candidate: FineAssessmentCandidate,
  embeddingRank: number,
  queryRanks: Readonly<Record<string, number>> = {}
): FineAssessmentCandidate {
  return {
    ...candidate,
    fusion: {
      ...candidate.fusion,
      per_stream_rank: {
        ...candidate.fusion.per_stream_rank,
        embedding_similarity: embeddingRank,
        ...queryRanks
      }
    }
  };
}

function withDimension(
  candidate: FineAssessmentCandidate,
  dimension: MemoryDimension
): FineAssessmentCandidate {
  return { ...candidate, entry: { ...candidate.entry, dimension } };
}

function withCandidateKey(
  candidate: FineAssessmentCandidate,
  candidateKey: string
): FineAssessmentCandidate {
  return {
    ...candidate,
    originPlane: "global",
    fusion: { ...candidate.fusion, candidate_key: candidateKey }
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
