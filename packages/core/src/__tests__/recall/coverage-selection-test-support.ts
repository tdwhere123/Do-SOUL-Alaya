import {
  MemoryDimension,
  ScopeClass,
  type MemoryEntry,
  type RecallScoreFactors
} from "@do-soul/alaya-protocol";
import {
  orderByCoverageMarginalGain,
  resolveCoverageIdentity,
  type CoverageMarginalObservation,
  type CoverageSelectionObjective
} from "../../recall/delivery/coverage-selection.js";
import type { CandidateCoverageReceipt } from
  "../../recall/delivery/fine-assessment-selection/coverage-atoms.js";
import type { FineAssessmentCandidate } from
  "../../recall/delivery/fine-assessment-selection.js";
import { buildEmptyRecallFusionBreakdown } from "../../recall/delivery/fusion-delivery-scoring.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import type { RecallSupplementaryData } from "../../recall/runtime/recall-service-types.js";

export function createCandidate(objectId: string, fusedScore: number): FineAssessmentCandidate {
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

export function createMemoryEntry(objectId: string): MemoryEntry {
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

export function withDimension(
  candidate: FineAssessmentCandidate,
  dimension: MemoryDimension
): FineAssessmentCandidate {
  return { ...candidate, entry: { ...candidate.entry, dimension } };
}

export function createScoreFactors(): RecallScoreFactors {
  return {
    activation: 0.7,
    relevance: 0.6,
    graph_support: 0,
    path_plasticity: 0,
    budget_penalty: 0,
    conflict_penalty: 0
  };
}

export function createRanks(candidates: readonly FineAssessmentCandidate[]): ReadonlyMap<string, number> {
  return new Map(candidates.map((candidate, index) => [candidate.fusion.candidate_key, index + 1]));
}

export function relevanceMap(candidates: readonly FineAssessmentCandidate[]): ReadonlyMap<string, number> {
  return new Map(candidates.map((candidate) => [
    candidate.fusion.candidate_key,
    candidate.fusion.fused_score
  ]));
}

export function legacyCoveragePass(
  candidates: readonly FineAssessmentCandidate[],
  relevanceByCandidateKey: ReadonlyMap<string, number>,
  supplementaryData: RecallSupplementaryData,
  rejected: ReadonlySet<string>
): Readonly<{
  readonly ordered: readonly FineAssessmentCandidate[];
  readonly observations: readonly CoverageMarginalObservation[];
}> {
  const remaining = [...candidates];
  const ordered: FineAssessmentCandidate[] = [];
  const observations: CoverageMarginalObservation[] = [];
  const objectCounts = new Map<string, number>();
  const gistCounts = new Map<string, number>();
  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestGain = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index]!;
      const identity = resolveCoverageIdentity(candidate, supplementaryData);
      const relevance = relevanceByCandidateKey.get(candidate.fusion.candidate_key) ?? 0;
      const gain = relevance / (
        1 + (objectCounts.get(identity.objectKey) ?? 0) + (gistCounts.get(identity.gistKey) ?? 0)
      );
      if (gain > bestGain) [bestIndex, bestGain] = [index, gain];
    }
    const picked = remaining.splice(bestIndex, 1)[0]!;
    const identity = resolveCoverageIdentity(picked, supplementaryData);
    ordered.push(picked);
    observations.push(Object.freeze({
      candidate_key: picked.fusion.candidate_key,
      marginal_gain: bestGain,
      selection_order: ordered.length
    }));
    if (rejected.has(picked.fusion.candidate_key)) continue;
    objectCounts.set(identity.objectKey, (objectCounts.get(identity.objectKey) ?? 0) + 1);
    gistCounts.set(identity.gistKey, (gistCounts.get(identity.gistKey) ?? 0) + 1);
  }
  return { ordered, observations };
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
    evidenceSemanticActivationsByCandidateKey: new Map(),
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

export function captureCoverageReceipt(
  candidate: FineAssessmentCandidate,
  supplementaryData: RecallSupplementaryData
): CandidateCoverageReceipt {
  let receipt: CandidateCoverageReceipt | null = null;
  const objective: CoverageSelectionObjective<
    FineAssessmentCandidate,
    Record<string, never>
  > = Object.freeze({
    operator_id: "coverage_receipt_probe_v1",
    createState: () => ({}),
    marginalGain: ({ coverage, relevance }) => {
      receipt = coverage;
      return relevance;
    },
    accept: () => {}
  });
  orderByCoverageMarginalGain({
    candidates: [candidate],
    relevanceByCandidateKey: relevanceMap([candidate]),
    supplementaryData,
    objective
  });
  if (receipt === null) throw new Error("coverage receipt was not observed");
  return receipt;
}
