import type {
  RecallCandidate,
  RecallPolicy,
  RecallScoreFactors
} from "@do-soul/alaya-protocol";
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
  applySessionCoverageRerank,
  buildEmptyRecallFusionBreakdown,
  buildRecallFusionDetails,
  compareFusedRecallCandidates,
  prioritizeStrongLexicalDeliveryWindowCandidates,
  reserveStructuralDeliverySlots
} from "./fusion-delivery.js";
import { applyEvidenceSetDelivery } from "./evidence-set-optimizer.js";
import { composeAndOrderByEntity, composeRecallEnabled } from "./activation-assembly.js";
import { flatBaselineEnabled } from "./conformant-fusion-scoring.js";
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
  const raw = process.env.ALAYA_RECALL_DELIVER_FUSED_ORDER;
  return raw === "on" || raw === "1" || raw === "true";
}

// Opt-in (ALAYA_RECALL_DELIVERY_WINDOW): widen the reorder window past the delivery cap; unset/≤maxEntries → byte-identical.
function resolveDeliveryReorderWindow(maxEntries: number): number {
  const raw = Number(process.env.ALAYA_RECALL_DELIVERY_WINDOW);
  return Number.isFinite(raw) && raw > maxEntries ? Math.floor(raw) : maxEntries;
}

function orderFusedFineAssessmentCandidates(
  scoredCandidates: readonly FineAssessmentCandidate[],
  supplementaryData: RecallSupplementaryData,
  maxEntries: number
): FineAssessmentOrdering {
  const rankedCandidates = [...scoredCandidates].sort(compareFusedRecallCandidates);
  if (composeRecallEnabled()) {
    // Compose-then-rank (ALAYA_RECALL_COMPOSE): entity-grouped navigator delivery replaces the flat
    // post-fusion chain. Every stage field shares one reference so the diagnostic no-op checks hold.
    const deliveryOrderedCandidates = composeAndOrderByEntity(
      scoredCandidates,
      supplementaryData,
      resolveDeliveryReorderWindow(maxEntries)
    );
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
  if (deliverFusedOrderEnabled()) {
    return Object.freeze({
      rankedCandidates,
      featureRerankedCandidates: rankedCandidates,
      prioritizedCandidates: rankedCandidates,
      coverageSelectedCandidates: rankedCandidates,
      coverageOrderedCandidates: rankedCandidates,
      synthesisReservedCandidates: rankedCandidates,
      deliveryOrderedCandidates: rankedCandidates
    });
  }
  // Reorder window decoupled from the delivery cap: the coverage/priority/reserve passes need a window
  // wide enough to seat complementary golds beside single_fact without trading; delivery is sliced downstream.
  const window = resolveDeliveryReorderWindow(maxEntries);
  const featureRerankedCandidates = applyFeatureRerank(rankedCandidates, supplementaryData);
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
  // S4 evidence-set coverage owns session complementarity by default; the legacy band rerank survives only under flat-baseline.
  const coverageOrderedCandidates = flatBaselineEnabled()
    ? applySessionCoverageRerank(coverageSelectedCandidates, supplementaryData, window)
    : coverageSelectedCandidates;
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
