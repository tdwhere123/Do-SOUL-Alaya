import { describe, expect, it } from "vitest";
import { orderByCoverageMarginalGain } from "../../recall/delivery/coverage-selection.js";
import { applyDeliverySelection } from
  "../../recall/delivery/delivery-selection.js";
import {
  computeLightweightDeepHeadScores,
  resolveDeepHeadAssessment,
  resolveDeepHeadScores
} from "../../recall/rerank/deep-head.js";
import { emptySupplementary, fusedCandidate } from
  "./rerank/deep-head-fixtures.js";

describe("deep head", () => {
  it("traces the exact live family-grouped score composition", () => {
    const candidate = fusedCandidate({
      objectId: "traced",
      fusedScore: 0.2,
      embedding: 0.4
    });
    const assessment = resolveDeepHeadAssessment({
      candidates: [candidate],
      answerRelevanceScores: new Map(),
      supplementaryData: emptySupplementary({
        ftsRanks: { traced: 0.81 },
        trigramFtsRanks: { traced: 1 },
        evidenceFtsRanks: { traced: 0.25 },
        structuralScores: { traced: 1 }
      }),
      includeTraces: true
    });
    const trace = assessment.traceByCandidateKey.get(candidate.fusion.candidate_key)!;

    expect(trace.lexical_agreement).toBeCloseTo(0.9);
    expect(trace.evidence_agreement).toBeCloseTo(0.5);
    expect(trace.resolved_evidence).toBeCloseTo(0.9);
    expect(trace.embedding_signal).toBeCloseTo(0.4);
    expect(trace.activation).toMatchObject({
      schema_version: 1,
      operator_id: "candidate_semantic_max_v1",
      state: "observed",
      score: 0.4,
      winner: { channel: "effective_factor", score: 0.4 },
      missing_channel_policy: "no_op"
    });
    expect(trace.formula_operator_id).toBe("family_grouped_composition_v1");
    expect(trace.fusion_baseline_used).toBe(false);
    expect(trace.score_source).toBe("embedding_evidence");
    expect(trace.family_scores?.lexical_evidence).toBeCloseTo(0.9);
    expect(trace.family_scores?.semantic).toBeCloseTo(0.4);
    expect(trace.family_scores?.fusion).toBeNull();
    expect(trace.resolved_score).toBeCloseTo(1);
    expect(assessment.scores.get(candidate.fusion.candidate_key))
      .toBe(trace.resolved_score);
  });

  it("does not add correlated lexical evidence forms as independent probability", () => {
    const candidate = fusedCandidate({
      objectId: "correlated-lexical",
      fusedScore: 0.2,
      embedding: 0.4
    });
    const assessment = resolveDeepHeadAssessment({
      candidates: [candidate],
      answerRelevanceScores: new Map(),
      supplementaryData: emptySupplementary({
        ftsRanks: { "correlated-lexical": 0.81 },
        trigramFtsRanks: { "correlated-lexical": 1 },
        evidenceFtsRanks: { "correlated-lexical": 0.81 },
        structuralScores: { "correlated-lexical": 1 }
      }),
      includeTraces: true
    });
    const trace = assessment.traceByCandidateKey.get(candidate.fusion.candidate_key)!;

    expect(trace.lexical_agreement).toBeCloseTo(0.9);
    expect(trace.evidence_agreement).toBeCloseTo(0.9);
    expect(trace.resolved_evidence).toBeCloseTo(0.9);
    expect(trace.resolved_score).toBeCloseTo(1);
  });

  it("keeps the fused opportunity channel beside observed embedding support", () => {
    const candidate = fusedCandidate({
      objectId: "resident-opportunity",
      fusedScore: 0.2,
      embedding: 0.4,
      contributions: { lexical_fts: 0.02 }
    });
    const assessment = resolveDeepHeadAssessment({
      candidates: [candidate],
      answerRelevanceScores: new Map(),
      supplementaryData: emptySupplementary(),
      includeTraces: true
    });
    const trace = assessment.traceByCandidateKey.get(candidate.fusion.candidate_key)!;

    expect(trace.fusion_baseline_used).toBe(true);
    expect(trace.score_source).toBe("fusion_embedding_evidence");
    expect(trace.family_scores?.fusion).toBeCloseTo(0.2);
    expect(trace.resolved_score).toBeCloseTo(0.6);
    expect(assessment.scores.get(candidate.fusion.candidate_key))
      .toBe(trace.resolved_score);
  });

  it("keeps the canonical raw fusion baseline when embedding is stronger", () => {
    const leader = fusedCandidate({
      objectId: "fusion-leader",
      fusedScore: 0.114,
      fusedRank: 1,
      embedding: 0.42,
      contributions: { lexical_fts: 0.016, embedding_similarity: 0.015 }
    });
    const assessment = resolveDeepHeadAssessment(
      {
        candidates: [leader],
        answerRelevanceScores: new Map(),
        supplementaryData: emptySupplementary({
          embeddingSimilarityScores: { "fusion-leader": 0.42 }
        }),
        includeTraces: true
      }
    );
    const trace = assessment.traceByCandidateKey.get(leader.fusion.candidate_key)!;

    expect(trace.resolved_score).toBeCloseTo(0.534);
    expect(assessment.scores.get(leader.fusion.candidate_key))
      .toBe(trace.resolved_score);
  });

  it("activates a source-bound field baseline without inventing embedding evidence", () => {
    const candidate = fusedCandidate({
      objectId: "inactive",
      fusedScore: 0.2,
      contributions: { path_expansion: 0.01 }
    });
    const assessment = resolveDeepHeadAssessment({
      candidates: [candidate],
      answerRelevanceScores: new Map(),
      supplementaryData: emptySupplementary(),
      includeTraces: true
    });
    const trace = assessment.traceByCandidateKey.get(candidate.fusion.candidate_key)!;

    expect(assessment.scores.size).toBe(1);
    expect(trace.score_source).toBe("field_baseline");
    expect(trace.fusion_baseline_used).toBe(true);
    expect(trace.embedding_signal).toBeNull();
    expect(trace.resolved_score).toBeCloseTo(0.2);
  });

  it("scores every candidate in the already-pruned waist", () => {
    const candidates = Array.from({ length: 37 }, (_, index) =>
      fusedCandidate({
        objectId: `c-${index + 1}`,
        fusedScore: 1 - index * 0.01,
        fusedRank: index + 1,
        embedding: index === 0 ? 0.2 : 0.9 - index * 0.01
      })
    );

    const scores = computeLightweightDeepHeadScores(candidates, emptySupplementary());

    expect(scores.size).toBe(candidates.length);
    expect(scores.has(candidates.at(-1)!.fusion.candidate_key)).toBe(true);
  });

  it("does not let a dormant cross-encoder map replace lightweight scores", () => {
    const candidates = [
      fusedCandidate({ objectId: "a", fusedScore: 0.9, fusedRank: 1, embedding: 0.1 }),
      fusedCandidate({ objectId: "b", fusedScore: 0.8, fusedRank: 2, embedding: 0.9 })
    ];
    const ceScores = new Map([
      [candidates[0]!.fusion.candidate_key, 0.95],
      [candidates[1]!.fusion.candidate_key, 0.1]
    ]);

    const withCe = resolveDeepHeadScores({
      candidates,
      answerRelevanceScores: ceScores,
      supplementaryData: emptySupplementary({
        embeddingSimilarityScores: { a: 0.1, b: 0.9 }
      })
    });
    const withoutCe = resolveDeepHeadScores({
      candidates,
      answerRelevanceScores: new Map(),
      supplementaryData: emptySupplementary({
        embeddingSimilarityScores: { a: 0.1, b: 0.9 }
      })
    });

    expect(withCe).toEqual(withoutCe);
    expect(withoutCe.get(candidates[1]!.fusion.candidate_key)!)
      .toBeGreaterThan(withoutCe.get(candidates[0]!.fusion.candidate_key)!);
  });

  it("keeps lightweight traces when a dormant cross-encoder map is present", () => {
    const candidates = [
      fusedCandidate({ objectId: "scored", fusedScore: 0.9 }),
      fusedCandidate({ objectId: "unscored", fusedScore: 0.8 })
    ];
    const scoredKey = candidates[0]!.fusion.candidate_key;
    const assessment = resolveDeepHeadAssessment({
      candidates,
      answerRelevanceScores: new Map([[scoredKey, 0.75]]),
      supplementaryData: emptySupplementary(),
      includeTraces: true
    });

    expect(assessment.traceByCandidateKey.get(scoredKey)?.formula_operator_id)
      .toBe("family_grouped_composition_v1");
    expect(assessment.traceByCandidateKey.get(scoredKey)?.score_source)
      .not.toBe("cross_encoder");
  });

  it("lets independent semantic support promote a candidate from a distant fused rank", () => {
    const candidates = Array.from({ length: 40 }, (_, index) =>
      fusedCandidate({
        objectId: `candidate-${index + 1}`,
        fusedScore: 1 - index * 0.001,
        fusedRank: index + 1,
        embedding: index === 39 ? 1 : 0.1
      })
    );
    const scores = computeLightweightDeepHeadScores(candidates, emptySupplementary());
    const result = applyDeliverySelection(candidates, scores, {
      replacePublicRelevance: false
    });
    const orderedIds = result.orderedCandidates.map((candidate) => candidate.entry.object_id);

    expect(orderedIds[0]).toBe("candidate-40");
    expect(result.finalRelevanceByCandidateKey.get(candidates[39]!.fusion.candidate_key))
      .toBe(candidates[39]!.fusion.fused_score);
    expect(result.answerRelevanceRankByCandidateKey.size).toBe(0);
  });

  it("combines semantic support and evidence agreement monotonically", () => {
    const semanticOnly = fusedCandidate({
      objectId: "semantic-only",
      fusedScore: 0.3,
      embedding: 0.6
    });
    const corroborated = fusedCandidate({
      objectId: "corroborated",
      fusedScore: 0.2,
      embedding: 0.6
    });
    const scores = computeLightweightDeepHeadScores(
      [semanticOnly, corroborated],
      emptySupplementary({
        evidenceFtsRanks: { corroborated: 1 },
        structuralScores: { corroborated: 0.36 }
      })
    );

    expect(scores.get(semanticOnly.fusion.candidate_key)).toBeCloseTo(0.6);
    expect(scores.get(corroborated.fusion.candidate_key)).toBeCloseTo(1);
  });

  it("treats concurrence between two lexical lanes as answer evidence", () => {
    const embeddingOnly = fusedCandidate({
      objectId: "embedding-only",
      fusedScore: 0.3,
      embedding: 0.2
    });
    const textCorroborated = fusedCandidate({
      objectId: "text-corroborated",
      fusedScore: 0.2,
      embedding: 0.2
    });

    const scores = computeLightweightDeepHeadScores(
      [embeddingOnly, textCorroborated],
      emptySupplementary({
        ftsRanks: { "text-corroborated": 0.9 },
        trigramFtsRanks: { "text-corroborated": 0.81 }
      })
    );

    expect(scores.get(embeddingOnly.fusion.candidate_key)).toBeCloseTo(0.2);
    expect(scores.get(textCorroborated.fusion.candidate_key)!).toBeGreaterThan(0.8);
  });

  it("adds direct answer evidence to a query-supported embedding-cold baseline", () => {
    const direct = fusedCandidate({
      objectId: "direct",
      fusedScore: 0.4,
      contributions: { lexical_fts: 0.02 }
    });
    const contextual = fusedCandidate({
      objectId: "contextual",
      fusedScore: 0.6,
      contributions: { subject_alignment: 0.02 }
    });

    const scores = computeLightweightDeepHeadScores(
      [direct, contextual],
      emptySupplementary({
        ftsRanks: { direct: 0.9 },
        trigramFtsRanks: { direct: 0.81 }
      })
    );

    expect(scores.get(direct.fusion.candidate_key)).toBeCloseTo(
      Math.sqrt(0.9 * 0.81)
    );
    expect(scores.get(contextual.fusion.candidate_key)).toBeCloseTo(0.6);
  });

  it("preserves query-supported relevance without a usable embedding in a mixed pool", () => {
    const exactLexical = fusedCandidate({
      objectId: "exact-lexical",
      fusedScore: 0.08,
      fusedRank: 1,
      contributions: { lexical_fts: 0.016 }
    });
    const invalidVectorLexical = fusedCandidate({
      objectId: "invalid-vector-lexical",
      fusedScore: 0.07,
      fusedRank: 2,
      embedding: Number.NaN,
      contributions: { lexical_fts: 0.015 }
    });
    const weakSemantic = fusedCandidate({
      objectId: "weak-semantic",
      fusedScore: 0.03,
      fusedRank: 3,
      embedding: 0.04,
      contributions: { embedding_similarity: 0.016 }
    });
    const zeroSimilarityLexical = fusedCandidate({
      objectId: "zero-similarity-lexical",
      fusedScore: 0.09,
      fusedRank: 4,
      embedding: 0,
      contributions: { lexical_fts: 0.014 }
    });
    const candidates = [
      exactLexical,
      invalidVectorLexical,
      weakSemantic,
      zeroSimilarityLexical
    ];

    const scores = computeLightweightDeepHeadScores(candidates, emptySupplementary());
    const packed = orderByCoverageMarginalGain({
      candidates,
      relevanceByCandidateKey: scores,
      supplementaryData: {
        evidenceGistsByMemoryId: {}
      }
    });

    expect(scores.get(exactLexical.fusion.candidate_key)).toBeCloseTo(0.08);
    expect(scores.get(invalidVectorLexical.fusion.candidate_key)).toBeCloseTo(0.07);
    expect(scores.get(zeroSimilarityLexical.fusion.candidate_key)).toBeCloseTo(0.09);
    expect(packed.map((candidate) => candidate.entry.object_id))
      .toEqual([
        "zero-similarity-lexical",
        "exact-lexical",
        "invalid-vector-lexical",
        "weak-semantic"
      ]);
  });

  it("treats an all-zero finite embedding pool as observed", () => {
    const candidates = [
      fusedCandidate({
        objectId: "zero-a",
        fusedScore: 0.09,
        embedding: 0,
        contributions: { lexical_fts: 0.016 }
      }),
      fusedCandidate({
        objectId: "zero-b",
        fusedScore: 0.08,
        embedding: 0,
        contributions: { lexical_fts: 0.015 }
      })
    ];

    const scores = computeLightweightDeepHeadScores(candidates, emptySupplementary());

    expect(scores.size).toBe(2);
    expect([...scores.values()]).toEqual([0.09, 0.08]);
  });

});
