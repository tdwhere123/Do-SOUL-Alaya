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

export function createRankedCandidate(
  objectId: string,
  fusedRank: number,
  fusedScore: number
): FineAssessmentCandidate {
  const candidate = createCandidate(objectId);
  return {
    ...candidate,
    fusion: { ...candidate.fusion, fused_rank: fusedRank, fused_score: fusedScore }
  };
}

export function rankMap(
  candidates: readonly FineAssessmentCandidate[]
): ReadonlyMap<string, number> {
  return new Map(candidates.map((candidate) => [
    candidate.fusion.candidate_key,
    candidate.fusion.fused_rank
  ]));
}

export function stageRanks(
  result: ReturnType<typeof selectFineAssessmentCandidates>,
  objectId: string
) {
  const diagnostic = result.diagnostics.find((candidate) => candidate.object_id === objectId);
  return [
    diagnostic?.rank_after_feature_rerank,
    diagnostic?.rank_after_coverage_selector,
    diagnostic?.coverage_selector_action
  ];
}

export function createCandidate(
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

export function createConfig() {
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

export function createRanks(): ReadonlyMap<string, number> {
  return new Map();
}

export function createSupplementaryData(
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
