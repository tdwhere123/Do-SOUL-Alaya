import type { RecallScoreFactors } from "@do-soul/alaya-protocol";
import { recallEnvFlagEnabled, readRecallPositiveInt } from "../../config/recall-env-access.js";
import { buildRecallCandidateDedupeKey } from "../runtime/recall-service-helpers.js";
import type {
  CoarseRecallCandidate,
  RecallFusionBreakdown,
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
  readonly coverageOrderedCandidates: readonly DeliverySelectionCandidate[];
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
