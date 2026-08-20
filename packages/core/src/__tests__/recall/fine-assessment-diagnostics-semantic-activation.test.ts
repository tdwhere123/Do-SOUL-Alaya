import { describe, expect, it } from "vitest";
import { createFineAssessmentDiagnostic } from
  "../../recall/delivery/diagnostics/fine-assessment-diagnostics.js";
import type {
  FineAssessmentCandidate,
  FineAssessmentSelectionContext
} from "../../recall/delivery/fine-assessment-selection.js";
import {
  OPEN_SEMANTIC_FACTOR_CANDIDATE_ACTIVATION_OPERATOR_ID,
  type OpenSemanticFactorCandidateActivation
} from "../../recall/field/open-semantic-factors/candidate-attribution.js";
import { digestRecallFieldIdentity } from
  "../../recall/field/field-identity.js";
import type { RecallCandidateDiagnostic } from
  "../../recall/runtime/recall-service-types.js";
import {
  createCandidate,
  createConfig,
  createSupplementaryData
} from "./fine-assessment-selection-fixtures.js";

describe("fine-assessment candidate semantic activation provenance", () => {
  it("names the OSF winner when embedding_similarity rank exists without embeddings", () => {
    const candidate = q1Candidate();
    const diagnostic = diagnose(candidate, {
      openSemanticFactorCandidateActivationsByCandidateKey: new Map([
        [candidate.fusion.candidate_key, osfActivation(1)]
      ])
    });

    expect(diagnostic.semantic_activation?.winner?.channel).toBe(
      "open_semantic_solution"
    );
    expect(diagnostic.semantic_activation).toMatchObject({
      state: "observed",
      score: 1,
      winner: { channel: "open_semantic_solution", score: 1 }
    });
    expect(diagnostic.semantic_activation?.observations).toEqual(
      expect.arrayContaining([
        { channel: "open_semantic_solution", state: "observed", score: 1 },
        { channel: "effective_factor", state: "absent", score: null },
        { channel: "object_embedding", state: "absent", score: null }
      ])
    );
    expect(rankingContract(diagnostic)).toEqual(rankingContractFrom(candidate));
  });

  it("names an embedding winner without retuning ranks", () => {
    const candidate = q1Candidate();
    const diagnostic = diagnose(candidate, {
      embeddingSimilarityScores: { [candidate.entry.object_id]: 0.73 }
    });

    expect(diagnostic.semantic_activation?.winner).toEqual({
      channel: "object_embedding",
      score: 0.73
    });
    expect(rankingContract(diagnostic)).toEqual(rankingContractFrom(candidate));
  });

  it("emits absent activation when no semantic channel is observed", () => {
    const candidate = q1Candidate();
    const diagnostic = diagnose(candidate, {});

    expect(diagnostic.semantic_activation).toMatchObject({
      state: "absent",
      score: null,
      winner: null
    });
    expect(rankingContract(diagnostic)).toEqual(rankingContractFrom(candidate));
  });
});

function q1Candidate(): FineAssessmentCandidate {
  const candidate = createCandidate("q1-gold");
  return {
    ...candidate,
    fusion: {
      ...candidate.fusion,
      fused_rank: 1,
      fused_score: 0.81,
      per_stream_rank: {
        ...candidate.fusion.per_stream_rank,
        embedding_similarity: 1
      },
      fused_rank_contribution_per_stream: {
        ...candidate.fusion.fused_rank_contribution_per_stream,
        embedding_similarity: 0.42
      }
    }
  };
}

function diagnose(
  candidate: FineAssessmentCandidate,
  supplementary: Parameters<typeof createSupplementaryData>[0]
): RecallCandidateDiagnostic {
  const candidateKey = candidate.fusion.candidate_key;
  return createFineAssessmentDiagnostic(
    candidate,
    candidateKey,
    1,
    1,
    null,
    diagnosticContext(candidate, supplementary),
    "final_selector"
  );
}

function diagnosticContext(
  candidate: FineAssessmentCandidate,
  supplementary: Parameters<typeof createSupplementaryData>[0]
): FineAssessmentSelectionContext {
  const candidateKey = candidate.fusion.candidate_key;
  return {
    config: createConfig(),
    supplementaryData: createSupplementaryData(supplementary),
    tokenEstimator: { estimate: () => 6 },
    rankByCandidateKey: new Map([[candidateKey, 1]]),
    finalRelevanceByCandidateKey: new Map(),
    coverageRelevanceByCandidateKey: new Map(),
    coverageRelevanceUpperBound: null,
    answerRelevanceRankByCandidateKey: new Map(),
    captureAnswerFeatures: false,
    answerShapePlan: {
      schema_version: 1,
      status: "unknown",
      shape: null,
      target_terms: [],
      relation_terms: []
    },
    supportsSingleSemanticLeader: true,
    answerSupportByCandidateKey: new Map(),
    answerSupportObservationsByCandidateKey: new Map(),
    deepHeadTraceByCandidateKey: new Map(),
    coverageMarginalGainByCandidateKey: new Map(),
    tokenEstimateByCandidateKey: new Map()
  };
}

function rankingContract(diagnostic: RecallCandidateDiagnostic) {
  return {
    fused_rank: diagnostic.fused_rank,
    fused_score: diagnostic.fused_score,
    per_stream_rank: diagnostic.per_stream_rank,
    fused_rank_contribution_per_stream: diagnostic.fused_rank_contribution_per_stream,
    final_rank: diagnostic.final_rank,
    relevance_score: diagnostic.relevance_score,
    additive_score: diagnostic.additive_score,
    rank_after_fusion: diagnostic.rank_after_fusion
  };
}

function rankingContractFrom(candidate: FineAssessmentCandidate) {
  return {
    fused_rank: candidate.fusion.fused_rank,
    fused_score: candidate.fusion.fused_score,
    per_stream_rank: candidate.fusion.per_stream_rank,
    fused_rank_contribution_per_stream: candidate.fusion.fused_rank_contribution_per_stream,
    final_rank: 1,
    relevance_score: candidate.fusion.fused_score,
    additive_score: candidate.effectiveScore,
    rank_after_fusion: candidate.fusion.fused_rank
  };
}

function osfActivation(score: number): OpenSemanticFactorCandidateActivation {
  const body = Object.freeze({
    schema_version: 1 as const,
    operator_id: OPEN_SEMANTIC_FACTOR_CANDIDATE_ACTIVATION_OPERATOR_ID,
    state: "observed" as const,
    score,
    evidence_ids: Object.freeze(["evidence-q1"]),
    solution_count: 1,
    proposition_match_count: 1
  });
  return Object.freeze({
    ...body,
    receipt_digest: digestRecallFieldIdentity(body)
  });
}
