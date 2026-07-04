import type {
  RecallCandidate,
  RecallPolicy,
  RecallScoreFactors
} from "@do-soul/alaya-protocol";
import { recallEnvFlagEnabled, readRecallPositiveInt } from "../config/recall-env-access.js";
import { buildRecallCandidateDedupeKey } from "./recall-service-helpers.js";
import type {
  CoarseRecallCandidate,
  RecallCandidateDiagnostic,
  RecallServiceWarnPort,
  RecallSupplementaryData,
  TokenEstimator
} from "./recall-service-types.js";
import {
  applyFeatureRerank,
  applyPathSuppressionToFusionScores,
  buildEmptyRecallFusionBreakdown,
  buildRecallFusionDetails,
  compareFusedRecallCandidates,
  prioritizeStrongLexicalDeliveryWindowCandidates,
  reserveStructuralDeliverySlots
} from "./fusion-delivery.js";
import { applyEvidenceSetDelivery } from "./evidence-set-optimizer.js";
import { composeEntityDeliveryHints, composeRecallEnabled } from "./activation-assembly.js";
import { computeEffectiveScoreDetails } from "./scoring.js";
import {
  selectFineAssessmentCandidates,
  type FineAssessmentCandidate,
  type FineAssessmentRankDiagnostics
} from "./fine-assessment-selection.js";

export interface FineAssessParams {
  readonly candidates: readonly Readonly<CoarseRecallCandidate>[];
  readonly policy: Readonly<RecallPolicy>;
  readonly winnerMemoryIds: ReadonlySet<string>;
  readonly supplementaryData: RecallSupplementaryData;
  readonly tokenEstimator: TokenEstimator;
  readonly now: () => string;
  readonly warn: RecallServiceWarnPort;
}

export function fineAssess(params: FineAssessParams): Readonly<{
  readonly candidates: readonly Readonly<RecallCandidate>[];
  readonly diagnostics: readonly Readonly<RecallCandidateDiagnostic>[];
}> {
  if (params.candidates.length === 0) {
    return Object.freeze({
      candidates: Object.freeze([]),
      diagnostics: Object.freeze([])
    });
  }
  const config = params.policy.fine_assessment;
  const scoredCandidates = scoreFineAssessmentCandidates(params);
  const ordering = orderFineAssessmentCandidates(
    scoredCandidates,
    params.policy,
    params.supplementaryData,
    params.now(),
    config.budgets.max_entries
  );
  return selectFineAssessmentCandidates({
    deliveryOrderedCandidates: ordering.deliveryOrderedCandidates,
    config,
    supplementaryData: params.supplementaryData,
    tokenEstimator: params.tokenEstimator,
    ranks: buildFineAssessmentRankDiagnostics(ordering)
  });
}

type AdditiveScoredCandidate = Readonly<CoarseRecallCandidate & {
  readonly effectiveScore: number;
  readonly effectiveFactors: RecallScoreFactors;
}>;

interface FineAssessmentOrdering {
  readonly rankedCandidates: readonly FineAssessmentCandidate[];
  readonly featureRerankedCandidates: readonly FineAssessmentCandidate[];
  readonly prioritizedCandidates: readonly FineAssessmentCandidate[];
  readonly coverageSelectedCandidates: readonly FineAssessmentCandidate[];
  readonly coverageOrderedCandidates: readonly FineAssessmentCandidate[];
  readonly synthesisReservedCandidates: readonly FineAssessmentCandidate[];
  readonly deliveryOrderedCandidates: readonly FineAssessmentCandidate[];
}

function scoreFineAssessmentCandidates(params: FineAssessParams): readonly AdditiveScoredCandidate[] {
  return params.candidates.map((candidate) => {
    const scored = computeEffectiveScoreDetails({
      entry: candidate.entry,
      policy: params.policy,
      winnerMemoryIds: params.winnerMemoryIds,
      supplementaryData: params.supplementaryData,
      originPlane: candidate.originPlane ?? "workspace_local",
      isAdvisory: candidate.isAdvisory ?? false,
      scoreMultiplier: candidate.scoreMultiplier ?? 1,
      objectKind: candidate.objectKind ?? "memory_entry",
      now: params.now,
      warn: params.warn
    });
    return Object.freeze({ ...candidate, effectiveScore: scored.score, effectiveFactors: scored.factors });
  });
}

function orderFineAssessmentCandidates(
  additiveScoredCandidates: readonly AdditiveScoredCandidate[],
  policy: Readonly<RecallPolicy>,
  supplementaryData: RecallSupplementaryData,
  nowIso: string,
  maxEntries: number
): FineAssessmentOrdering {
  // The conformant fused_score (activation·(1+β·R_E)) stays small-magnitude, so the absolute ≤0.27 path-suppression deltas stay meaningful.
  const fusionByCandidateKey = applyPathSuppressionToFusionScores(
    buildRecallFusionDetails({ candidates: additiveScoredCandidates, policy, supplementaryData, nowIso }),
    supplementaryData.pathSuppressionScores
  );
  return orderFusedFineAssessmentCandidates(
    additiveScoredCandidates.map((candidate) => Object.freeze({
      ...candidate,
      fusion: fusionByCandidateKey.get(buildRecallCandidateDedupeKey(candidate)) ?? buildEmptyRecallFusionBreakdown(candidate.entry.object_id)
    })),
    supplementaryData,
    maxEntries
  );
}

// Diagnostic (ALAYA_RECALL_DELIVER_FUSED_ORDER): deliver in pure fused-score order,
// skipping the post-fusion re-rank chain — to measure how much that chain reshapes delivery.
function deliverFusedOrderEnabled(): boolean {
  return recallEnvFlagEnabled("ALAYA_RECALL_DELIVER_FUSED_ORDER");
}

// Opt-in (ALAYA_RECALL_DELIVERY_WINDOW): widen the reorder window past the delivery cap; unset/≤maxEntries → byte-identical.
function resolveDeliveryReorderWindow(maxEntries: number): number {
  return readRecallPositiveInt("ALAYA_RECALL_DELIVERY_WINDOW", maxEntries) > maxEntries
    ? readRecallPositiveInt("ALAYA_RECALL_DELIVERY_WINDOW", maxEntries)
    : maxEntries;
}

function orderFusedFineAssessmentCandidates(
  scoredCandidates: readonly FineAssessmentCandidate[],
  supplementaryData: RecallSupplementaryData,
  maxEntries: number
): FineAssessmentOrdering {
  const rankedCandidates = [...scoredCandidates].sort(compareFusedRecallCandidates);
  if (deliverFusedOrderEnabled()) {
    return buildSingleStageFineAssessmentOrdering(rankedCandidates, rankedCandidates);
  }
  return buildPostFusionFineAssessmentOrdering(rankedCandidates, supplementaryData, maxEntries);
}

function buildSingleStageFineAssessmentOrdering(
  rankedCandidates: readonly FineAssessmentCandidate[],
  deliveryOrderedCandidates: readonly FineAssessmentCandidate[]
): FineAssessmentOrdering {
  return Object.freeze({
    rankedCandidates,
    featureRerankedCandidates: deliveryOrderedCandidates,
    prioritizedCandidates: deliveryOrderedCandidates,
    coverageSelectedCandidates: deliveryOrderedCandidates,
    coverageOrderedCandidates: deliveryOrderedCandidates,
    synthesisReservedCandidates: deliveryOrderedCandidates,
    deliveryOrderedCandidates
  });
}

function buildPostFusionFineAssessmentOrdering(
  rankedCandidates: readonly FineAssessmentCandidate[],
  supplementaryData: RecallSupplementaryData,
  maxEntries: number
): FineAssessmentOrdering {
  const window = resolveDeliveryReorderWindow(maxEntries);
  const entityHintedCandidates = composeRecallEnabled()
    ? applyComposeDeliveryHints(rankedCandidates, supplementaryData, window)
    : rankedCandidates;
  const featureRerankedCandidates = applyFeatureRerank(entityHintedCandidates, supplementaryData);
  const prioritizedCandidates = prioritizeStrongLexicalDeliveryWindowCandidates(
    featureRerankedCandidates,
    supplementaryData,
    window
  );
  const coverageSelectedCandidates = applyEvidenceSetDelivery(
    prioritizedCandidates,
    supplementaryData,
    window
  );
  const coverageOrderedCandidates = coverageSelectedCandidates;
  const synthesisReservedCandidates = coverageOrderedCandidates;
  const deliveryOrderedCandidates = reserveStructuralDeliverySlots(
    synthesisReservedCandidates,
    supplementaryData,
    window,
    0
  );
  return Object.freeze({
    rankedCandidates,
    featureRerankedCandidates,
    prioritizedCandidates,
    coverageSelectedCandidates,
    coverageOrderedCandidates,
    synthesisReservedCandidates,
    deliveryOrderedCandidates
  });
}

const COMPOSE_HINT_MIN_SCORE_RATIO = 0.75;

function applyComposeDeliveryHints(
  rankedCandidates: readonly FineAssessmentCandidate[],
  supplementaryData: RecallSupplementaryData,
  window: number
): readonly FineAssessmentCandidate[] {
  const windowSize = Math.min(Math.max(0, window), rankedCandidates.length);
  if (windowSize <= 1) {
    return rankedCandidates;
  }
  const rankedWindow = rankedCandidates.slice(0, windowSize);
  const composedWindow = composeEntityDeliveryHints(rankedWindow, supplementaryData, windowSize);
  return Object.freeze([
    ...relevanceGateComposeWindow(rankedWindow, composedWindow),
    ...rankedCandidates.slice(windowSize)
  ]);
}

function relevanceGateComposeWindow(
  rankedWindow: readonly FineAssessmentCandidate[],
  composedWindow: readonly FineAssessmentCandidate[]
): readonly FineAssessmentCandidate[] {
  const used = new Set<string>();
  const ordered: FineAssessmentCandidate[] = [];
  for (const naturalCandidate of rankedWindow) {
    const hintedCandidate = selectEligibleComposeHint(composedWindow, used, naturalCandidate);
    const nextCandidate = hintedCandidate ?? firstUnusedCandidate(rankedWindow, used);
    if (nextCandidate === undefined) {
      break;
    }
    used.add(buildRecallCandidateDedupeKey(nextCandidate));
    ordered.push(nextCandidate);
  }
  return Object.freeze(ordered);
}

function selectEligibleComposeHint(
  composedWindow: readonly FineAssessmentCandidate[],
  used: ReadonlySet<string>,
  naturalCandidate: FineAssessmentCandidate
): FineAssessmentCandidate | undefined {
  for (const candidate of composedWindow) {
    if (used.has(buildRecallCandidateDedupeKey(candidate))) {
      continue;
    }
    if (isComposeHintEligible(candidate, naturalCandidate)) {
      return candidate;
    }
  }
  return undefined;
}

function firstUnusedCandidate(
  rankedWindow: readonly FineAssessmentCandidate[],
  used: ReadonlySet<string>
): FineAssessmentCandidate | undefined {
  return rankedWindow.find((candidate) => !used.has(buildRecallCandidateDedupeKey(candidate)));
}

function isComposeHintEligible(
  candidate: FineAssessmentCandidate,
  naturalCandidate: FineAssessmentCandidate
): boolean {
  if (candidate === naturalCandidate) {
    return true;
  }
  return (
    passesComposeHintScoreRatio(candidate.fusion.fused_score, naturalCandidate.fusion.fused_score) &&
    passesComposeHintScoreRatio(candidate.effectiveScore, naturalCandidate.effectiveScore)
  );
}

function passesComposeHintScoreRatio(candidateScore: number, naturalScore: number): boolean {
  if (naturalScore <= 0) {
    return candidateScore > 0;
  }
  return candidateScore / naturalScore >= COMPOSE_HINT_MIN_SCORE_RATIO;
}

function buildFineAssessmentRankDiagnostics(
  ordering: FineAssessmentOrdering
): FineAssessmentRankDiagnostics {
  return Object.freeze({
    rankAfterFusion: buildStageRankMap(ordering.rankedCandidates),
    rankAfterFeatureRerank: buildStageRankMap(ordering.featureRerankedCandidates),
    rankAfterLexicalPriority: buildStageRankMap(ordering.prioritizedCandidates),
    rankAfterCoverageSelector: buildStageRankMap(ordering.coverageSelectedCandidates),
    rankAfterSessionCoverage: buildStageRankMap(ordering.coverageOrderedCandidates),
    rankAfterSynthesisReserve: buildStageRankMap(ordering.synthesisReservedCandidates),
    rankAfterStructuralReserve: buildStageRankMap(ordering.deliveryOrderedCandidates),
    coverageSelectorNoop: ordering.coverageSelectedCandidates === ordering.prioritizedCandidates,
    sessionCoverageNoop: ordering.coverageOrderedCandidates === ordering.coverageSelectedCandidates
  });
}

function buildStageRankMap(
  ordered: readonly Readonly<CoarseRecallCandidate>[]
): ReadonlyMap<string, number> {
  const ranks = new Map<string, number>();
  ordered.forEach((item, index) => {
    ranks.set(buildRecallCandidateDedupeKey(item), index + 1);
  });
  return ranks;
}
