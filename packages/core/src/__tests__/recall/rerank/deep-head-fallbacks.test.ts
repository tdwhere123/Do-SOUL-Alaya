import { describe, expect, it } from "vitest";
import type { DeliverySelectionCandidate } from
  "../../../recall/delivery/delivery-selection.js";
import { composeFineAssessmentDeepHeadDelivery } from
  "../../../recall/delivery/fine-assessment-deep-head.js";
import { applyDeliverySelection } from
  "../../../recall/delivery/delivery-selection.js";
import { orderByCoverageMarginalGain } from
  "../../../recall/delivery/coverage-selection.js";
import {
  computeLightweightDeepHeadScores,
  resolveDeepHeadAssessment
} from "../../../recall/rerank/deep-head.js";
import { emptySupplementary, fusedCandidate } from "./deep-head-fixtures.js";

describe("deep head fallbacks", () => {
  it("keeps missing and invalid embeddings cold beside an observed supplementary zero", () => {
    const observedZero = fusedCandidate({
      objectId: "observed-zero",
      fusedScore: 0.9,
      contributions: { lexical_fts: 0.016 }
    });
    const missing = fusedCandidate({
      objectId: "missing",
      fusedScore: 0.08,
      contributions: { lexical_fts: 0.015 }
    });
    const invalid = fusedCandidate({
      objectId: "invalid",
      fusedScore: 0.07,
      embedding: Number.NaN,
      contributions: { lexical_fts: 0.014 }
    });
    const candidates = [observedZero, missing, invalid];
    const scores = computeLightweightDeepHeadScores(
      candidates,
      emptySupplementary({ embeddingSimilarityScores: { "observed-zero": 0 } })
    );
    const packed = orderByCoverageMarginalGain({
      candidates,
      relevanceByCandidateKey: scores,
      supplementaryData: { evidenceGistsByMemoryId: {} }
    });

    expect(scores.get(observedZero.fusion.candidate_key)).toBeCloseTo(0.9);
    expect(scores.get(missing.fusion.candidate_key)).toBeCloseTo(0.08);
    expect(scores.get(invalid.fusion.candidate_key)).toBeCloseTo(0.07);
    expect(packed.map((candidate) => candidate.entry.object_id))
      .toEqual(["observed-zero", "missing", "invalid"]);
  });

  it("falls back from a non-finite factor to a finite supplementary embedding", () => {
    const candidate = fusedCandidate({
      objectId: "supplementary-fallback",
      fusedScore: 0.09,
      embedding: Number.NaN,
      contributions: { lexical_fts: 0.016 }
    });

    const scores = computeLightweightDeepHeadScores(
      [candidate],
      emptySupplementary({
        embeddingSimilarityScores: { "supplementary-fallback": 0.42 }
      })
    );

    expect(scores.get(candidate.fusion.candidate_key)).toBeCloseTo(0.4722);
  });

  it("does not leak memory-keyed signals into same-id synthesis or global candidates", () => {
    const local = fusedCandidate({ objectId: "shared", fusedScore: 0.3 });
    const synthesisBase = fusedCandidate({ objectId: "shared", fusedScore: 0.2 });
    const globalBase = fusedCandidate({ objectId: "shared", fusedScore: 0.1 });
    const synthesis: DeliverySelectionCandidate = Object.freeze({
      ...synthesisBase,
      objectKind: "synthesis_capsule",
      fusion: Object.freeze({
        ...synthesisBase.fusion,
        candidate_key: "workspace_local:synthesis_capsule:shared"
      })
    });
    const global: DeliverySelectionCandidate = Object.freeze({
      ...globalBase,
      originPlane: "global",
      fusion: Object.freeze({
        ...globalBase.fusion,
        candidate_key: "global:memory_entry:shared"
      })
    });
    const scores = computeLightweightDeepHeadScores(
      [synthesis, global, local],
      emptySupplementary({
        embeddingSimilarityScores: { shared: 0.8 },
        ftsRanks: { shared: 1 },
        trigramFtsRanks: { shared: 1 },
        evidenceFtsRanks: { shared: 1 },
        structuralScores: { shared: 1 },
        sourceProximityScores: { shared: 1 }
      })
    );

    expect(scores.get(local.fusion.candidate_key)).toBe(1);
    expect(scores.get(synthesis.fusion.candidate_key)).toBe(0);
    expect(scores.get(global.fusion.candidate_key)).toBe(0);
  });

  it("keeps query-supported fusion wins when emb is cold", () => {
    const lexicalRescue = fusedCandidate({
      objectId: "lexical-rescue", fusedScore: 0.08, fusedRank: 2,
      contributions: { path_expansion: 0.016, lexical_fts: 0.012 }
    });
    const conflictOnly = fusedCandidate({
      objectId: "conflict-only", fusedScore: 0.07, fusedRank: 3,
      contributions: { path_expansion: 0.016, existing_score: 0.014 }
    });
    const lexicalPeer = fusedCandidate({
      objectId: "lexical-peer", fusedScore: 0.04, fusedRank: 4,
      contributions: { lexical_fts: 0.013, existing_score: 0.015 }
    });
    const seed = fusedCandidate({
      objectId: "path-seed", fusedScore: 0.09, fusedRank: 1,
      contributions: { path_expansion: 0.015, lexical_fts: 0.014 }
    });
    const scores = computeLightweightDeepHeadScores(
      [seed, lexicalRescue, conflictOnly, lexicalPeer],
      emptySupplementary({
        evidenceFtsRanks: { "lexical-peer": 1, "lexical-rescue": 0.2,
          "path-seed": 0.3, "conflict-only": 0.01 },
        structuralScores: { "lexical-peer": 1, "lexical-rescue": 0.2,
          "path-seed": 0.3, "conflict-only": 0.01 }
      })
    );
    expect(scores.get(lexicalRescue.fusion.candidate_key)).toBeCloseTo(0.264);
    expect(scores.get(lexicalPeer.fusion.candidate_key)).toBeCloseTo(1);
    expect(scores.get(conflictOnly.fusion.candidate_key)!)
      .toBeLessThan(scores.get(lexicalPeer.fusion.candidate_key)!);

    const assessment = resolveDeepHeadAssessment({
      candidates: [seed, lexicalRescue, conflictOnly, lexicalPeer],
      answerRelevanceScores: new Map(),
      supplementaryData: emptySupplementary({
        evidenceFtsRanks: { "lexical-peer": 1, "lexical-rescue": 0.2,
          "path-seed": 0.3, "conflict-only": 0.01 },
        structuralScores: { "lexical-peer": 1, "lexical-rescue": 0.2,
          "path-seed": 0.3, "conflict-only": 0.01 }
      })
    });
    expect(assessment.embeddingObserved).toBe(false);
    const composed = composeFineAssessmentDeepHeadDelivery(assessment);
    const result = applyDeliverySelection(
      [seed, lexicalRescue, conflictOnly, lexicalPeer], composed.orderScores,
      { replacePublicRelevance: false }
    );
    expect(result.orderedCandidates.map((candidate) => candidate.entry.object_id))
      .toEqual(["path-seed", "lexical-rescue", "conflict-only", "lexical-peer"]);
  });

  it("keeps field-only baselines in the existing fused order", () => {
    const pathOnly = fusedCandidate({
      objectId: "path-only", fusedScore: 0.07, fusedRank: 2,
      contributions: { path_expansion: 0.016 }
    });
    const lexicalHead = fusedCandidate({
      objectId: "lexical-head", fusedScore: 0.09, fusedRank: 1,
      contributions: { lexical_fts: 0.014 }
    });
    const lexicalTail = fusedCandidate({
      objectId: "lexical-tail", fusedScore: 0.05, fusedRank: 3,
      contributions: { lexical_fts: 0.012 }
    });
    const scores = computeLightweightDeepHeadScores(
      [lexicalHead, pathOnly, lexicalTail], emptySupplementary()
    );
    expect(scores.size).toBe(3);
    expect(scores.get(lexicalHead.fusion.candidate_key)).toBeCloseTo(0.09);
    expect(scores.get(pathOnly.fusion.candidate_key)).toBeCloseTo(0.07);
    expect(scores.get(lexicalTail.fusion.candidate_key)).toBeCloseTo(0.05);

    const result = applyDeliverySelection([lexicalHead, pathOnly, lexicalTail], scores, {
      replacePublicRelevance: false
    });
    expect(result.orderedCandidates.map((candidate) => candidate.entry.object_id))
      .toEqual(["lexical-head", "path-only", "lexical-tail"]);
  });
});
