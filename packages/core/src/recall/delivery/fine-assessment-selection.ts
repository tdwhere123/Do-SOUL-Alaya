import type { MemoryDimension as MemoryDimensionType, RecallCandidate, RecallPolicy, RecallScoreFactors } from "@do-soul/alaya-protocol";
import { buildRecallCandidate, buildRecallCandidateSelectionKey } from "../runtime/recall-candidate-builder.js";
import { buildRecallCandidateDedupeKey, buildRecallLogicalObjectKey, isWorkspaceMemoryCandidate } from "../runtime/recall-service-helpers.js";
import type { CoarseRecallCandidate, RecallCandidateDiagnostic, RecallCandidateDropReason, RecallFusionBreakdown, RecallSupplementaryData, TokenEstimator } from "../runtime/recall-service-types.js";
import { orderByCoverageMarginalGain } from "./coverage-selection.js";
import type { RecallAnswerSupportObservation } from "../query/recall-answer-support-observation.js";
import type { RecallCandidateAnswerSupport } from "../query/recall-candidate-answer-support.js";
import type { RecallDeepHeadTrace } from "../rerank/deep-head.js";
import {
  hasRankedEmbeddingHead,
  selectEmbeddingHeadPlan
} from "./admission/embedding-head-dominance.js";
import { buildFineAssessmentAnswerSupportContext } from
  "./answer-support/answer-support-context.js";
import { orderByAnswerSupportMembership } from "./answer-support/answer-support-membership.js";
import {
  retainBoundedAnswerHeads,
  selectBoundedDirectEvidenceHead
} from "./admission/direct-evidence-answer-head.js";
import {
  buildFinalScoreFactors,
  createFineAssessmentDiagnostic
} from "./diagnostics/fine-assessment-diagnostics.js";
import { buildFinalPacketConsensusObservation, buildConsensusReplayOrder, packetMatchesConsensusPlan, resolveFinalPacketConsensusPlan, selectFinalPacketConsensusCandidates } from "./final-order/final-packet-consensus.js";
import { mergeFinalPacketAdmissionDiagnostics } from "./final-order/final-packet-diagnostics.js";
import { materializeFinalPacket, orderDeliveredPacket } from "./final-order/final-packet-order.js";
import { orderWithVerifiedAnswerSlot } from "./final-order/verified-answer-slot.js";
import type { RecallPacketPlanObservation } from "./packet-plan/packet-plan-trace.js";
export type FineAssessmentCandidate = Readonly<CoarseRecallCandidate & {
  readonly effectiveScore: number;
  readonly effectiveFactors: RecallScoreFactors;
  readonly fusion: RecallFusionBreakdown;
}>;
interface FineAssessmentAccumulator {
  readonly selected: RecallCandidate[];
  readonly diagnostics: RecallCandidateDiagnostic[];
  readonly admission: FineAssessmentAdmissionState;
}
interface FineAssessmentAdmissionState {
  readonly seenObjects: Set<string>;
  readonly perDimensionCounts: Map<MemoryDimensionType, number>;
  selectedCount: number;
  totalTokens: number;
}
export interface FineAssessmentSelectionContext {
  readonly config: Readonly<RecallPolicy>["fine_assessment"];
  readonly supplementaryData: RecallSupplementaryData;
  readonly tokenEstimator: TokenEstimator;
  readonly rankByCandidateKey: ReadonlyMap<string, number>;
  readonly finalRelevanceByCandidateKey: ReadonlyMap<string, number>;
  readonly answerRelevanceRankByCandidateKey: ReadonlyMap<string, number>;
  readonly answerRerankedCandidateKeys: ReadonlySet<string>;
  readonly captureAnswerFeatures: boolean;
  readonly answerSupportByCandidateKey: ReadonlyMap<
    string,
    Readonly<RecallCandidateAnswerSupport>
  >;
  readonly answerSupportObservationsByCandidateKey: ReadonlyMap<
    string,
    readonly Readonly<RecallAnswerSupportObservation>[]
  >;
  readonly deepHeadTraceByCandidateKey: ReadonlyMap<string, RecallDeepHeadTrace>;
  readonly coverageMarginalGainByCandidateKey: Map<string, number>;
  readonly tokenEstimateByCandidateKey: Map<string, number>;
}

interface FineAssessmentAdmission {
  readonly droppedReason: RecallCandidateDropReason | null;
  readonly tokenEstimate: number | null;
}

type FineAssessmentSelectionParams = Readonly<{
  readonly orderedCandidates: readonly FineAssessmentCandidate[];
  readonly config: Readonly<RecallPolicy>["fine_assessment"];
  readonly supplementaryData: RecallSupplementaryData;
  readonly tokenEstimator: TokenEstimator;
  readonly rankByCandidateKey: ReadonlyMap<string, number>;
  readonly finalRelevanceByCandidateKey?: ReadonlyMap<string, number>;
  /** Packing relevance; defaults to finalRelevance. Deep-head scores when public scalar stays fused. */
  readonly coverageRelevanceByCandidateKey?: ReadonlyMap<string, number>;
  readonly finalOrderAfterCoverage?: "coverage" | "public_relevance" | "delivery_rank";
  readonly maxHeadDropAfterCoverage?: number;
  readonly answerRelevanceRankByCandidateKey?: ReadonlyMap<string, number>;
  readonly captureAnswerFeatures?: boolean;
  readonly capturePacketPlanTrace?: boolean;
  readonly deepHeadTraceByCandidateKey?: ReadonlyMap<string, RecallDeepHeadTrace>;
}>;

type FineAssessmentSelectionResult = ReturnType<typeof materializeFinalPacket> & Readonly<{
  readonly packetPlanObservation?: Readonly<RecallPacketPlanObservation>;
}>;
export function selectFineAssessmentCandidates(
  params: FineAssessmentSelectionParams
): FineAssessmentSelectionResult {
  const context = createSelectionContext(params);
  const {
    coverageOrdered,
    evictions,
    embeddingProtectedCandidateKeys
  } = prepareCoverageSelection(params, context);
  const evidenceHead = selectBoundedDirectEvidenceHead(
    coverageOrdered, context.supplementaryData.queryProbes,
    context.supplementaryData.evidenceSemanticScoresByCandidateKey,
    context.finalRelevanceByCandidateKey,
    context.config.budgets.max_entries, evictions,
    (candidates) => collectAdmittedCandidates(candidates, context, evictions),
    (candidate) => context.answerSupportByCandidateKey.get(
      candidate.fusion.candidate_key)?.authority?.behavior_eligible === true
  );
  const membershipOrdered = orderByAnswerSupportMembership({
    candidates: evidenceHead.candidates,
    protectedCandidateKeys: new Set([
      ...embeddingProtectedCandidateKeys,
      ...evidenceHead.protections.map((protection) => protection.candidateKey)
    ]),
    supportByCandidateKey: context.answerSupportByCandidateKey,
    selectAdmitted: (source) => collectAdmittedCandidates(
      source, context, evictions
    )
  });
  const finalAccumulator = reduceFineAssessmentCandidates(
    membershipOrdered, context, evictions
  );
  const finalOrder = params.finalOrderAfterCoverage ?? "coverage";
  const delivered = finalOrder === "coverage"
    ? materializeFinalPacket(
        retainBoundedAnswerHeads(
          orderWithVerifiedAnswerSlot({
            publicOrder: finalAccumulator.selected,
            supportByCandidateKey: context.answerSupportByCandidateKey
          }),
          evidenceHead.protections,
          buildRecallCandidateSelectionKey,
          context.supplementaryData.queryProbes,
          evidenceHead.candidates,
          (candidateKey) => context.answerSupportByCandidateKey.get(
            candidateKey
          )?.authority?.behavior_eligible === true
        ),
        finalAccumulator.diagnostics,
        context.config.budgets
      )
    : orderDeliveredPacket({
        selected: finalAccumulator.selected,
        diagnostics: finalAccumulator.diagnostics,
        context,
        finalOrder,
        maxHeadDrop: params.maxHeadDropAfterCoverage,
        answerHeadProtections: evidenceHead.protections,
        sourceCandidates: evidenceHead.candidates
      });
  const consensusCandidates = selectFinalPacketConsensusCandidates(
    evidenceHead.candidates, evidenceHead.rejectedCandidateKeys
  );
  const consensus = resolveFinalPacketConsensusPlan({
    baseline: delivered.candidates,
    sourceCandidates: consensusCandidates,
    protectedCandidates: evidenceHead.protections,
    behaviorGuardFullAbort: delivered.candidates.some((candidate) =>
      context.answerSupportByCandidateKey.get(
        buildRecallCandidateSelectionKey(candidate)
      )?.authority?.behavior_eligible === true
    )
  });
  const consensusResult = applyFinalPacketConsensus(
    consensus,
    delivered,
    consensusCandidates,
    context,
    evictions
  );
  return buildSelectionResult(params, consensus, consensusResult);
}

function buildSelectionResult(
  params: FineAssessmentSelectionParams,
  consensus: ReturnType<typeof resolveFinalPacketConsensusPlan>,
  result: ReturnType<typeof applyFinalPacketConsensus>
): FineAssessmentSelectionResult {
  return Object.freeze({
    candidates: result.packet.candidates,
    diagnostics: result.packet.diagnostics,
    ...(params.capturePacketPlanTrace === true
      ? {
          packetPlanObservation: buildFinalPacketConsensusObservation(
            consensus,
            result.packet.candidates,
            result.replayAccepted
          )
        }
      : {})
  });
}

function applyFinalPacketConsensus(
  plan: ReturnType<typeof resolveFinalPacketConsensusPlan>,
  baseline: ReturnType<typeof materializeFinalPacket>,
  sourceCandidates: readonly FineAssessmentCandidate[],
  context: FineAssessmentSelectionContext,
  evictions: ReadonlySet<string>
): Readonly<{
  readonly packet: ReturnType<typeof materializeFinalPacket>;
  readonly replayAccepted: boolean;
}> {
  if (plan.decision.status !== "accepted") {
    return Object.freeze({ packet: baseline, replayAccepted: false });
  }
  const replay = reduceFineAssessmentCandidates(
    buildConsensusReplayOrder(plan, sourceCandidates),
    context,
    evictions
  );
  if (!packetMatchesConsensusPlan(plan, replay.selected)) {
    return Object.freeze({ packet: baseline, replayAccepted: false });
  }
  return Object.freeze({
    packet: materializeFinalPacket(
      replay.selected,
      mergeFinalPacketAdmissionDiagnostics(
        baseline.diagnostics,
        replay.diagnostics
      ),
      context.config.budgets
    ),
    replayAccepted: true
  });
}

function prepareCoverageSelection(
  params: FineAssessmentSelectionParams,
  context: FineAssessmentSelectionContext
): Readonly<{
  readonly coverageOrdered: readonly FineAssessmentCandidate[];
  readonly evictions: ReadonlySet<string>;
  readonly embeddingProtectedCandidateKeys: ReadonlySet<string>;
}> {
  const coverageRelevance =
    params.coverageRelevanceByCandidateKey ?? context.finalRelevanceByCandidateKey;
  const hasEmbeddingHead = hasRankedEmbeddingHead(
    params.orderedCandidates,
    context.config.budgets.max_entries
  );
  const initialOrder = orderFineAssessmentByCoverage(
    params.orderedCandidates, context, coverageRelevance, new Set(),
    !hasEmbeddingHead && context.captureAnswerFeatures
  );
  const embeddingPlan = hasEmbeddingHead
    ? resolveEmbeddingHeadPlan(initialOrder, context, coverageRelevance)
    : { evictions: new Set<string>(), protectedCandidateKeys: new Set<string>() };
  const { evictions } = embeddingPlan;
  const coverageOrdered = hasEmbeddingHead
    ? orderFineAssessmentByCoverage(
        initialOrder, context, coverageRelevance, evictions,
        context.captureAnswerFeatures
      )
    : initialOrder;
  return Object.freeze({
    coverageOrdered,
    evictions,
    embeddingProtectedCandidateKeys: embeddingPlan.protectedCandidateKeys
  });
}

function orderFineAssessmentByCoverage(
  candidates: readonly FineAssessmentCandidate[],
  context: FineAssessmentSelectionContext,
  relevanceByCandidateKey: ReadonlyMap<string, number>,
  evictions: ReadonlySet<string>,
  captureMarginalGain = false
): readonly FineAssessmentCandidate[] {
  const admission = createAdmissionState();
  return orderByCoverageMarginalGain({
    candidates,
    relevanceByCandidateKey,
    supplementaryData: context.supplementaryData,
    advancesCoverage: (candidate) => tryRecordAcceptedAdmission(
      admission,
      candidate,
      context,
      evictions
    ),
    onSelection: captureMarginalGain
      ? (observation) => context.coverageMarginalGainByCandidateKey.set(
          observation.candidate_key,
          observation.marginal_gain
        )
      : undefined
  });
}

function createSelectionContext(
  params: FineAssessmentSelectionParams
): FineAssessmentSelectionContext {
  const answerRelevanceRankByCandidateKey =
    params.answerRelevanceRankByCandidateKey ?? new Map();
  const captureAnswerFeatures = params.captureAnswerFeatures ?? false;
  const answerSupport = buildFineAssessmentAnswerSupportContext({
    candidates: params.orderedCandidates,
    supplementaryData: params.supplementaryData,
    captureObservations: captureAnswerFeatures
  });
  return Object.freeze({
    config: params.config,
    supplementaryData: params.supplementaryData,
    tokenEstimator: params.tokenEstimator,
    rankByCandidateKey: params.rankByCandidateKey,
    finalRelevanceByCandidateKey: params.finalRelevanceByCandidateKey ?? new Map(),
    answerRelevanceRankByCandidateKey,
    answerRerankedCandidateKeys: new Set(answerRelevanceRankByCandidateKey.keys()),
    captureAnswerFeatures,
    answerSupportByCandidateKey: answerSupport.supportByCandidateKey,
    answerSupportObservationsByCandidateKey:
      answerSupport.observationsByCandidateKey,
    deepHeadTraceByCandidateKey: captureAnswerFeatures
      ? params.deepHeadTraceByCandidateKey ?? new Map()
      : new Map(),
    coverageMarginalGainByCandidateKey: new Map(),
    tokenEstimateByCandidateKey: new Map()
  });
}

function resolveEmbeddingHeadPlan(
  candidates: readonly FineAssessmentCandidate[],
  context: FineAssessmentSelectionContext,
  relevanceByCandidateKey: ReadonlyMap<string, number>
) {
  return selectEmbeddingHeadPlan({
    candidates,
    maxEntries: context.config.budgets.max_entries,
    embeddingScores: context.supplementaryData.embeddingSimilarityScores,
    queryProbes: context.supplementaryData.queryProbes,
    answerRerankedCandidateKeys: context.answerRerankedCandidateKeys,
    selectDelivered: (evictions) => collectAdmittedCandidates(
      orderFineAssessmentByCoverage(candidates, context, relevanceByCandidateKey, evictions),
      context,
      evictions
    )
  });
}

function reduceFineAssessmentCandidates(
  candidates: readonly FineAssessmentCandidate[],
  context: FineAssessmentSelectionContext,
  evictions: ReadonlySet<string>
): FineAssessmentAccumulator {
  return candidates.reduce(
    (accumulator, candidate, index) => appendFineAssessmentCandidate(
      accumulator,
      candidate,
      index + 1,
      context,
      evictions.has(candidate.fusion.candidate_key)
    ),
    createFineAssessmentAccumulator()
  );
}

function createFineAssessmentAccumulator(): FineAssessmentAccumulator {
  return {
    selected: [],
    diagnostics: [],
    admission: createAdmissionState()
  };
}

function createAdmissionState(): FineAssessmentAdmissionState {
  return {
    seenObjects: new Set<string>(),
    perDimensionCounts: new Map<MemoryDimensionType, number>(),
    selectedCount: 0,
    totalTokens: 0
  };
}

function appendFineAssessmentCandidate(
  accumulator: FineAssessmentAccumulator,
  candidate: FineAssessmentCandidate,
  selectionOrder: number,
  context: FineAssessmentSelectionContext,
  dominanceEvicted: boolean
): FineAssessmentAccumulator {
  const candidateKey = buildRecallCandidateDedupeKey(candidate);
  if (dominanceEvicted) {
    accumulator.diagnostics.push(createFineAssessmentDiagnostic(
      candidate, candidateKey, selectionOrder, null, "embedding_head_dominance", context
    ));
    return accumulator;
  }
  const objectKey = buildRecallLogicalObjectKey(candidate);
  const admission = resolveAdmission(accumulator.admission, candidate, objectKey, context);
  if (admission.droppedReason !== null) {
    accumulator.diagnostics.push(createFineAssessmentDiagnostic(candidate, candidateKey, selectionOrder, null, admission.droppedReason, context));
    return accumulator;
  }
  const tokenEstimate = admission.tokenEstimate ?? estimateCandidateTokens(candidate, context);
  const finalRelevance = context.finalRelevanceByCandidateKey.get(candidateKey) ?? candidate.fusion.fused_score;
  const finalRelevanceSource = context.answerRelevanceRankByCandidateKey.has(candidateKey)
    ? "answer_rerank" as const
    : "fusion" as const;
  const finalScoreFactors = buildFinalScoreFactors(candidate, finalRelevance);
  const nextCandidate = buildRecallCandidate({
    candidate,
    relevanceScore: finalRelevance,
    scoreFactors: finalScoreFactors,
    finalRelevanceSource,
    tokenEstimator: context.tokenEstimator,
    tokenEstimate,
    budgets: context.config.budgets,
    index: accumulator.selected.length,
    usedTokensBeforeCandidate: accumulator.admission.totalTokens,
    governanceCeiling: isWorkspaceMemoryCandidate(candidate)
      ? context.supplementaryData.governanceCeilingByMemoryId[candidate.entry.object_id]
      : undefined
  });
  accumulator.selected.push(nextCandidate);
  accumulator.diagnostics.push(createFineAssessmentDiagnostic(candidate, candidateKey, selectionOrder, accumulator.selected.length, null, context));
  recordAcceptedAdmission(accumulator.admission, candidate, objectKey, tokenEstimate);
  return accumulator;
}

function resolveAdmission(
  state: FineAssessmentAdmissionState,
  candidate: FineAssessmentCandidate,
  objectKey: string,
  context: FineAssessmentSelectionContext
): FineAssessmentAdmission {
  if (state.seenObjects.has(objectKey)) {
    return { droppedReason: "duplicate", tokenEstimate: null };
  }
  const dimensionCount = state.perDimensionCounts.get(candidate.entry.dimension) ?? 0;
  const dimensionLimit = context.config.budgets.per_dimension_limits?.[candidate.entry.dimension] ?? null;
  if (dimensionLimit !== null && dimensionCount >= dimensionLimit) {
    return { droppedReason: "dimension_limit", tokenEstimate: null };
  }
  if (state.selectedCount + 1 > context.config.budgets.max_entries) {
    return { droppedReason: "max_entries", tokenEstimate: null };
  }
  const tokenEstimate = estimateCandidateTokens(candidate, context);
  if (state.totalTokens + tokenEstimate > context.config.budgets.max_total_tokens) {
    return { droppedReason: "max_total_tokens", tokenEstimate };
  }
  return { droppedReason: null, tokenEstimate };
}

function tryRecordAcceptedAdmission(
  state: FineAssessmentAdmissionState,
  candidate: FineAssessmentCandidate,
  context: FineAssessmentSelectionContext,
  evictions: ReadonlySet<string>
): boolean {
  if (evictions.has(candidate.fusion.candidate_key)) return false;
  const objectKey = buildRecallLogicalObjectKey(candidate);
  const admission = resolveAdmission(state, candidate, objectKey, context);
  if (admission.droppedReason !== null) return false;
  const tokenEstimate = admission.tokenEstimate ?? estimateCandidateTokens(candidate, context);
  recordAcceptedAdmission(state, candidate, objectKey, tokenEstimate);
  return true;
}

function collectAdmittedCandidates(
  candidates: readonly FineAssessmentCandidate[],
  context: FineAssessmentSelectionContext,
  evictions: ReadonlySet<string>
): readonly FineAssessmentCandidate[] {
  const state = createAdmissionState();
  const delivered: FineAssessmentCandidate[] = [];
  for (const candidate of candidates) {
    if (!tryRecordAcceptedAdmission(state, candidate, context, evictions)) continue;
    delivered.push(candidate);
  }
  return delivered;
}

function recordAcceptedAdmission(
  state: FineAssessmentAdmissionState,
  candidate: FineAssessmentCandidate,
  objectKey: string,
  tokenEstimate: number
): void {
  state.seenObjects.add(objectKey);
  state.perDimensionCounts.set(
    candidate.entry.dimension,
    (state.perDimensionCounts.get(candidate.entry.dimension) ?? 0) + 1
  );
  state.selectedCount += 1;
  state.totalTokens += tokenEstimate;
}

function estimateCandidateTokens(
  candidate: FineAssessmentCandidate,
  context: FineAssessmentSelectionContext
): number {
  const candidateKey = buildRecallCandidateDedupeKey(candidate);
  const cached = context.tokenEstimateByCandidateKey.get(candidateKey);
  if (cached !== undefined) return cached;
  const estimated = context.tokenEstimator.estimate(candidate.entry.content);
  context.tokenEstimateByCandidateKey.set(candidateKey, estimated);
  return estimated;
}
