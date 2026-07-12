import { describe, expect, it, vi } from "vitest";
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
import { RECALL_DIAGNOSTIC_EVIDENCE_GIST_MAX_CHARS } from "../../recall/delivery/fine-assessment-answer-features.js";
import { buildEmptyRecallFusionBreakdown } from "../../recall/delivery/fusion-delivery-scoring.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import type { RecallSupplementaryData } from "../../recall/runtime/recall-service-types.js";

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

  it("copies bounded answer features and path suppression from existing recall state", () => {
    const longGist = `  ${"g".repeat(RECALL_DIAGNOSTIC_EVIDENCE_GIST_MAX_CHARS + 4)}  `;
    const candidate = createCandidate("memory-1", {
      projection_schema_version: 1,
      event_time_start: "2026-05-01T00:00:00.000Z",
      event_time_end: "2026-05-02T00:00:00.000Z",
      valid_from: "2026-05-03T00:00:00.000Z",
      valid_to: "2026-05-04T00:00:00.000Z",
      time_precision: "day",
      time_source: "explicit",
      preference_subject: "alice",
      preference_predicate: "likes",
      preference_object: "tea",
      preference_category: "drink",
      preference_polarity: "positive",
      facet_tags: [{ facet: "food_dining", value: "tea" }],
      canonical_entities: ["alice", "tea"]
    });
    const supplementaryData = createSupplementaryData({
      evidenceGistsByMemoryId: { "memory-1": longGist },
      pathSuppressionScores: { "memory-1": 0.25 }
    });

    const result = selectFineAssessmentCandidates({
      orderedCandidates: [candidate],
      config: createConfig(),
      supplementaryData,
      tokenEstimator: { estimate: vi.fn(() => 6) },
      rankByCandidateKey: createRanks(),
      captureAnswerFeatures: true
    });

    expect(result.diagnostics[0]).toMatchObject({
      path_suppression_score: 0.25,
      answer_features: {
        content: "Recall content for memory-1.",
        evidence_gist: "g".repeat(RECALL_DIAGNOSTIC_EVIDENCE_GIST_MAX_CHARS),
        evidence_gist_truncated: true,
        domain_tags: ["repo"],
        evidence_refs: [],
        facet_tags: [{ facet: "food_dining", value: "tea" }],
        canonical_entities: ["alice", "tea"],
        projection_schema_version: 1,
        preference_subject: "alice",
        preference_predicate: "likes",
        preference_object: "tea",
        preference_category: "drink",
        preference_polarity: "positive",
        event_time_start: "2026-05-01T00:00:00.000Z",
        event_time_end: "2026-05-02T00:00:00.000Z",
        valid_from: "2026-05-03T00:00:00.000Z",
        valid_to: "2026-05-04T00:00:00.000Z",
        time_precision: "day",
        time_source: "explicit"
      }
    });
  });

  it("emits null gist metadata without fabricating synthesis projections", () => {
    const synthesis = createCandidate("synthesis-1", {
      evidence_refs: ["synthesis-evidence-1"],
      projection_schema_version: 1,
      preference_subject: "fabricated",
      facet_tags: [{ facet: "occupation_work", value: "fabricated" }],
      canonical_entities: ["fabricated"]
    }, "synthesis_capsule");

    const result = selectFineAssessmentCandidates({
      orderedCandidates: [synthesis],
      config: createConfig(),
      supplementaryData: createSupplementaryData(),
      tokenEstimator: { estimate: vi.fn(() => 6) },
      rankByCandidateKey: createRanks(),
      captureAnswerFeatures: true
    });

    expect(result.diagnostics[0]?.answer_features).toEqual({
      content: "Recall content for synthesis-1.",
      evidence_gist: null,
      evidence_gist_truncated: false,
      domain_tags: [],
      evidence_refs: ["synthesis-evidence-1"],
      facet_tags: [],
      canonical_entities: [],
      projection_schema_version: null,
      event_time_start: null,
      event_time_end: null,
      valid_from: null,
      valid_to: null,
      time_precision: null,
      time_source: null,
      preference_subject: null,
      preference_predicate: null,
      preference_object: null,
      preference_category: null,
      preference_polarity: null
    });
    expect(result.diagnostics[0]?.path_suppression_score).toBe(0);
  });

  it("omits answer features unless deep diagnostic capture is explicit", () => {
    const result = selectFineAssessmentCandidates({
      orderedCandidates: [createCandidate("memory-1")],
      config: createConfig(),
      supplementaryData: createSupplementaryData(),
      tokenEstimator: { estimate: vi.fn(() => 6) },
      rankByCandidateKey: createRanks()
    });

    expect(result.diagnostics[0]).not.toHaveProperty("answer_features");
  });
});

function createCandidate(
  objectId: string,
  entryOverrides: Partial<MemoryEntry> = {},
  objectKind: FineAssessmentCandidate["objectKind"] = "memory_entry"
): FineAssessmentCandidate {
  const breakdown = buildEmptyRecallFusionBreakdown(objectId);
  return {
    entry: { ...createMemoryEntry(objectId), ...entryOverrides },
    objectKind,
    effectiveScore: 0.7,
    effectiveFactors: createScoreFactors(),
    fusion: {
      ...breakdown,
      fused_rank: 1,
      fused_score: 0.7
    }
  };
}

function createConfig() {
  return {
    conflict_awareness: false,
    budgets: {
      max_entries: 10,
      max_total_tokens: 100,
      per_dimension_limits: null
    }
  } as const;
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

function createRanks(): ReadonlyMap<string, number> {
  return new Map();
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
