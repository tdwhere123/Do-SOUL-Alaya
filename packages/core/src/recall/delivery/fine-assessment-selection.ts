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

export type FineAssessmentCandidate = Readonly<CoarseRecallCandidate & {
  readonly effectiveScore: number;
  readonly effectiveFactors: RecallScoreFactors;
  readonly fusion: RecallFusionBreakdown;
}>;

export interface FineAssessmentRankDiagnostics {
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
  readonly ranks: FineAssessmentRankDiagnostics;
}

interface FineAssessmentAdmission {
  readonly droppedReason: RecallCandidateDropReason | null;
  readonly tokenEstimate: number | null;
}

export function selectFineAssessmentCandidates(params: {
  readonly deliveryOrderedCandidates: readonly FineAssessmentCandidate[];
  readonly config: Readonly<RecallPolicy>["fine_assessment"];
  readonly supplementaryData: RecallSupplementaryData;
  readonly tokenEstimator: TokenEstimator;
  readonly ranks: FineAssessmentRankDiagnostics;
}): Readonly<{
  readonly candidates: readonly Readonly<RecallCandidate>[];
  readonly diagnostics: readonly Readonly<RecallCandidateDiagnostic>[];
}> {
  const context = Object.freeze({
    config: params.config,
    supplementaryData: params.supplementaryData,
    tokenEstimator: params.tokenEstimator,
    ranks: params.ranks
  });
  const finalAccumulator = params.deliveryOrderedCandidates.reduce(
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
  const nextCandidate = buildRecallCandidate({
    candidate,
    relevanceScore: candidate.effectiveScore,
    scoreFactors: candidate.effectiveFactors,
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
  const rankContext = resolveCandidateRankContext(candidateKey, context);
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
    fused_rank: candidate.fusion.fused_rank,
    fused_score: candidate.fusion.fused_score,
    per_stream_rank: candidate.fusion.per_stream_rank,
    fused_rank_contribution_per_stream: candidate.fusion.fused_rank_contribution_per_stream,
    ...(candidate.fusion.per_axis_rank === undefined
      ? {}
      : { per_axis_rank: candidate.fusion.per_axis_rank }),
    ...(candidate.fusion.per_axis_contribution === undefined
      ? {}
      : { per_axis_contribution: candidate.fusion.per_axis_contribution }),
    ...(candidate.fusion.flood_potential === undefined
      ? {}
      : { flood_potential: candidate.fusion.flood_potential }),
    ...(candidate.fusion.flood_fuel_coverage === undefined
      ? {}
      : { flood_fuel_coverage: candidate.fusion.flood_fuel_coverage }),
    final_rank: finalRank,
    // MemTrace attribution aliases: derived from existing delivery fields.
    post_rank: finalRank,
    in_final_packet: droppedReason === null,
    eviction_reason: droppedReason,
    dropped_reason: droppedReason,
    within_budget: droppedReason === null,
    relevance_score: candidate.effectiveScore,
    lexical_rank: lexicalRank(candidate, context.supplementaryData),
    structural_score: clamp01(candidate.structuralScore ?? context.supplementaryData.structuralScores[candidate.entry.object_id] ?? 0),
    score_factors: candidate.effectiveFactors,
    source_channels: buildSourceChannels(candidate, admissionPlanes),
    path_expansion_sources: Object.freeze([...(candidate.pathExpansionSources ?? [])]),
    rank_after_fusion: rankContext.rankAfterFusion,
    rank_after_feature_rerank: rankContext.rankAfterFeatureRerank,
    rank_after_lexical_priority: rankContext.rankAfterLex,
    rank_after_coverage_selector: rankContext.rankAfterCoverage,
    rank_after_session_coverage: rankContext.rankAfterSession,
    coverage_selector_action: rankContext.coverageSelectorAction,
    session_coverage_action: rankContext.sessionCoverageAction,
    session_key: candidate.entry.surface_id ?? candidate.entry.run_id ?? "<no-session>",
    source_cohort_key: context.supplementaryData.sourceCohortKeys[candidate.entry.object_id] ?? null,
    rank_after_synthesis_reserve: rankContext.rankAfterSyn,
    rank_after_structural_reserve: rankContext.rankAfterStruct,
    reserved_by: rankContext.reservedBy
  });
}

function resolveCandidateRankContext(
  candidateKey: string,
  context: FineAssessmentSelectionContext
): Readonly<{
  readonly rankAfterFusion: number | undefined;
  readonly rankAfterFeatureRerank: number | undefined;
  readonly rankAfterLex: number | undefined;
  readonly rankAfterCoverage: number | undefined;
  readonly rankAfterSession: number | undefined;
  readonly rankAfterSyn: number | undefined;
  readonly rankAfterStruct: number | undefined;
  readonly coverageSelectorAction: "noop" | "kept" | "promoted" | "displaced";
  readonly sessionCoverageAction: "noop" | "kept" | "promoted" | "displaced";
  readonly reservedBy: "none" | "synthesis" | "structural";
}> {
  const ranks = context.ranks;
  const rankAfterLex = ranks.rankAfterLexicalPriority.get(candidateKey);
  const rankAfterCoverage = ranks.rankAfterCoverageSelector.get(candidateKey);
  const rankAfterSession = ranks.rankAfterSessionCoverage.get(candidateKey);
  const rankAfterSyn = ranks.rankAfterSynthesisReserve.get(candidateKey);
  const rankAfterStruct = ranks.rankAfterStructuralReserve.get(candidateKey);
  return Object.freeze({
    rankAfterFusion: ranks.rankAfterFusion.get(candidateKey),
    rankAfterFeatureRerank: ranks.rankAfterFeatureRerank.get(candidateKey),
    rankAfterLex,
    rankAfterCoverage,
    rankAfterSession,
    rankAfterSyn,
    rankAfterStruct,
    coverageSelectorAction: deliveryStageAction(rankAfterLex, rankAfterCoverage, ranks.coverageSelectorNoop),
    sessionCoverageAction: deliveryStageAction(rankAfterCoverage, rankAfterSession, ranks.sessionCoverageNoop),
    reservedBy: resolveReservedBy(rankAfterLex, rankAfterSyn, rankAfterStruct, context.config.budgets.max_entries)
  });
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

function resolveReservedBy(
  rankAfterLex: number | undefined,
  rankAfterSyn: number | undefined,
  rankAfterStruct: number | undefined,
  maxEntries: number
): "none" | "synthesis" | "structural" {
  // invariant: wire value "synthesis" means likelihood tail-rescue.
  if (rankAfterSyn !== undefined && rankAfterSyn <= maxEntries && (rankAfterLex === undefined || rankAfterLex > maxEntries)) {
    return "synthesis";
  }
  if (rankAfterStruct !== undefined && rankAfterStruct <= maxEntries && (rankAfterSyn === undefined || rankAfterSyn > maxEntries)) {
    return "structural";
  }
  return "none";
}

function deliveryStageAction(
  before: number | undefined,
  after: number | undefined,
  nooped: boolean
): "noop" | "kept" | "promoted" | "displaced" {
  if (nooped) {
    return "noop";
  }
  if (before === undefined || after === undefined || before === after) {
    return "kept";
  }
  return after < before ? "promoted" : "displaced";
}
