import {
  DYNAMICS_CONSTANTS,
  type ActivationWeights,
  type MemoryEntry,
  type RecallAdditiveScoringWeights,
  type RecallCandidate,
  type RecallOriginPlane,
  type RecallPolicy,
  type RecallScoreFactors
} from "@do-soul/alaya-protocol";
import { computeFreshnessFactor } from "../dynamics/dynamics-constants-runtime.js";
import {
  PATH_PLASTICITY_WEIGHT,
  assertActivationWeightsSumToOne,
  clamp01,
  isClaimLikeDimension,
  normalizeActivationScore,
  normalizeGraphSupport,
  resolveActivationWeights,
  toErrorMessage
} from "./recall-service-helpers.js";
import type {
  RecallAdmissionPlane,
  RecallServiceWarnPort,
  RecallSupplementaryData
} from "./recall-service-types.js";

const NO_EMBEDDING_RELEVANCE_DIRECT_WEIGHT = 0.24;
const QUERY_EVIDENCE_BASE_TRANSFER_MAX = 0.25;
const QUERY_EVIDENCE_BASE_WEIGHT_FLOOR = 0.35;
// invariant: confidence sub-weight is additive (outside sum-to-1
// activation_weights). MemoryEntry.confidence is propose/accept-updated
// epistemic certainty; reading it directly here keeps later confidence
// edits visible to recall ordering without waiting for retention decay
// or activation rescore. Final score stays clamp01.
const CONFIDENCE_DIRECT_WEIGHT = 0.08;
// invariant: prior dampening floor — minimum weight applied to the
// prior signal when calibrating weak-evidence candidates so that
// prior-only activation/confidence MUST NOT make weak query evidence
// look answer-confident. Intentionally a SEPARATE constant from the
// calibration gate below so each purpose can be tuned independently
// without silently shifting the other.
const WEAK_EVIDENCE_PRIOR_DAMPENING_FLOOR = 0.72;
// invariant: calibration gate threshold — calibration only fires when
// queryEvidenceCalibrationStrength is BELOW this floor; at-or-above
// evidence is treated as sufficient and the score shape is preserved.
// Matches WEAK_EVIDENCE_PRIOR_DAMPENING_FLOOR by initial design intent
// but is intentionally a separate constant to keep each purpose tunable.
const WEAK_EVIDENCE_CALIBRATION_GATE = 0.72;

export function computeMaxWeightTransferAmount(params: Readonly<{
  readonly candidates: readonly Readonly<MemoryEntry>[];
  readonly policy: Readonly<RecallPolicy>;
  readonly graphAndPathColdScore: number;
  readonly warn: RecallServiceWarnPort;
}>): number {
  if (params.candidates.length === 0 || params.graphAndPathColdScore <= 0) {
    return 0;
  }
  const additiveWeights = resolveAdditiveScoringWeights(params.policy);
  return clamp01(
    Math.max(
      ...params.candidates.map((candidate) => {
        const weights = resolveEffectiveActivationWeights(candidate, params.policy, params.warn);
        return (weights.graph_support + additiveWeights.PATH_PLASTICITY_WEIGHT) * params.graphAndPathColdScore;
      })
    )
  );
}

export function computeEffectiveScoreDetails(params: Readonly<{
  readonly entry: Readonly<MemoryEntry>;
  readonly policy: Readonly<RecallPolicy>;
  readonly winnerMemoryIds: ReadonlySet<string>;
  readonly supplementaryData: RecallSupplementaryData;
  readonly originPlane: RecallOriginPlane;
  readonly isAdvisory: boolean;
  readonly scoreMultiplier?: number;
  readonly objectKind?: RecallCandidate["object_kind"];
  readonly now: () => string;
  readonly warn: RecallServiceWarnPort;
}>): Readonly<{ readonly score: number; readonly factors: RecallScoreFactors }> {
  const {
    entry,
    policy,
    winnerMemoryIds,
    supplementaryData,
    originPlane,
    isAdvisory,
    now,
    warn
  } = params;
  const scoreMultiplier = params.scoreMultiplier ?? 1;
  const objectKind = params.objectKind ?? "memory_entry";
  const config = policy.fine_assessment;
  const additiveWeights = resolveAdditiveScoringWeights(policy);
  const weights = resolveDynamicActivationWeights(
    resolveEffectiveActivationWeights(entry, policy, warn),
    supplementaryData.graphAndPathColdScore,
    additiveWeights.PATH_PLASTICITY_WEIGHT
  );
  const isGlobalCandidate = originPlane === "global";
  const isSynthesisCandidate = objectKind === "synthesis_capsule";
  const canUseMemorySupplement = !isGlobalCandidate && !isSynthesisCandidate;
  // invariant: freshness is counted ONCE. The stored activation_score
  // already bakes a freshness sub-term (weight
  // activation_weights_phase1b.freshness, computed at store time). Multiplying
  // the whole composite by a read-time freshness factor double-counts
  // freshness and wrongly decays the scope/domain/retention sub-terms. Instead
  // decay only the freshness band: the non-freshness floor (stored minus at-most the
  // freshness weight) is preserved, and the freshness band is re-weighted by
  // the read-time factor. last_used_at is the "last reinforced" proxy; created_at
  // floors a never-used memory's age at birth. Bounded: the result is <= stored
  // and at full idle collapses ONLY the <=0.19 freshness contribution (plus the
  // legitimate idle decay), never the whole composite. Only memory entries carry
  // these timestamps, so leave global/synthesis activation un-decayed.
  const storedActivationScore = normalizeActivationScore(entry.activation_score);
  const shouldTimeDecay =
    canUseMemorySupplement && typeof entry.created_at === "string" && entry.created_at.length > 0;
  const freshnessFactorNow = shouldTimeDecay
    ? computeFreshnessFactor({
        lastUsedAt: entry.last_used_at ?? null,
        createdAt: entry.created_at,
        now: now()
      })
    : 1;
  const freshnessWeight = DYNAMICS_CONSTANTS.activation_weights_phase1b.freshness;
  const nonFreshnessFloor = Math.max(0, storedActivationScore - freshnessWeight);
  const activationScore = shouldTimeDecay
    ? Math.min(storedActivationScore, clamp01(nonFreshnessFloor + freshnessWeight * freshnessFactorNow))
    : storedActivationScore;
  const ftsFactor = canUseMemorySupplement ? supplementaryData.ftsRanks[entry.object_id] ?? 0 : 0;
  const synthesisFtsFactor =
    isGlobalCandidate || !isSynthesisCandidate
      ? 0
      : supplementaryData.synthesisFtsRanks[entry.object_id] ?? 0;
  const structuralFactor = canUseMemorySupplement ? supplementaryData.structuralScores[entry.object_id] ?? 0 : 0;
  const queryFtsFactor = Math.max(ftsFactor, synthesisFtsFactor);
  const relevanceFactor =
    queryFtsFactor > 0 && structuralFactor > 0
      ? clamp01(queryFtsFactor * 0.24 + structuralFactor * 0.76)
      : Math.max(queryFtsFactor * 0.62, structuralFactor);
  const graphSupportFactor = canUseMemorySupplement
    ? normalizeGraphSupport(supplementaryData.graphSupportCounts[entry.object_id] ?? 0)
    : 0;
  const embeddingSimilarityFactor = canUseMemorySupplement
    ? clamp01(supplementaryData.embeddingSimilarityScores[entry.object_id] ?? 0)
    : 0;
  const budgetPenalty = supplementaryData.budgetPenaltyFactor;
  // PathPlasticity is supplementary, like the embedding similarity hint:
  // it boosts the score additively but the final value is still clamp01,
  // so a small plasticity boost cannot override a large lexical-rank gap.
  const plasticityFactor = canUseMemorySupplement
    ? clamp01(supplementaryData.plasticityFactors[entry.object_id] ?? 0)
    : 0;
  const conflictPenalty =
    config.conflict_awareness &&
    isClaimLikeDimension(entry.dimension) &&
    !winnerMemoryIds.has(entry.object_id)
      ? 1
      : 0;
  // invariant: contradiction-history degradation. ConflictDetectionService
  // increments MemoryEntry.contradiction_count each time a new memory
  // supersedes or contradicts this one. Recall scoring subtracts a small
  // bounded factor so memories that keep losing arbitration drift down
  // without being tombstoned. Cap at 5 to keep the penalty bounded.
  const contradictionCount = entry.contradiction_count ?? 0;
  const contradictionPenalty = clamp01(0.05 * Math.min(contradictionCount, 5));
  const confidenceFactor = clamp01(entry.confidence ?? 0);

  const baseWeight =
    (isAdvisory ? 0 : weights.scope_match) +
    weights.domain_match +
    weights.retention +
    weights.freshness;
  const pathPlasticityWeight =
    additiveWeights.PATH_PLASTICITY_WEIGHT * (1 - supplementaryData.graphAndPathColdScore);
  const fusionWeights = resolveFusionScoringWeights(policy);
  const queryEvidenceTransfer = computeQueryEvidenceBaseTransfer(
    baseWeight,
    relevanceFactor,
    fusionWeights
  );
  const queryEvidenceCalibrationStrength = Math.max(
    relevanceFactor,
    graphSupportFactor,
    embeddingSimilarityFactor
  );
  // invariant: calibration only fires when query-grounded evidence is
  // BELOW WEAK_EVIDENCE_CALIBRATION_GATE. At-or-above the gate evidence
  // is treated as sufficient and the score shape is preserved. A prior-side
  // signal (plasticity / confidence) must also be present; without one
  // there is no prior term to dampen.
  const shouldCalibrateWeakEvidence =
    queryEvidenceCalibrationStrength < WEAK_EVIDENCE_CALIBRATION_GATE &&
    (plasticityFactor > 0 || (confidenceFactor > 0 && queryEvidenceCalibrationStrength > 0));
  const evidenceContributionCalibration = shouldCalibrateWeakEvidence
    ? queryEvidenceCalibrationStrength
    : 1;
  const priorEvidenceCalibration =
    shouldCalibrateWeakEvidence
      ? WEAK_EVIDENCE_PRIOR_DAMPENING_FLOOR +
        (1 - WEAK_EVIDENCE_PRIOR_DAMPENING_FLOOR) * queryEvidenceCalibrationStrength
      : 1;
  const calibratedRelevanceFactor = relevanceFactor * evidenceContributionCalibration;
  const effectiveRelevanceWeight =
    (weights.relevance +
      additiveWeights.NO_EMBEDDING_RELEVANCE_DIRECT_WEIGHT +
      queryEvidenceTransfer) *
    evidenceContributionCalibration;
  const adjustedBaseWeight = Math.max(0, baseWeight - queryEvidenceTransfer) * priorEvidenceCalibration;
  const weightedActivation = activationScore * adjustedBaseWeight;
  const weightedRelevance = calibratedRelevanceFactor * weights.relevance;
  const weightedRelevanceDirect =
    calibratedRelevanceFactor * additiveWeights.NO_EMBEDDING_RELEVANCE_DIRECT_WEIGHT;
  const weightedQueryEvidenceTransfer = calibratedRelevanceFactor * queryEvidenceTransfer;
  const weightedGraphSupport = graphSupportFactor * weights.graph_support;
  // Embedding adds no flat additive term here: its signal enters exactly once
  // through the rank-bounded `embedding_similarity` RRF stream.
  // see also: packages/core/src/recall/fusion-delivery.ts:buildRecallFusionDetails.
  // The `embeddingSimilarityFactor` is retained only as the
  // `embedding_similarity` diagnostic factor below — it no longer double-counts
  // into rawScore.
  const weightedPathPlasticity = plasticityFactor * pathPlasticityWeight;
  const weightedConfidence =
    confidenceFactor * additiveWeights.CONFIDENCE_DIRECT_WEIGHT * priorEvidenceCalibration;
  const weightedBudgetPenalty = budgetPenalty * weights.budget_penalty;
  const weightedConflictPenalty = conflictPenalty * weights.conflict_penalty;

  const rawScore = clamp01(
    weightedActivation +
      weightedRelevance +
      weightedRelevanceDirect +
      weightedQueryEvidenceTransfer +
      weightedGraphSupport +
      weightedPathPlasticity +
      weightedConfidence -
      weightedBudgetPenalty -
      weightedConflictPenalty -
      contradictionPenalty
  );
  const score = clamp01(rawScore * scoreMultiplier);

  return Object.freeze({
    score,
    factors: Object.freeze({
      activation: activationScore,
      relevance: score,
      graph_support: graphSupportFactor,
      ...(embeddingSimilarityFactor > 0 ? { embedding_similarity: embeddingSimilarityFactor } : {}),
      path_plasticity: plasticityFactor,
      budget_penalty: budgetPenalty,
      content_relevance: relevanceFactor,
      base_weight: baseWeight,
      weighted_activation: weightedActivation,
      weighted_relevance: weightedRelevance,
      weighted_relevance_direct: weightedRelevanceDirect,
      weighted_query_evidence_transfer: weightedQueryEvidenceTransfer,
      weighted_graph_support: weightedGraphSupport,
      weighted_path_plasticity: weightedPathPlasticity,
      weighted_confidence: weightedConfidence,
      weighted_budget_penalty: weightedBudgetPenalty,
      weighted_conflict_penalty: weightedConflictPenalty,
      weighted_contradiction_penalty: contradictionPenalty,
      query_evidence_transfer: queryEvidenceTransfer,
      adjusted_base_weight: adjustedBaseWeight,
      effective_relevance_weight: effectiveRelevanceWeight,
      conflict_penalty: conflictPenalty,
      contradiction_penalty: contradictionPenalty,
      confidence: confidenceFactor,
      graph_path_cold_score: supplementaryData.graphAndPathColdScore,
      recalls_edge_count: supplementaryData.recallsEdgeCount,
      weight_transfer_amount: supplementaryData.weightTransferAmount,
      resolved_activation_weights: weights
    })
  });
}

export function resolveEffectiveActivationWeights(
  entry: Readonly<MemoryEntry>,
  policy: Readonly<RecallPolicy>,
  warn: RecallServiceWarnPort
): ActivationWeights {
  const overrides = policy.domain_weight_overrides;
  if (overrides === undefined) {
    return resolveActivationWeights();
  }

  const matchedDomainTag = entry.domain_tags
    .filter((tag) => overrides[tag] !== undefined)
    .sort((left, right) => left.localeCompare(right))[0];

  if (matchedDomainTag === undefined) {
    return resolveActivationWeights();
  }

  const resolved = resolveActivationWeights(overrides[matchedDomainTag]);
  try {
    assertActivationWeightsSumToOne(resolved);
    return resolved;
  } catch (error) {
    warn("ERROR: recall domain weight override invalid; falling back to base activation weights", {
      policy_id: policy.runtime_id,
      domain_tag: matchedDomainTag,
      error: toErrorMessage(error)
    });
    return resolveActivationWeights();
  }
}

const RECALL_ADMISSION_ATTRIBUTION_ORDER: readonly RecallAdmissionPlane[] = [
  "lexical",
  "source_proximity",
  "path_expansion",
  "graph_expansion",
  "evidence_anchor",
  "object_probe",
  "protected_winner",
  "domain_tag_cluster",
  "session_surface_cohort",
  // semantic_supplement is the embedding coarse-injection plane; attribute
  // it only when no anchored plane co-admitted the candidate.
  "semantic_supplement",
  "activation"
];

export function selectRecallAdmissionAttributionPlane(
  admissionPlanes: readonly RecallAdmissionPlane[],
  fallback: RecallAdmissionPlane | undefined
): RecallAdmissionPlane {
  for (const plane of RECALL_ADMISSION_ATTRIBUTION_ORDER) {
    if (admissionPlanes.includes(plane)) {
      return plane;
    }
  }
  return fallback ?? admissionPlanes[0] ?? "activation";
}

function resolveDynamicActivationWeights(
  weights: ActivationWeights,
  graphAndPathColdScore: number,
  pathPlasticityWeight: number
): ActivationWeights {
  const coldScore = clamp01(graphAndPathColdScore);
  if (coldScore === 0) {
    return weights;
  }

  return Object.freeze({
    ...weights,
    relevance: weights.relevance + (weights.graph_support + pathPlasticityWeight) * coldScore,
    graph_support: weights.graph_support * (1 - coldScore)
  });
}

type ResolvedAdditiveScoringWeights = Required<RecallAdditiveScoringWeights>;
type ResolvedFusionScoringWeights = Readonly<{
  readonly QUERY_EVIDENCE_BASE_TRANSFER_MAX: number;
  readonly QUERY_EVIDENCE_BASE_WEIGHT_FLOOR: number;
}>;

function resolveAdditiveScoringWeights(
  policy: Readonly<RecallPolicy>
): Readonly<ResolvedAdditiveScoringWeights> {
  const overrides = policy.scoring_weight_overrides?.additive;
  return Object.freeze({
    NO_EMBEDDING_RELEVANCE_DIRECT_WEIGHT:
      overrides?.NO_EMBEDDING_RELEVANCE_DIRECT_WEIGHT ?? NO_EMBEDDING_RELEVANCE_DIRECT_WEIGHT,
    CONFIDENCE_DIRECT_WEIGHT:
      overrides?.CONFIDENCE_DIRECT_WEIGHT ?? CONFIDENCE_DIRECT_WEIGHT,
    PATH_PLASTICITY_WEIGHT:
      overrides?.PATH_PLASTICITY_WEIGHT ?? PATH_PLASTICITY_WEIGHT
  });
}

function resolveFusionScoringWeights(
  policy: Readonly<RecallPolicy>
): ResolvedFusionScoringWeights {
  const overrides = policy.scoring_weight_overrides?.fusion_weights;
  return Object.freeze({
    QUERY_EVIDENCE_BASE_TRANSFER_MAX: clamp01(
      overrides?.QUERY_EVIDENCE_BASE_TRANSFER_MAX ?? QUERY_EVIDENCE_BASE_TRANSFER_MAX
    ),
    QUERY_EVIDENCE_BASE_WEIGHT_FLOOR: clamp01(
      overrides?.QUERY_EVIDENCE_BASE_WEIGHT_FLOOR ?? QUERY_EVIDENCE_BASE_WEIGHT_FLOOR
    )
  });
}

function computeQueryEvidenceBaseTransfer(
  baseWeight: number,
  relevanceFactor: number,
  fusionWeights: ResolvedFusionScoringWeights
): number {
  const transferableBase = Math.max(
    0,
    baseWeight - fusionWeights.QUERY_EVIDENCE_BASE_WEIGHT_FLOOR
  );
  const maxTransfer = Math.min(
    fusionWeights.QUERY_EVIDENCE_BASE_TRANSFER_MAX,
    transferableBase
  );
  return clamp01(relevanceFactor) * maxTransfer;
}
