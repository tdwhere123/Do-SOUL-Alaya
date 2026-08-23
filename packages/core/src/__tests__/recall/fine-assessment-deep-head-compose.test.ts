import { describe, expect, it } from "vitest";
import { applyDeliverySelection } from
  "../../recall/delivery/delivery-selection.js";
import { composeFineAssessmentDeepHeadDelivery } from
  "../../recall/delivery/fine-assessment-deep-head.js";
import { resolveDeepHeadAssessment, type RecallDeepHeadAssessment } from
  "../../recall/rerank/deep-head.js";
import { evidenceSemanticActivationsFromScores } from
  "./fixtures/evidence-semantic-activation.js";
import { emptySupplementary, fusedCandidate } from
  "./rerank/deep-head-fixtures.js";

function assessment(
  overrides: Partial<RecallDeepHeadAssessment> = {}
): RecallDeepHeadAssessment {
  return Object.freeze({
    scores: new Map([["workspace_local:memory_entry:a", 0.91]]),
    independentEmbeddingScores: new Map(),
    traceByCandidateKey: new Map(),
    embeddingObserved: false,
    relevanceUpperBoundReceipt: null,
    ...overrides
  });
}

const FUSION_PUBLIC = { replacePublicRelevance: false } as const;

describe("composeFineAssessmentDeepHeadDelivery", () => {
  it("keeps fused order and Gamma relevance when embedding was not observed", () => {
    const composed = composeFineAssessmentDeepHeadDelivery(assessment());
    expect(composed.orderScores.size).toBe(0);
    expect(composed.coverageRelevance.size).toBe(0);
    expect(composed.coverageRelevanceUpperBound).toBeNull();
  });

  it("lets observed independent embedding rescore the eligible pool", () => {
    const embeddingScores = new Map([["workspace_local:memory_entry:a", 0.91]]);
    const mixedScores = new Map([["workspace_local:memory_entry:a", 0.99]]);
    const composed = composeFineAssessmentDeepHeadDelivery(assessment({
      embeddingObserved: true,
      scores: mixedScores,
      independentEmbeddingScores: embeddingScores
    }));
    expect(composed.orderScores).toBe(embeddingScores);
    expect(composed.coverageRelevance).toBe(embeddingScores);
    expect(composed.orderScores).not.toBe(mixedScores);
  });

  it("does not let lexical concurrence residual invert a higher R_obj", () => {
    const gold = fusedCandidate({
      objectId: "gold",
      fusedScore: 0.08,
      fusedRank: 1,
      embedding: 0.4,
      contributions: { lexical_fts: 0.016 }
    });
    const distractor = fusedCandidate({
      objectId: "distractor",
      fusedScore: 0.04,
      fusedRank: 50,
      embedding: 0.2,
      contributions: { lexical_fts: 0.012 }
    });
    const candidates = [gold, distractor];
    const resolved = resolveDeepHeadAssessment({
      candidates,
      answerRelevanceScores: new Map(),
      supplementaryData: emptySupplementary({
        ftsRanks: { distractor: 1 },
        trigramFtsRanks: { distractor: 1 }
      })
    });
    expect(resolved.embeddingObserved).toBe(true);
    expect(resolved.scores.get(distractor.fusion.candidate_key)!)
      .toBeGreaterThan(resolved.scores.get(gold.fusion.candidate_key)!);

    const composed = composeFineAssessmentDeepHeadDelivery(resolved);
    const ordered = applyDeliverySelection(
      candidates, composed.orderScores, FUSION_PUBLIC
    ).orderedCandidates.map((candidate) => candidate.entry.object_id);
    expect(ordered[0]).toBe("gold");
    expect(composed.orderScores.get(gold.fusion.candidate_key)!)
      .toBeGreaterThan(composed.orderScores.get(distractor.fusion.candidate_key)!);
  });

  it("does not let evidence-semantic residual invert a higher R_obj", () => {
    const gold = fusedCandidate({
      objectId: "gold",
      fusedScore: 0.08,
      fusedRank: 1,
      embedding: 0.4,
      contributions: { lexical_fts: 0.016 }
    });
    const distractor = fusedCandidate({
      objectId: "distractor",
      fusedScore: 0.04,
      fusedRank: 50,
      contributions: { lexical_fts: 0.012 }
    });
    const candidates = [gold, distractor];
    const resolved = resolveDeepHeadAssessment({
      candidates,
      answerRelevanceScores: new Map(),
      supplementaryData: {
        ...emptySupplementary(),
        evidenceSemanticActivationsByCandidateKey:
          evidenceSemanticActivationsFromScores(
            new Map([[distractor.fusion.candidate_key, 0.95]])
          )
      }
    });
    expect(resolved.scores.get(distractor.fusion.candidate_key)!)
      .toBeGreaterThan(resolved.scores.get(gold.fusion.candidate_key)!);

    const composed = composeFineAssessmentDeepHeadDelivery(resolved);
    const ordered = applyDeliverySelection(
      candidates, composed.orderScores, FUSION_PUBLIC
    ).orderedCandidates.map((candidate) => candidate.entry.object_id);
    expect(ordered[0]).toBe("gold");
  });

  it("does not let capsule evidence_semantic buy independent-embedding Gamma quality", () => {
    const gold = fusedCandidate({
      objectId: "gold",
      fusedScore: 0.08,
      fusedRank: 1,
      embedding: 0.4
    });
    const capsule = fusedCandidate({
      objectId: "capsule",
      fusedScore: 0.04,
      fusedRank: 50,
      objectKind: "evidence_capsule"
    });
    const resolved = resolveDeepHeadAssessment({
      candidates: [gold, capsule],
      answerRelevanceScores: new Map(),
      supplementaryData: {
        ...emptySupplementary(),
        evidenceSemanticActivationsByCandidateKey:
          evidenceSemanticActivationsFromScores(
            new Map([[capsule.fusion.candidate_key, 0.95]])
          )
      }
    });
    expect(resolved.independentEmbeddingScores.has(capsule.fusion.candidate_key))
      .toBe(false);
    const composed = composeFineAssessmentDeepHeadDelivery(resolved);
    expect(composed.coverageRelevance.has(capsule.fusion.candidate_key)).toBe(false);
    expect(composed.coverageRelevance.get(gold.fusion.candidate_key))
      .toBeCloseTo(0.4);
  });
});
