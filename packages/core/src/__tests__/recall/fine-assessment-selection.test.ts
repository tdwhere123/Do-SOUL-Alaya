import { describe, expect, it, vi } from "vitest";
import {
  MemoryDimension,
  ScopeClass,
  type MemoryEntry,
  type RecallScoreFactors
} from "@do-soul/alaya-protocol";
import {
  selectFineAssessmentCandidates,
  type FineAssessmentCandidate,
  type FineAssessmentRankDiagnostics
} from "../../recall/fine-assessment-selection.js";
import { buildEmptyRecallFusionBreakdown } from "../../recall/fusion-delivery-scoring.js";
import { compileRecallQueryProbes } from "../../recall/recall-query-probes.js";
import type { RecallSupplementaryData } from "../../recall/recall-service-types.js";

describe("selectFineAssessmentCandidates", () => {
  it("uses a single token estimate per candidate that reaches token-budget evaluation", () => {
    const estimate = vi.fn(() => 6);

    const result = selectFineAssessmentCandidates({
      deliveryOrderedCandidates: [
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
      ranks: createRanks()
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.diagnostics[1]?.dropped_reason).toBe("max_total_tokens");
    expect(estimate).toHaveBeenCalledTimes(2);
  });
});

function createCandidate(objectId: string): FineAssessmentCandidate {
  const breakdown = buildEmptyRecallFusionBreakdown(objectId);
  return {
    entry: createMemoryEntry(objectId),
    effectiveScore: 0.7,
    effectiveFactors: createScoreFactors(),
    fusion: {
      ...breakdown,
      fused_rank: 1,
      fused_score: 0.7
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

function createRanks(): FineAssessmentRankDiagnostics {
  return {
    rankAfterFusion: new Map(),
    rankAfterFeatureRerank: new Map(),
    rankAfterLexicalPriority: new Map(),
    rankAfterCoverageSelector: new Map(),
    rankAfterSessionCoverage: new Map(),
    rankAfterSynthesisReserve: new Map(),
    rankAfterStructuralReserve: new Map(),
    coverageSelectorNoop: true,
    sessionCoverageNoop: true
  };
}

function createSupplementaryData(): RecallSupplementaryData {
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
    governanceCeilingByMemoryId: {}
  };
}
