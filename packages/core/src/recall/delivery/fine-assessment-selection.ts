import type {
  MemoryDimension as MemoryDimensionType,
  RecallCandidate,
  RecallPolicy,
  RecallScoreFactors
} from "@do-soul/alaya-protocol";
import {
  buildRecallBudgetState,
  buildRecallCandidate,
  buildRecallCandidateSelectionKey
} from "../runtime/recall-candidate-builder.js";
import {
  buildRecallCandidateDedupeKey,
  buildRecallLogicalObjectKey,
  isWorkspaceMemoryCandidate
} from "../runtime/recall-service-helpers.js";
import type {
  CoarseRecallCandidate,
  RecallCandidateDiagnostic,
  RecallCandidateDropReason,
  RecallFusionBreakdown,
  RecallSupplementaryData,
  TokenEstimator
} from "../runtime/recall-service-types.js";
import { orderByCoverageMarginalGain } from "./coverage-selection.js";
import { selectEmbeddingHeadEvictions } from "./admission/embedding-head-dominance.js";
import {
  buildFinalScoreFactors,
  createFineAssessmentDiagnostic
} from "./diagnostics/fine-assessment-diagnostics.js";
import { orderWithBoundedHeadDisplacement } from "./final-order/bounded-head-displacement.js";

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
}>;

export function selectFineAssessmentCandidates(params: FineAssessmentSelectionParams): Readonly<{
  readonly candidates: readonly Readonly<RecallCandidate>[];
  readonly diagnostics: readonly Readonly<RecallCandidateDiagnostic>[];
}> {
  const context = createSelectionContext(params);
  const coverageRelevance =
    params.coverageRelevanceByCandidateKey ?? context.finalRelevanceByCandidateKey;
  const initialOrder = orderFineAssessmentByCoverage(
    params.orderedCandidates,
    context,
    coverageRelevance,
    new Set()
  );
  const evictions = resolveEmbeddingHeadEvictions(initialOrder, context, coverageRelevance);
  const coverageOrdered = orderFineAssessmentByCoverage(
    initialOrder,
    context,
    coverageRelevance,
    evictions
  );
  const finalAccumulator = reduceFineAssessmentCandidates(coverageOrdered, context, evictions);
  const finalOrder = params.finalOrderAfterCoverage ?? "coverage";
  const delivered = finalOrder === "coverage"
    ? freezeSelectedPacket(finalAccumulator)
    : orderDeliveredPacket(
        finalAccumulator,
        context,
        finalOrder,
        params.maxHeadDropAfterCoverage
      );
  return Object.freeze({
    candidates: delivered.candidates,
    diagnostics: delivered.diagnostics
  });
}

function freezeSelectedPacket(
  accumulator: FineAssessmentAccumulator
): Readonly<{
  candidates: readonly Readonly<RecallCandidate>[];
  diagnostics: readonly Readonly<RecallCandidateDiagnostic>[];
}> {
  return Object.freeze({
    candidates: Object.freeze([...accumulator.selected]),
    diagnostics: Object.freeze([...accumulator.diagnostics])
  });
}

function orderDeliveredPacket(
  accumulator: FineAssessmentAccumulator,
  context: FineAssessmentSelectionContext,
  finalOrder: Exclude<FineAssessmentSelectionParams["finalOrderAfterCoverage"], "coverage" | undefined>,
  maxHeadDrop: number | undefined
): Readonly<{
  candidates: readonly Readonly<RecallCandidate>[];
  diagnostics: readonly Readonly<RecallCandidateDiagnostic>[];
}> {
  const publicOrder = [...accumulator.selected].sort((left, right) =>
    compareFinalDeliveryOrder(left, right, finalOrder, context.rankByCandidateKey)
  );
  const candidates = finalOrder === "public_relevance" && maxHeadDrop !== undefined
    ? orderWithBoundedHeadDisplacement({
        publicOrder,
        headRankByKey: context.rankByCandidateKey,
        keyOf: buildRecallCandidateSelectionKey,
        maxDownwardDisplacement: maxHeadDrop,
        protectedRankLimit: context.config.budgets.max_entries
      })
    : publicOrder;
  let usedTokens = 0;
  const finalRankByKey = new Map<string, number>();
  const ranked = candidates.map((candidate, index) => {
    finalRankByKey.set(buildRecallCandidateSelectionKey(candidate), index + 1);
    const budgetState = buildRecallBudgetState({
      tokenEstimate: candidate.token_estimate,
      maxEntries: context.config.budgets.max_entries,
      maxTotalTokens: context.config.budgets.max_total_tokens,
      index,
      usedTokensBeforeCandidate: usedTokens
    });
    usedTokens += candidate.token_estimate;
    return Object.freeze({ ...candidate, budget_state: budgetState });
  });
  const diagnostics = accumulator.diagnostics.map((row) => {
    const finalRank = finalRankByKey.get(row.candidate_key);
    return finalRank === undefined
      ? row
      : Object.freeze({ ...row, final_rank: finalRank, post_rank: finalRank });
  });
  return Object.freeze({
    candidates: Object.freeze(ranked),
    diagnostics: Object.freeze(diagnostics)
  });
}

function compareFinalDeliveryOrder(
  left: Readonly<RecallCandidate>,
  right: Readonly<RecallCandidate>,
  finalOrder: "public_relevance" | "delivery_rank",
  deliveryRankByCandidateKey: ReadonlyMap<string, number>
): number {
  const leftKey = buildRecallCandidateSelectionKey(left);
  const rightKey = buildRecallCandidateSelectionKey(right);
  if (finalOrder === "delivery_rank") {
    return (deliveryRankByCandidateKey.get(leftKey) ?? Number.MAX_SAFE_INTEGER) -
      (deliveryRankByCandidateKey.get(rightKey) ?? Number.MAX_SAFE_INTEGER) ||
      leftKey.localeCompare(rightKey);
  }
  return right.relevance_score - left.relevance_score || leftKey.localeCompare(rightKey);
}

function orderFineAssessmentByCoverage(
  candidates: readonly FineAssessmentCandidate[],
  context: FineAssessmentSelectionContext,
  relevanceByCandidateKey: ReadonlyMap<string, number>,
  evictions: ReadonlySet<string>
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
    )
  });
}

function createSelectionContext(
  params: FineAssessmentSelectionParams
): FineAssessmentSelectionContext {
  const answerRelevanceRankByCandidateKey =
    params.answerRelevanceRankByCandidateKey ?? new Map();
  return Object.freeze({
    config: params.config,
    supplementaryData: params.supplementaryData,
    tokenEstimator: params.tokenEstimator,
    rankByCandidateKey: params.rankByCandidateKey,
    finalRelevanceByCandidateKey: params.finalRelevanceByCandidateKey ?? new Map(),
    answerRelevanceRankByCandidateKey,
    answerRerankedCandidateKeys: new Set(answerRelevanceRankByCandidateKey.keys()),
    captureAnswerFeatures: params.captureAnswerFeatures ?? false,
    tokenEstimateByCandidateKey: new Map()
  });
}

function resolveEmbeddingHeadEvictions(
  candidates: readonly FineAssessmentCandidate[],
  context: FineAssessmentSelectionContext,
  relevanceByCandidateKey: ReadonlyMap<string, number>
): ReadonlySet<string> {
  return selectEmbeddingHeadEvictions({
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
