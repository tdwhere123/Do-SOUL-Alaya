import { describe, expect, it } from "vitest";
import { FullGoldDeliveryContributionSchema } from "@do-soul/alaya-eval";
import {
  classifyGoldDeliveryMissTaxonomy,
  classifyReplayGoldDeliveryMissTaxonomy,
  resolveCoreDeliveryRank,
  toDeliveryMissCandidateInput
} from "../../longmemeval/diagnostics-delivery-bridge.js";
import type {
  CandidateDiagnostic,
  LongMemEvalGoldDiagnostic,
  LongMemEvalReplayCandidate
} from "../../longmemeval/diagnostics-types.js";

function sampleCandidate(
  overrides: Partial<CandidateDiagnostic> = {}
): CandidateDiagnostic {
  return {
    candidateKey: "workspace_local:memory_entry:gold-a",
    objectId: "gold-a",
    objectKind: "memory_entry",
    createdAt: null,
    facetOverlap: null,
    dimension: null,
    originPlane: "workspace_local",
    preBudgetRank: 4,
    selectionOrder: null,
    finalRank: null,
    fusedRank: 4,
    fusedScore: 0.4,
    answerRelevanceScore: null,
    answerRelevanceRank: null,
    perStreamRank: null,
    fusedRankContributionPerStream: null,
    perAxisRank: null,
    perAxisContribution: null,
    floodPotential: null,
    floodFuelCoverage: null,
    planeFirstAdmitted: null,
    planeWinningAdmission: null,
    sourcePlanes: [],
    lexicalRank: null,
    structuralScore: null,
    scoreFactors: null,
    sourceChannels: [],
    budgetDropReason: "max_entries",
    rankAfterFusion: 4,
    rankAfterFeatureRerank: null,
    rankAfterLexicalPriority: null,
    rankAfterSynthesisReserve: null,
    rankAfterStructuralReserve: null,
    rankAfterCoverageSelector: null,
    rankAfterSessionCoverage: null,
    answerFeatures: null,
    pathSuppressionScore: null,
    coverageSelectorAction: null,
    sessionCoverageAction: null,
    sessionKey: null,
    sourceCohortKey: null,
    reservedBy: null,
    ...overrides
  };
}

function sampleGold(
  overrides: Partial<LongMemEvalGoldDiagnostic> = {}
): LongMemEvalGoldDiagnostic {
  return {
    object_id: "g1",
    candidate_status: "candidate_not_delivered",
    dimension: null,
    final_rank: null,
    active_constraint_rank: null,
    pre_budget_rank: 4,
    selection_order: null,
    fused_rank: null,
    fused_score: null,
    answer_relevance_score: null,
    answer_relevance_rank: null,
    per_stream_rank: null,
    fused_rank_contribution_per_stream: null,
    per_axis_rank: null,
    per_axis_contribution: null,
    flood_potential: null,
    flood_fuel_coverage: null,
    plane_first_admitted: null,
    plane_winning_admission: null,
    source_planes: [],
    miss_taxonomy: null,
    lexical_rank: null,
    structural_score: null,
    score_factors: null,
    source_channels: [],
    budget_drop_reason: "max_entries",
    rank_after_fusion: null,
    rank_after_feature_rerank: null,
    rank_after_lexical_priority: null,
    rank_after_synthesis_reserve: null,
    rank_after_structural_reserve: null,
    rank_after_coverage_selector: null,
    rank_after_session_coverage: null,
    coverage_selector_action: null,
    session_coverage_action: null,
    session_key: null,
    source_cohort_key: null,
    reserved_by: null,
    ...overrides
  };
}

describe("diagnostics-delivery-bridge", () => {
  it("maps candidate diagnostics into delivery miss inputs", () => {
    expect(toDeliveryMissCandidateInput(sampleCandidate())).toEqual({
      objectKind: "memory_entry",
      preBudgetRank: 4,
      fusedRank: 4,
      finalRank: null,
      droppedReason: "max_entries",
      rankAfterFusion: 4,
      rankAfterFeatureRerank: null,
      rankAfterCoverageSelector: null,
      coverageSelectorAction: null
    });
  });

  it("rejects unknown budget drop reason strings", () => {
    expect(
      toDeliveryMissCandidateInput(
        sampleCandidate({ budgetDropReason: "unknown_reason" })
      ).droppedReason
    ).toBeNull();
  });

  it("preserves embedding-head dominance through the diagnostic bridge", () => {
    const roundTripped = JSON.parse(JSON.stringify(sampleCandidate({
      budgetDropReason: "embedding_head_dominance"
    }))) as CandidateDiagnostic;
    expect(
      toDeliveryMissCandidateInput(roundTripped).droppedReason
    ).toBe("embedding_head_dominance");
  });

  it("uses fusion-stage ranks only for core delivery rank", () => {
    expect(resolveCoreDeliveryRank(sampleGold())).toBeNull();
    expect(
      resolveCoreDeliveryRank(
        sampleGold({
          object_id: "g2",
          candidate_status: "delivered",
          final_rank: 3,
          pre_budget_rank: 40,
          fused_rank: 8,
          budget_drop_reason: null,
          rank_after_fusion: 3,
          rank_after_coverage_selector: 8,
          coverage_selector_action: "displaced"
        })
      )
    ).toBe(3);
  });

  it("returns null gold taxonomy when diagnostics are unavailable", () => {
    expect(
      classifyGoldDeliveryMissTaxonomy({
        deliveredRank: null,
        candidate: undefined,
        anyObjectCandidate: undefined,
        diagnosticsAvailable: false
      })
    ).toBeNull();
  });

  it("classifies live diagnostics from the feature-to-coverage crossing", () => {
    expect(classifyGoldDeliveryMissTaxonomy({
      deliveredRank: 9,
      candidate: sampleCandidate({
        preBudgetRank: null,
        budgetDropReason: null,
        finalRank: 9,
        rankAfterFusion: 3,
        rankAfterFeatureRerank: 8,
        rankAfterCoverageSelector: 9,
        coverageSelectorAction: "displaced"
      }),
      anyObjectCandidate: undefined,
      diagnosticsAvailable: true
    })).toBe("delivery_order_drop");
    expect(classifyGoldDeliveryMissTaxonomy({
      deliveredRank: 8,
      candidate: sampleCandidate({
        preBudgetRank: null,
        budgetDropReason: null,
        finalRank: 8,
        rankAfterFusion: 8,
        rankAfterFeatureRerank: 3,
        rankAfterCoverageSelector: 8,
        coverageSelectorAction: "displaced"
      }),
      anyObjectCandidate: undefined,
      diagnosticsAvailable: true
    })).toBe("answer_set_coverage_drop");
  });

  it("uses the replay feature rank as the pre-coverage boundary", () => {
    expect(classifyReplayGoldDeliveryMissTaxonomy({
      deliveredRank: 9,
      candidate: sampleReplayCandidate({
        rank_after_fusion: 3,
        rank_after_feature_rerank: 8,
        rank_after_coverage_selector: 9,
        coverage_selector_action: "displaced"
      }),
      anyObjectCandidate: undefined,
      diagnosticsAvailable: true
    })).toBe("delivery_order_drop");
    expect(classifyReplayGoldDeliveryMissTaxonomy({
      deliveredRank: 8,
      candidate: sampleReplayCandidate({
        rank_after_fusion: 8,
        rank_after_feature_rerank: 3,
        rank_after_coverage_selector: 8,
        coverage_selector_action: "displaced"
      }),
      anyObjectCandidate: undefined,
      diagnosticsAvailable: true
    })).toBe("answer_set_coverage_drop");
  });
});

const BASE_REPLAY_CANDIDATE: LongMemEvalReplayCandidate = {
  object_id: "gold-a",
  object_kind: "memory_entry",
  candidate_key: "workspace_local:memory_entry:gold-a",
  origin_plane: "workspace_local",
  dimension: null,
  final_rank: null,
  pre_budget_rank: null,
  selection_order: null,
  fused_rank: null,
  fused_score: null,
  answer_relevance_score: null,
  answer_relevance_rank: null,
  per_stream_rank: null,
  fused_rank_contribution_per_stream: null,
  per_axis_rank: null,
  per_axis_contribution: null,
  flood_potential: null,
  flood_fuel_coverage: null,
  plane_first_admitted: null,
  plane_winning_admission: null,
  source_planes: [],
  source_channels: [],
  lexical_rank: null,
  structural_score: null,
  budget_drop_reason: null,
  rank_after_fusion: null,
  rank_after_feature_rerank: null,
  rank_after_lexical_priority: null,
  rank_after_synthesis_reserve: null,
  rank_after_structural_reserve: null,
  rank_after_coverage_selector: null,
  rank_after_session_coverage: null,
  coverage_selector_action: null,
  session_coverage_action: null,
  session_key: null,
  source_cohort_key: null,
  reserved_by: null,
  answer_features: null,
  path_suppression_score: null,
  score_factors: {}
};

function sampleReplayCandidate(
  overrides: Partial<LongMemEvalReplayCandidate> = {}
): LongMemEvalReplayCandidate {
  return { ...BASE_REPLAY_CANDIDATE, ...overrides };
}

describe("FullGoldDeliveryContributionSchema", () => {
  it("accepts analyze output shape from buildLongMemEvalFullGoldCoverage", async () => {
    const { buildLongMemEvalFullGoldCoverage } = await import(
      "../../longmemeval/diagnostics.js"
    );
    const { buildGoldDiagnostic, buildQuestionDiagnosticFixture } = await import(
      "./gold-diagnostic-fixture.js"
    );
    const question = buildQuestionDiagnosticFixture({
      questionId: "q-schema",
      gold: [
        buildGoldDiagnostic({
          object_id: "g1",
          final_rank: 4,
          rank_after_fusion: 8
        })
      ]
    });
    const contribution = buildLongMemEvalFullGoldCoverage([question])
      .delivery_contribution;
    expect(
      FullGoldDeliveryContributionSchema.parse(contribution)
    ).toBeTruthy();
  });
});
