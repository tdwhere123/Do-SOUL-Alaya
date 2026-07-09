import type { RecallScoreFactors } from "@do-soul/alaya-protocol";
import { recallEnvFlagEnabled, readRecallPositiveInt } from "../../config/recall-env-access.js";
import { buildRecallCandidateDedupeKey } from "../runtime/recall-service-helpers.js";
import type {
  CoarseRecallCandidate,
  RecallFusionBreakdown,
  RecallFusionStream,
  RecallSupplementaryData
} from "../runtime/recall-service-types.js";
import {
  applyFeatureRerank,
  compareFusedRecallCandidates,
  prioritizeStrongLexicalDeliveryWindowCandidates,
  reserveStructuralDeliverySlots
} from "./fusion-delivery.js";
import { applyEvidenceSetDelivery } from "./evidence-set-optimizer.js";
import { composeEntityDeliveryHints, composeRecallEnabled } from "../scoring/activation-assembly.js";

export type DeliverySelectionCandidate = Readonly<CoarseRecallCandidate & {
  readonly effectiveScore: number;
  readonly effectiveFactors: RecallScoreFactors;
  readonly fusion: RecallFusionBreakdown;
}>;

export interface DeliverySelectionOrdering {
  readonly rankedCandidates: readonly DeliverySelectionCandidate[];
  readonly featureRerankedCandidates: readonly DeliverySelectionCandidate[];
  readonly prioritizedCandidates: readonly DeliverySelectionCandidate[];
  readonly coverageSelectedCandidates: readonly DeliverySelectionCandidate[];
  /** Identity alias of coverageSelectedCandidates (session_coverage stage is noop). */
  readonly coverageOrderedCandidates: readonly DeliverySelectionCandidate[];
  /** Post likelihood-tail-rescue order; wire name remains synthesis_reserve for compat. */
  readonly synthesisReservedCandidates: readonly DeliverySelectionCandidate[];
  readonly deliveryOrderedCandidates: readonly DeliverySelectionCandidate[];
}

export interface DeliverySelectionRankDiagnostics {
  readonly rankAfterFusion: ReadonlyMap<string, number>;
  readonly rankAfterFeatureRerank: ReadonlyMap<string, number>;
  readonly rankAfterLexicalPriority: ReadonlyMap<string, number>;
  readonly rankAfterCoverageSelector: ReadonlyMap<string, number>;
  readonly rankAfterSessionCoverage: ReadonlyMap<string, number>;
  readonly rankAfterSynthesisReserve: ReadonlyMap<string, number>;
  readonly rankAfterStructuralReserve: ReadonlyMap<string, number>;
  readonly coverageSelectorNoop: boolean;
  readonly sessionCoverageNoop: boolean;
}

export function applyDeliverySelection(
  scoredCandidates: readonly DeliverySelectionCandidate[],
  supplementaryData: RecallSupplementaryData,
  maxEntries: number
): Readonly<{
  readonly ordering: DeliverySelectionOrdering;
  readonly ranks: DeliverySelectionRankDiagnostics;
}> {
  const ordering = orderDeliverySelectionCandidates(scoredCandidates, supplementaryData, maxEntries);
  return Object.freeze({
    ordering,
    ranks: buildDeliveryRankDiagnostics(ordering)
  });
}

function orderDeliverySelectionCandidates(
  scoredCandidates: readonly DeliverySelectionCandidate[],
  supplementaryData: RecallSupplementaryData,
  maxEntries: number
): DeliverySelectionOrdering {
  const rankedCandidates = [...scoredCandidates].sort(compareFusedRecallCandidates);
  if (deliverFusedOrderEnabled()) {
    return buildSingleStageDeliveryOrdering(rankedCandidates, rankedCandidates);
  }
  return buildPostFusionDeliveryOrdering(rankedCandidates, supplementaryData, maxEntries);
}

function deliverFusedOrderEnabled(): boolean {
  return recallEnvFlagEnabled("ALAYA_RECALL_DELIVER_FUSED_ORDER");
}

function resolveDeliveryReorderWindow(maxEntries: number): number {
  return readRecallPositiveInt("ALAYA_RECALL_DELIVERY_WINDOW", maxEntries) > maxEntries
    ? readRecallPositiveInt("ALAYA_RECALL_DELIVERY_WINDOW", maxEntries)
    : maxEntries;
}

function buildSingleStageDeliveryOrdering(
  rankedCandidates: readonly DeliverySelectionCandidate[],
  deliveryOrderedCandidates: readonly DeliverySelectionCandidate[]
): DeliverySelectionOrdering {
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

function buildPostFusionDeliveryOrdering(
  rankedCandidates: readonly DeliverySelectionCandidate[],
  supplementaryData: RecallSupplementaryData,
  maxEntries: number
): DeliverySelectionOrdering {
  const window = resolveDeliveryReorderWindow(maxEntries);
  const entityHintedCandidates = composeRecallEnabled()
    ? applyComposeDeliveryHints(rankedCandidates, supplementaryData, window)
    : rankedCandidates;
  const featureRerankedCandidates = applyFeatureRerank(
    entityHintedCandidates,
    supplementaryData,
    maxEntries
  );
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
  // session_coverage is intentionally identity: keep diagnostic slots
  // (rank_after_session_coverage / session_coverage_action) for warm-readiness
  // without a second reorder pass.
  const likelihoodRescuedCandidates = applyLikelihoodTailRescue(
    coverageSelectedCandidates,
    maxEntries
  );
  const deliveryOrderedCandidates = reserveStructuralDeliverySlots(
    likelihoodRescuedCandidates,
    supplementaryData,
    window,
    0
  );
  return Object.freeze({
    rankedCandidates,
    featureRerankedCandidates,
    prioritizedCandidates,
    coverageSelectedCandidates,
    // Compat aliases: wire/diagnostics still say session_coverage / synthesis_reserve.
    coverageOrderedCandidates: coverageSelectedCandidates,
    synthesisReservedCandidates: likelihoodRescuedCandidates,
    deliveryOrderedCandidates
  });
}

const COMPOSE_HINT_MIN_SCORE_RATIO = 0.75;
const LIKELIHOOD_HEAD_RESCUE_SIZE = 5;
const LIKELIHOOD_TAIL_RESCUE_MULTIPLIER = 2;

function fusionRankFloorEnabled(): boolean {
  return recallEnvFlagEnabled("ALAYA_RECALL_FUSION_RANK_FLOOR");
}

// invariant: when fusion-rank floor is on, fused_rank ≤ headSize incumbents
// must not be hard-evicted by likelihood tail-rescue. Default off.
function isFusionRankFloorProtected(
  candidate: DeliverySelectionCandidate,
  headSize: number
): boolean {
  const rank = candidate.fusion.fused_rank;
  return typeof rank === "number" && rank > 0 && rank <= headSize;
}

function applyLikelihoodTailRescue(
  orderedCandidates: readonly DeliverySelectionCandidate[],
  maxEntries: number
): readonly DeliverySelectionCandidate[] {
  const packetSize = Math.min(
    Math.max(0, maxEntries),
    orderedCandidates.length,
    LIKELIHOOD_HEAD_RESCUE_SIZE * LIKELIHOOD_TAIL_RESCUE_MULTIPLIER
  );
  const headSize = Math.min(LIKELIHOOD_HEAD_RESCUE_SIZE, packetSize);
  if (headSize <= 0 || packetSize <= headSize) {
    return orderedCandidates;
  }

  const incumbentIndex = headSize - 1;
  const incumbent = orderedCandidates[incumbentIndex];
  if (incumbent === undefined || !isWeakLikelihoodIncumbent(incumbent)) {
    return orderedCandidates;
  }
  if (fusionRankFloorEnabled() && isFusionRankFloorProtected(incumbent, headSize)) {
    return orderedCandidates;
  }

  const challengerOffset = orderedCandidates
    .slice(headSize, packetSize)
    .findIndex(isLikelihoodTailRescueCandidate);
  if (challengerOffset < 0) {
    return orderedCandidates;
  }

  const challengerIndex = headSize + challengerOffset;
  const rescued = [...orderedCandidates];
  rescued[incumbentIndex] = orderedCandidates[challengerIndex] ?? incumbent;
  rescued[challengerIndex] = incumbent;
  return Object.freeze(rescued);
}

function isLikelihoodTailRescueCandidate(candidate: DeliverySelectionCandidate): boolean {
  return (
    (streamRankAtMost(candidate, "lexical_fts", 3) &&
      streamRankAtMost(candidate, "embedding_similarity", 3)) ||
    (streamRankAtMost(candidate, "lexical_fts", 2) &&
      streamRankAtMost(candidate, "evidence_fts", 5)) ||
    (streamRankAtMost(candidate, "embedding_similarity", 2) &&
      streamRankAtMost(candidate, "evidence_fts", 5))
  );
}

function isWeakLikelihoodIncumbent(candidate: DeliverySelectionCandidate): boolean {
  return !(
    streamRankAtMost(candidate, "lexical_fts", 3) ||
    streamRankAtMost(candidate, "embedding_similarity", 3) ||
    streamRankAtMost(candidate, "evidence_fts", 3)
  );
}

function streamRankAtMost(
  candidate: DeliverySelectionCandidate,
  stream: RecallFusionStream,
  threshold: number
): boolean {
  const rank = candidate.fusion.per_stream_rank[stream];
  return typeof rank === "number" && rank <= threshold;
}

function applyComposeDeliveryHints(
  rankedCandidates: readonly DeliverySelectionCandidate[],
  supplementaryData: RecallSupplementaryData,
  window: number
): readonly DeliverySelectionCandidate[] {
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
  rankedWindow: readonly DeliverySelectionCandidate[],
  composedWindow: readonly DeliverySelectionCandidate[]
): readonly DeliverySelectionCandidate[] {
  const used = new Set<string>();
  const ordered: DeliverySelectionCandidate[] = [];
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
  composedWindow: readonly DeliverySelectionCandidate[],
  used: ReadonlySet<string>,
  naturalCandidate: DeliverySelectionCandidate
): DeliverySelectionCandidate | undefined {
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
  rankedWindow: readonly DeliverySelectionCandidate[],
  used: ReadonlySet<string>
): DeliverySelectionCandidate | undefined {
  return rankedWindow.find((candidate) => !used.has(buildRecallCandidateDedupeKey(candidate)));
}

function isComposeHintEligible(
  candidate: DeliverySelectionCandidate,
  naturalCandidate: DeliverySelectionCandidate
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

export function buildDeliveryRankDiagnostics(
  ordering: DeliverySelectionOrdering
): DeliverySelectionRankDiagnostics {
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
