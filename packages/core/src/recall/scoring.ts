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
  errorNameOf,
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
  const context = resolveEffectiveScoreContext(params);
  const signals = collectEffectiveScoreSignals(context);
  const calibration = computeScoreCalibration(context, signals);
  const weighted = computeWeightedScoreParts(context, signals, calibration);
  return buildEffectiveScoreResult(context, signals, calibration, weighted);
}

type EffectiveScoreParams = Parameters<typeof computeEffectiveScoreDetails>[0];
type EffectiveScoreContext = Readonly<EffectiveScoreParams & {
  readonly scoreMultiplier: number;
  readonly objectKind: RecallCandidate["object_kind"];
  readonly additiveWeights: Readonly<ResolvedAdditiveScoringWeights>;
  readonly weights: ActivationWeights;
  readonly canUseMemorySupplement: boolean;
}>;

interface EffectiveScoreSignals {
  readonly activationScore: number;
  readonly relevanceFactor: number;
  readonly graphSupportFactor: number;
  readonly embeddingSimilarityFactor: number;
  readonly budgetPenalty: number;
  readonly plasticityFactor: number;
  readonly conflictPenalty: number;
  readonly contradictionPenalty: number;
  readonly confidenceFactor: number;
  readonly baseWeight: number;
  readonly pathPlasticityWeight: number;
}

interface ScoreCalibration {
  readonly queryEvidenceTransfer: number;
  readonly evidenceContributionCalibration: number;
  readonly priorEvidenceCalibration: number;
  readonly calibratedRelevanceFactor: number;
  readonly effectiveRelevanceWeight: number;
  readonly adjustedBaseWeight: number;
}

interface WeightedScoreParts {
  readonly weightedActivation: number;
  readonly weightedRelevance: number;
  readonly weightedRelevanceDirect: number;
  readonly weightedQueryEvidenceTransfer: number;
  readonly weightedGraphSupport: number;
  readonly weightedPathPlasticity: number;
  readonly weightedConfidence: number;
  readonly weightedBudgetPenalty: number;
  readonly weightedConflictPenalty: number;
  readonly score: number;
}

function resolveEffectiveScoreContext(params: EffectiveScoreParams): EffectiveScoreContext {
  const additiveWeights = resolveAdditiveScoringWeights(params.policy);
  const objectKind = params.objectKind ?? "memory_entry";
  const isGlobalCandidate = params.originPlane === "global";
  const isSynthesisCandidate = objectKind === "synthesis_capsule";
  return Object.freeze({
    ...params,
    scoreMultiplier: params.scoreMultiplier ?? 1,
    objectKind,
    additiveWeights,
    weights: resolveDynamicActivationWeights(
      resolveEffectiveActivationWeights(params.entry, params.policy, params.warn),
      params.supplementaryData.graphAndPathColdScore,
      additiveWeights.PATH_PLASTICITY_WEIGHT
    ),
    canUseMemorySupplement: !isGlobalCandidate && !isSynthesisCandidate
  });
}

function collectEffectiveScoreSignals(context: EffectiveScoreContext): EffectiveScoreSignals {
  const evidence = collectQueryEvidenceSignals(context);
  const penalties = collectPenaltySignals(context);
  const baseWeight = (context.isAdvisory ? 0 : context.weights.scope_match) + context.weights.domain_match + context.weights.retention + context.weights.freshness;
  return Object.freeze({
    activationScore: computeRecallActivationScore(context),
    ...evidence,
    budgetPenalty: context.supplementaryData.budgetPenaltyFactor,
    ...penalties,
    confidenceFactor: clamp01(context.entry.confidence ?? 0),
    baseWeight,
    pathPlasticityWeight: context.additiveWeights.PATH_PLASTICITY_WEIGHT * (1 - context.supplementaryData.graphAndPathColdScore)
  });
}

function computeRecallActivationScore(context: EffectiveScoreContext): number {
  const storedActivationScore = normalizeActivationScore(context.entry.activation_score);
  const shouldTimeDecay = context.canUseMemorySupplement && typeof context.entry.created_at === "string" && context.entry.created_at.length > 0;
  if (!shouldTimeDecay) {
    return storedActivationScore;
  }
  const freshnessWeight = DYNAMICS_CONSTANTS.activation_weights_phase1b.freshness;
  const nonFreshnessFloor = Math.max(0, storedActivationScore - freshnessWeight);
  const freshnessFactorNow = computeFreshnessFactor({
    lastUsedAt: context.entry.last_used_at ?? null,
    createdAt: context.entry.created_at,
    now: context.now()
  });
  return Math.min(storedActivationScore, clamp01(nonFreshnessFloor + freshnessWeight * freshnessFactorNow));
}

function collectQueryEvidenceSignals(context: EffectiveScoreContext): Readonly<Pick<EffectiveScoreSignals, "relevanceFactor" | "graphSupportFactor" | "embeddingSimilarityFactor" | "plasticityFactor">> {
  const ftsFactor = context.canUseMemorySupplement ? context.supplementaryData.ftsRanks[context.entry.object_id] ?? 0 : 0;
  const synthesisFtsFactor = context.objectKind === "synthesis_capsule" && context.originPlane !== "global" ? context.supplementaryData.synthesisFtsRanks[context.entry.object_id] ?? 0 : 0;
  const structuralFactor = context.canUseMemorySupplement ? context.supplementaryData.structuralScores[context.entry.object_id] ?? 0 : 0;
  const queryFtsFactor = Math.max(ftsFactor, synthesisFtsFactor);
  return Object.freeze({
    relevanceFactor: queryFtsFactor > 0 && structuralFactor > 0 ? clamp01(queryFtsFactor * 0.24 + structuralFactor * 0.76) : Math.max(queryFtsFactor * 0.62, structuralFactor),
    graphSupportFactor: context.canUseMemorySupplement ? normalizeGraphSupport(context.supplementaryData.graphSupportCounts[context.entry.object_id] ?? 0) : 0,
    embeddingSimilarityFactor: context.canUseMemorySupplement ? clamp01(context.supplementaryData.embeddingSimilarityScores[context.entry.object_id] ?? 0) : 0,
    plasticityFactor: context.canUseMemorySupplement ? clamp01(context.supplementaryData.plasticityFactors[context.entry.object_id] ?? 0) : 0
  });
}

function collectPenaltySignals(context: EffectiveScoreContext): Readonly<Pick<EffectiveScoreSignals, "conflictPenalty" | "contradictionPenalty">> {
  const conflictPenalty = context.policy.fine_assessment.conflict_awareness && isClaimLikeDimension(context.entry.dimension) && !context.winnerMemoryIds.has(context.entry.object_id) ? 1 : 0;
  const contradictionCount = context.entry.contradiction_count ?? 0;
  return Object.freeze({
    conflictPenalty,
    contradictionPenalty: clamp01(0.05 * Math.min(contradictionCount, 5))
  });
}

function computeScoreCalibration(context: EffectiveScoreContext, signals: EffectiveScoreSignals): ScoreCalibration {
  const queryEvidenceTransfer = computeQueryEvidenceBaseTransfer(signals.baseWeight, signals.relevanceFactor, resolveFusionScoringWeights(context.policy));
  const strength = Math.max(signals.relevanceFactor, signals.graphSupportFactor, signals.embeddingSimilarityFactor);
  const shouldCalibrate = strength < WEAK_EVIDENCE_CALIBRATION_GATE && (signals.plasticityFactor > 0 || (signals.confidenceFactor > 0 && strength > 0));
  const evidenceContributionCalibration = shouldCalibrate ? strength : 1;
  const priorEvidenceCalibration = shouldCalibrate ? WEAK_EVIDENCE_PRIOR_DAMPENING_FLOOR + (1 - WEAK_EVIDENCE_PRIOR_DAMPENING_FLOOR) * strength : 1;
  return Object.freeze({
    queryEvidenceTransfer,
    evidenceContributionCalibration,
    priorEvidenceCalibration,
    calibratedRelevanceFactor: signals.relevanceFactor * evidenceContributionCalibration,
    effectiveRelevanceWeight: (context.weights.relevance + context.additiveWeights.NO_EMBEDDING_RELEVANCE_DIRECT_WEIGHT + queryEvidenceTransfer) * evidenceContributionCalibration,
    adjustedBaseWeight: Math.max(0, signals.baseWeight - queryEvidenceTransfer) * priorEvidenceCalibration
  });
}

function computeWeightedScoreParts(context: EffectiveScoreContext, signals: EffectiveScoreSignals, calibration: ScoreCalibration): WeightedScoreParts {
  const parts = Object.freeze({
    weightedActivation: signals.activationScore * calibration.adjustedBaseWeight,
    weightedRelevance: calibration.calibratedRelevanceFactor * context.weights.relevance,
    weightedRelevanceDirect: calibration.calibratedRelevanceFactor * context.additiveWeights.NO_EMBEDDING_RELEVANCE_DIRECT_WEIGHT,
    weightedQueryEvidenceTransfer: calibration.calibratedRelevanceFactor * calibration.queryEvidenceTransfer,
    weightedGraphSupport: signals.graphSupportFactor * context.weights.graph_support,
    weightedPathPlasticity: signals.plasticityFactor * signals.pathPlasticityWeight,
    weightedConfidence: signals.confidenceFactor * context.additiveWeights.CONFIDENCE_DIRECT_WEIGHT * calibration.priorEvidenceCalibration,
    weightedBudgetPenalty: signals.budgetPenalty * context.weights.budget_penalty,
    weightedConflictPenalty: signals.conflictPenalty * context.weights.conflict_penalty
  });
  const rawScore = clamp01(parts.weightedActivation + parts.weightedRelevance + parts.weightedRelevanceDirect + parts.weightedQueryEvidenceTransfer + parts.weightedGraphSupport + parts.weightedPathPlasticity + parts.weightedConfidence - parts.weightedBudgetPenalty - parts.weightedConflictPenalty - signals.contradictionPenalty);
  return Object.freeze({ ...parts, score: clamp01(rawScore * context.scoreMultiplier) });
}

function buildEffectiveScoreResult(context: EffectiveScoreContext, signals: EffectiveScoreSignals, calibration: ScoreCalibration, weighted: WeightedScoreParts): Readonly<{ readonly score: number; readonly factors: RecallScoreFactors }> {
  return Object.freeze({
    score: weighted.score,
    factors: Object.freeze({
      activation: signals.activationScore,
      relevance: weighted.score,
      graph_support: signals.graphSupportFactor,
      ...(signals.embeddingSimilarityFactor > 0 ? { embedding_similarity: signals.embeddingSimilarityFactor } : {}),
      path_plasticity: signals.plasticityFactor,
      budget_penalty: signals.budgetPenalty,
      content_relevance: signals.relevanceFactor,
      base_weight: signals.baseWeight,
      weighted_activation: weighted.weightedActivation,
      weighted_relevance: weighted.weightedRelevance,
      weighted_relevance_direct: weighted.weightedRelevanceDirect,
      weighted_query_evidence_transfer: weighted.weightedQueryEvidenceTransfer,
      weighted_graph_support: weighted.weightedGraphSupport,
      weighted_path_plasticity: weighted.weightedPathPlasticity,
      weighted_confidence: weighted.weightedConfidence,
      weighted_budget_penalty: weighted.weightedBudgetPenalty,
      weighted_conflict_penalty: weighted.weightedConflictPenalty,
      weighted_contradiction_penalty: signals.contradictionPenalty,
      query_evidence_transfer: calibration.queryEvidenceTransfer,
      adjusted_base_weight: calibration.adjustedBaseWeight,
      effective_relevance_weight: calibration.effectiveRelevanceWeight,
      conflict_penalty: signals.conflictPenalty,
      contradiction_penalty: signals.contradictionPenalty,
      confidence: signals.confidenceFactor,
      graph_path_cold_score: context.supplementaryData.graphAndPathColdScore,
      recalls_edge_count: context.supplementaryData.recallsEdgeCount,
      weight_transfer_amount: context.supplementaryData.weightTransferAmount,
      resolved_activation_weights: context.weights
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
      operation: "recall_domain_weight_override_validation",
      errorName: errorNameOf(error),
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
