import type {
  MemoryDimension as MemoryDimensionType,
  RecallCandidate,
  RecallPolicy,
  RecallScoreFactors
} from "@do-soul/alaya-protocol";
import { buildRecallCandidate } from "../runtime/recall-candidate-builder.js";
import { buildRecallCandidateDedupeKey, clamp01 } from "../runtime/recall-service-helpers.js";
import type {
  CoarseRecallCandidate,
  RecallCandidateDiagnostic,
  RecallCandidateDropReason,
  RecallFusionBreakdown,
  RecallSupplementaryData,
  TokenEstimator
} from "../runtime/recall-service-types.js";
import { uniqueStrings } from "../expansion/path-relations.js";
import { selectRecallAdmissionAttributionPlane } from "../scoring/scoring.js";
import { buildRecallCandidateAnswerFeatures } from "./fine-assessment-answer-features.js";
import { orderByCoverageMarginalGain } from "./coverage-selection.js";
import { selectEmbeddingHeadEvictions } from "./admission/embedding-head-dominance.js";

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

interface FineAssessmentSelectionContext {
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
  readonly answerRelevanceRankByCandidateKey?: ReadonlyMap<string, number>;
  readonly captureAnswerFeatures?: boolean;
}>;

export function selectFineAssessmentCandidates(params: FineAssessmentSelectionParams): Readonly<{
  readonly candidates: readonly Readonly<RecallCandidate>[];
  readonly diagnostics: readonly Readonly<RecallCandidateDiagnostic>[];
}> {
  const context = createSelectionContext(params);
  const coverageOrdered = orderByCoverageMarginalGain({
    candidates: params.orderedCandidates,
    relevanceByCandidateKey:
      params.coverageRelevanceByCandidateKey ?? context.finalRelevanceByCandidateKey,
    supplementaryData: params.supplementaryData
  });
  const evictions = resolveEmbeddingHeadEvictions(coverageOrdered, context);
  const finalAccumulator = reduceFineAssessmentCandidates(coverageOrdered, context, evictions);
  return Object.freeze({
    candidates: Object.freeze([...finalAccumulator.selected]),
    diagnostics: Object.freeze([...finalAccumulator.diagnostics])
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
  context: FineAssessmentSelectionContext
): ReadonlySet<string> {
  return selectEmbeddingHeadEvictions({
    candidates,
    maxEntries: context.config.budgets.max_entries,
    embeddingScores: context.supplementaryData.embeddingSimilarityScores,
    queryProbes: context.supplementaryData.queryProbes,
    answerRerankedCandidateKeys: context.answerRerankedCandidateKeys,
    selectDelivered: (evictions) => collectAdmittedCandidates(candidates, context, evictions)
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
  const objectKey = buildFineAssessmentObjectKey(candidate);
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
    governanceCeiling: context.supplementaryData.governanceCeilingByMemoryId[candidate.entry.object_id]
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

function collectAdmittedCandidates(
  candidates: readonly FineAssessmentCandidate[],
  context: FineAssessmentSelectionContext,
  evictions: ReadonlySet<string>
): readonly FineAssessmentCandidate[] {
  const state = createAdmissionState();
  const delivered: FineAssessmentCandidate[] = [];
  for (const candidate of candidates) {
    if (evictions.has(candidate.fusion.candidate_key)) continue;
    const objectKey = buildFineAssessmentObjectKey(candidate);
    const admission = resolveAdmission(state, candidate, objectKey, context);
    if (admission.droppedReason !== null) continue;
    const tokenEstimate = admission.tokenEstimate ?? estimateCandidateTokens(candidate, context);
    recordAcceptedAdmission(state, candidate, objectKey, tokenEstimate);
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

function buildFineAssessmentObjectKey(candidate: FineAssessmentCandidate): string {
  return `${candidate.objectKind ?? candidate.entry.object_kind}:${candidate.entry.object_id}`;
}

function createFineAssessmentDiagnostic(
  candidate: FineAssessmentCandidate,
  candidateKey: string,
  selectionOrder: number,
  finalRank: number | null,
  droppedReason: RecallCandidateDropReason | null,
  context: FineAssessmentSelectionContext
): Readonly<RecallCandidateDiagnostic> {
  const admissionPlanes = Object.freeze([...(candidate.admissionPlanes ?? ["activation"])]);
  const ranks = resolveCandidateRankContext(candidate, candidateKey, context);
  return Object.freeze({
    candidate_key: candidateKey,
    object_id: candidate.entry.object_id,
    object_kind: candidate.objectKind ?? "memory_entry",
    created_at: candidate.entry.created_at,
    facet_overlap: candidate.fusion.facet_overlap,
    dimension: candidate.entry.dimension,
    origin_plane: candidate.originPlane ?? "workspace_local",
    admission_planes: admissionPlanes,
    plane_first_admitted: candidate.firstAdmissionPlane ?? admissionPlanes[0] ?? "activation",
    plane_winning_admission: selectRecallAdmissionAttributionPlane(admissionPlanes, candidate.firstAdmissionPlane),
    pre_budget_rank: selectionOrder,
    selection_order: selectionOrder,
    ...buildFusionDiagnosticFields(candidate),
    final_rank: finalRank,
    post_rank: finalRank,
    in_final_packet: droppedReason === null,
    eviction_reason: droppedReason,
    dropped_reason: droppedReason,
    within_budget: droppedReason === null,
    relevance_score: ranks.finalRelevance,
    ...(ranks.answerRelevanceRank === undefined ? {} : {
      answer_relevance_score: ranks.finalRelevance,
      answer_relevance_rank: ranks.answerRelevanceRank
    }),
    additive_score: candidate.effectiveScore,
    lexical_rank: lexicalRank(candidate, context.supplementaryData),
    structural_score: clamp01(candidate.structuralScore ?? context.supplementaryData.structuralScores[candidate.entry.object_id] ?? 0),
    score_factors: buildFinalScoreFactors(candidate, ranks.finalRelevance),
    source_channels: buildSourceChannels(candidate, admissionPlanes),
    path_expansion_sources: Object.freeze([...(candidate.pathExpansionSources ?? [])]),
    ...buildAnswerFeatureDiagnostics(candidate, context),
    path_suppression_score:
      context.supplementaryData.pathSuppressionScores[candidate.entry.object_id] ?? 0,
    ...buildCompatibilityStageDiagnosticAliases(candidate.fusion.fused_rank, ranks.deliveryRank),
    session_key: candidate.entry.surface_id ?? candidate.entry.run_id ?? "<no-session>",
    source_cohort_key: context.supplementaryData.sourceCohortKeys[candidate.entry.object_id] ?? null
  });
}

function buildFinalScoreFactors(
  candidate: FineAssessmentCandidate,
  finalRelevance: number
): RecallScoreFactors {
  return Object.freeze({ ...candidate.effectiveFactors, relevance: finalRelevance });
}

function buildAnswerFeatureDiagnostics(
  candidate: FineAssessmentCandidate,
  context: FineAssessmentSelectionContext
) {
  if (!context.captureAnswerFeatures) return {};
  return {
    answer_features: buildRecallCandidateAnswerFeatures(
      candidate.entry,
      candidate.objectKind ?? "memory_entry",
      context.supplementaryData.evidenceGistsByMemoryId[candidate.entry.object_id]
    )
  };
}

function resolveCandidateRankContext(
  candidate: FineAssessmentCandidate,
  candidateKey: string,
  context: FineAssessmentSelectionContext
): Readonly<{
  readonly deliveryRank: number | undefined;
  readonly finalRelevance: number;
  readonly answerRelevanceRank: number | undefined;
}> {
  return {
    deliveryRank: context.rankByCandidateKey.get(candidateKey),
    finalRelevance: context.finalRelevanceByCandidateKey.get(candidateKey) ?? candidate.fusion.fused_score,
    answerRelevanceRank: context.answerRelevanceRankByCandidateKey.get(candidateKey)
  };
}

function buildFusionDiagnosticFields(candidate: FineAssessmentCandidate) {
  const fusion = candidate.fusion;
  return {
    fused_rank: fusion.fused_rank,
    fused_score: fusion.fused_score,
    per_stream_rank: fusion.per_stream_rank,
    fused_rank_contribution_per_stream: fusion.fused_rank_contribution_per_stream,
    ...(fusion.per_axis_rank === undefined ? {} : { per_axis_rank: fusion.per_axis_rank }),
    ...(fusion.per_axis_contribution === undefined
      ? {}
      : { per_axis_contribution: fusion.per_axis_contribution }),
    ...(fusion.flood_potential === undefined ? {} : { flood_potential: fusion.flood_potential }),
    ...(fusion.flood_fuel_coverage === undefined
      ? {}
      : { flood_fuel_coverage: fusion.flood_fuel_coverage })
  };
}

function buildCompatibilityStageDiagnosticAliases(
  fusionRank: number | undefined,
  deliveryRank: number | undefined
) {
  return {
    rank_after_fusion: fusionRank,
    rank_after_feature_rerank: deliveryRank,
    rank_after_lexical_priority: deliveryRank,
    rank_after_coverage_selector: deliveryRank,
    rank_after_session_coverage: deliveryRank,
    rank_after_synthesis_reserve: deliveryRank,
    rank_after_structural_reserve: deliveryRank,
    coverage_selector_action: "noop" as const,
    session_coverage_action: "noop" as const,
    reserved_by: "none" as const
  };
}

function lexicalRank(candidate: FineAssessmentCandidate, supplementaryData: RecallSupplementaryData): number | null {
  return candidate.objectKind === "synthesis_capsule"
    ? supplementaryData.synthesisFtsRanks[candidate.entry.object_id] ?? null
    : supplementaryData.ftsRanks[candidate.entry.object_id] ?? null;
}

function buildSourceChannels(
  candidate: FineAssessmentCandidate,
  admissionPlanes: readonly string[]
): readonly string[] {
  return Object.freeze(uniqueStrings([
    candidate.originPlane ?? "workspace_local",
    candidate.sourceChannel ?? "",
    ...(candidate.sourceChannels ?? []),
    ...((candidate.effectiveFactors.embedding_similarity ?? 0) > 0 ? ["semantic_supplement"] : []),
    ...admissionPlanes.map((plane) => `plane:${plane}`)
  ].filter((channel) => channel.length > 0)));
}
