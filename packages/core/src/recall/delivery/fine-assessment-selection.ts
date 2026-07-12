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

export type FineAssessmentCandidate = Readonly<CoarseRecallCandidate & {
  readonly effectiveScore: number;
  readonly effectiveFactors: RecallScoreFactors;
  readonly fusion: RecallFusionBreakdown;
}>;

interface FineAssessmentAccumulator {
  readonly selected: RecallCandidate[];
  readonly diagnostics: RecallCandidateDiagnostic[];
  readonly seen: Set<string>;
  readonly perDimensionCounts: Map<MemoryDimensionType, number>;
  totalTokens: number;
}

interface FineAssessmentSelectionContext {
  readonly config: Readonly<RecallPolicy>["fine_assessment"];
  readonly supplementaryData: RecallSupplementaryData;
  readonly tokenEstimator: TokenEstimator;
  readonly rankByCandidateKey: ReadonlyMap<string, number>;
  readonly captureAnswerFeatures: boolean;
}

interface FineAssessmentAdmission {
  readonly droppedReason: RecallCandidateDropReason | null;
  readonly tokenEstimate: number | null;
}

export function selectFineAssessmentCandidates(params: {
  readonly orderedCandidates: readonly FineAssessmentCandidate[];
  readonly config: Readonly<RecallPolicy>["fine_assessment"];
  readonly supplementaryData: RecallSupplementaryData;
  readonly tokenEstimator: TokenEstimator;
  readonly rankByCandidateKey: ReadonlyMap<string, number>;
  readonly captureAnswerFeatures?: boolean;
}): Readonly<{
  readonly candidates: readonly Readonly<RecallCandidate>[];
  readonly diagnostics: readonly Readonly<RecallCandidateDiagnostic>[];
}> {
  const context = Object.freeze({
    config: params.config,
    supplementaryData: params.supplementaryData,
    tokenEstimator: params.tokenEstimator,
    rankByCandidateKey: params.rankByCandidateKey,
    captureAnswerFeatures: params.captureAnswerFeatures ?? false
  });
  const finalAccumulator = params.orderedCandidates.reduce(
    (accumulator, candidate, index) => appendFineAssessmentCandidate(accumulator, candidate, index + 1, context),
    createFineAssessmentAccumulator()
  );
  return Object.freeze({
    candidates: Object.freeze([...finalAccumulator.selected]),
    diagnostics: Object.freeze([...finalAccumulator.diagnostics])
  });
}

function createFineAssessmentAccumulator(): FineAssessmentAccumulator {
  return {
    selected: [],
    diagnostics: [],
    seen: new Set<string>(),
    perDimensionCounts: new Map<MemoryDimensionType, number>(),
    totalTokens: 0
  };
}

function appendFineAssessmentCandidate(
  accumulator: FineAssessmentAccumulator,
  candidate: FineAssessmentCandidate,
  selectionOrder: number,
  context: FineAssessmentSelectionContext
): FineAssessmentAccumulator {
  const candidateKey = buildRecallCandidateDedupeKey(candidate);
  const admission = resolveAdmission(accumulator, candidate, candidateKey, context);
  if (admission.droppedReason !== null) {
    accumulator.diagnostics.push(createFineAssessmentDiagnostic(candidate, candidateKey, selectionOrder, null, admission.droppedReason, context));
    return accumulator;
  }
  const tokenEstimate = admission.tokenEstimate ?? context.tokenEstimator.estimate(candidate.entry.content);
  const finalRelevance = candidate.fusion.fused_score;
  const finalScoreFactors = buildFinalScoreFactors(candidate, finalRelevance);
  const nextCandidate = buildRecallCandidate({
    candidate,
    relevanceScore: finalRelevance,
    scoreFactors: finalScoreFactors,
    tokenEstimator: context.tokenEstimator,
    tokenEstimate,
    budgets: context.config.budgets,
    index: accumulator.selected.length,
    usedTokensBeforeCandidate: accumulator.totalTokens,
    governanceCeiling: context.supplementaryData.governanceCeilingByMemoryId[candidate.entry.object_id]
  });
  accumulator.selected.push(nextCandidate);
  accumulator.diagnostics.push(createFineAssessmentDiagnostic(candidate, candidateKey, selectionOrder, accumulator.selected.length, null, context));
  accumulator.seen.add(candidateKey);
  accumulator.perDimensionCounts.set(candidate.entry.dimension, (accumulator.perDimensionCounts.get(candidate.entry.dimension) ?? 0) + 1);
  accumulator.totalTokens += tokenEstimate;
  return accumulator;
}

function resolveAdmission(
  accumulator: FineAssessmentAccumulator,
  candidate: FineAssessmentCandidate,
  candidateKey: string,
  context: FineAssessmentSelectionContext
): FineAssessmentAdmission {
  if (accumulator.seen.has(candidateKey)) {
    return { droppedReason: "duplicate", tokenEstimate: null };
  }
  const dimensionCount = accumulator.perDimensionCounts.get(candidate.entry.dimension) ?? 0;
  const dimensionLimit = context.config.budgets.per_dimension_limits?.[candidate.entry.dimension] ?? null;
  if (dimensionLimit !== null && dimensionCount >= dimensionLimit) {
    return { droppedReason: "dimension_limit", tokenEstimate: null };
  }
  if (accumulator.selected.length + 1 > context.config.budgets.max_entries) {
    return { droppedReason: "max_entries", tokenEstimate: null };
  }
  const tokenEstimate = context.tokenEstimator.estimate(candidate.entry.content);
  if (accumulator.totalTokens + tokenEstimate > context.config.budgets.max_total_tokens) {
    return { droppedReason: "max_total_tokens", tokenEstimate };
  }
  return { droppedReason: null, tokenEstimate };
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
  const fusionRank = context.rankByCandidateKey.get(candidateKey);
  const finalRelevance = candidate.fusion.fused_score;
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
    pre_budget_rank: candidate.fusion.fused_rank,
    selection_order: selectionOrder,
    ...buildFusionDiagnosticFields(candidate),
    final_rank: finalRank,
    // invariant: MemTrace aliases mirror the delivery outcome until the public fields retire.
    post_rank: finalRank,
    in_final_packet: droppedReason === null,
    eviction_reason: droppedReason,
    dropped_reason: droppedReason,
    within_budget: droppedReason === null,
    relevance_score: finalRelevance,
    additive_score: candidate.effectiveScore,
    lexical_rank: lexicalRank(candidate, context.supplementaryData),
    structural_score: clamp01(candidate.structuralScore ?? context.supplementaryData.structuralScores[candidate.entry.object_id] ?? 0),
    score_factors: buildFinalScoreFactors(candidate, finalRelevance),
    source_channels: buildSourceChannels(candidate, admissionPlanes),
    path_expansion_sources: Object.freeze([...(candidate.pathExpansionSources ?? [])]),
    ...(context.captureAnswerFeatures ? {
      answer_features: buildRecallCandidateAnswerFeatures(
        candidate.entry,
        candidate.objectKind ?? "memory_entry",
        context.supplementaryData.evidenceGistsByMemoryId[candidate.entry.object_id]
      )
    } : {}),
    path_suppression_score:
      context.supplementaryData.pathSuppressionScores[candidate.entry.object_id] ?? 0,
    ...buildLegacyStageDiagnosticFields(fusionRank),
    session_key: candidate.entry.surface_id ?? candidate.entry.run_id ?? "<no-session>",
    source_cohort_key: context.supplementaryData.sourceCohortKeys[candidate.entry.object_id] ?? null
  });
}

function buildFinalScoreFactors(
  candidate: FineAssessmentCandidate,
  finalRelevance: number
): RecallScoreFactors {
  return Object.freeze({
    ...candidate.effectiveFactors,
    relevance: finalRelevance
  });
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

function buildLegacyStageDiagnosticFields(fusionRank: number | undefined) {
  return {
    rank_after_fusion: fusionRank,
    rank_after_feature_rerank: fusionRank,
    rank_after_lexical_priority: fusionRank,
    rank_after_coverage_selector: fusionRank,
    rank_after_session_coverage: fusionRank,
    rank_after_synthesis_reserve: fusionRank,
    rank_after_structural_reserve: fusionRank,
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
