import type {
  MemoryDimension as MemoryDimensionType,
  RecallCandidate,
  RecallPolicy,
  RecallScoreFactors
} from "@do-soul/alaya-protocol";
import { buildRecallCandidate } from "./recall-candidate-builder.js";
import {
  buildRecallCandidateDedupeKey,
  clamp01
} from "./recall-service-helpers.js";
import type {
  CoarseRecallCandidate,
  RecallCandidateDiagnostic,
  RecallCandidateDropReason,
  RecallFusionBreakdown,
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
  reserveStructuralDeliverySlots,
  reserveSynthesisDeliverySlots,
  synthesisReserveCount
} from "./fusion-delivery.js";
import { uniqueStrings } from "./path-relations.js";
import {
  computeEffectiveScoreDetails,
  selectRecallAdmissionAttributionPlane
} from "./scoring.js";

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
  const {
    candidates,
    policy,
    winnerMemoryIds,
    supplementaryData,
    tokenEstimator,
    now,
    warn
  } = params;
  if (candidates.length === 0) {
    return Object.freeze({
      candidates: Object.freeze([]),
      diagnostics: Object.freeze([])
    });
  }
  const config = policy.fine_assessment;

  const additiveScoredCandidates = candidates.map((candidate) => {
    const scored = computeEffectiveScoreDetails({
      entry: candidate.entry,
      policy,
      winnerMemoryIds,
      supplementaryData,
      originPlane: candidate.originPlane ?? "workspace_local",
      isAdvisory: candidate.isAdvisory ?? false,
      scoreMultiplier: candidate.scoreMultiplier ?? 1,
      objectKind: candidate.objectKind ?? "memory_entry",
      now,
      warn
    });
    return Object.freeze({
      ...candidate,
      effectiveScore: scored.score,
      effectiveFactors: scored.factors
    });
  });
  const fusedDetails = buildRecallFusionDetails({
    candidates: additiveScoredCandidates,
    policy,
    supplementaryData,
    nowIso: now()
  });
  // Active sign-aware suppression: subtract the negative-path demotion delta
  // from the fused score and re-rank, before delivery sort. Runs after the
  // positive fusion so suppression demotes a target that positive streams
  // would otherwise rank highly. No-op when no suppression was collected.
  const fusionByCandidateKey = applyPathSuppressionToFusionScores(
    fusedDetails,
    supplementaryData.pathSuppressionScores
  );
  const scoredCandidates = additiveScoredCandidates.map((candidate) => Object.freeze({
    ...candidate,
    fusion: fusionByCandidateKey.get(buildRecallCandidateDedupeKey(candidate)) ?? buildEmptyRecallFusionBreakdown(candidate.entry.object_id)
  }));
  const rankedCandidates = scoredCandidates
    .sort(compareFusedRecallCandidates);
  const featureRerankedCandidates = applyFeatureRerank(rankedCandidates, supplementaryData);
  const prioritizedCandidates = prioritizeStrongLexicalDeliveryWindowCandidates(
    featureRerankedCandidates,
    supplementaryData,
    config.budgets.max_entries
  );
  const coverageOrderedCandidates = applySessionCoverageRerank(
    prioritizedCandidates,
    config.budgets.max_entries
  );
  const synthesisReservedCandidates = reserveSynthesisDeliverySlots(
    coverageOrderedCandidates,
    supplementaryData,
    config.budgets.max_entries
  );
  const deliveryOrderedCandidates = reserveStructuralDeliverySlots(
    synthesisReservedCandidates,
    supplementaryData,
    config.budgets.max_entries,
    synthesisReserveCount(coverageOrderedCandidates, config.budgets.max_entries)
  );

  // Per-stage delivery-rank capture (1-based). Each fineAssess stage reorders
  // the full set without dropping, so a candidate's index per stage shows the
  // step at which it left the top-k window. Diagnostic-only.
  const buildStageRankMap = (
    ordered: readonly Readonly<CoarseRecallCandidate>[]
  ): ReadonlyMap<string, number> => {
    const ranks = new Map<string, number>();
    ordered.forEach((item, index) => {
      ranks.set(buildRecallCandidateDedupeKey(item), index + 1);
    });
    return ranks;
  };
  const rankAfterFusion = buildStageRankMap(rankedCandidates);
  const rankAfterFeatureRerank = buildStageRankMap(featureRerankedCandidates);
  const rankAfterLexicalPriority = buildStageRankMap(prioritizedCandidates);
  const rankAfterSynthesisReserve = buildStageRankMap(synthesisReservedCandidates);
  const rankAfterStructuralReserve = buildStageRankMap(deliveryOrderedCandidates);

  type FineAssessmentAccumulator = {
    readonly selected: readonly Readonly<RecallCandidate>[];
    readonly diagnostics: readonly Readonly<RecallCandidateDiagnostic>[];
    readonly seen: ReadonlySet<string>;
    readonly perDimensionCounts: ReadonlyMap<MemoryDimensionType, number>;
    readonly totalTokens: number;
  };

  const initialAccumulator: FineAssessmentAccumulator = {
    selected: Object.freeze([]),
    diagnostics: Object.freeze([]),
    seen: new Set<string>(),
    perDimensionCounts: new Map<MemoryDimensionType, number>(),
    totalTokens: 0
  };

  const appendCandidate = (
    accumulator: FineAssessmentAccumulator,
    candidate: Readonly<CoarseRecallCandidate & {
      readonly effectiveScore: number;
      readonly effectiveFactors: RecallScoreFactors;
      readonly fusion: RecallFusionBreakdown;
    }>,
    selectionOrder: number
  ): FineAssessmentAccumulator => {
    const entry = candidate.entry;
    const objectKind = candidate.objectKind ?? "memory_entry";
    const candidateKey = buildRecallCandidateDedupeKey(candidate);
    const originPlane = candidate.originPlane ?? "workspace_local";
    const scoreFactors = candidate.effectiveFactors;
    const createDiagnostic = (
      droppedReason: RecallCandidateDropReason | null,
      finalRank: number | null
    ): Readonly<RecallCandidateDiagnostic> => {
      const admissionPlanes = Object.freeze([...(candidate.admissionPlanes ?? ["activation"])]);
      const attributionPlane = selectRecallAdmissionAttributionPlane(
        admissionPlanes,
        candidate.firstAdmissionPlane
      );
      const maxEntries = config.budgets.max_entries;
      const rankAfterLex = rankAfterLexicalPriority.get(candidateKey);
      const rankAfterSyn = rankAfterSynthesisReserve.get(candidateKey);
      const rankAfterStruct = rankAfterStructuralReserve.get(candidateKey);
      // A candidate is "reserved" by the stage that first pulled it inside the
      // top-k window it was outside of after lexical priority.
      const reservedBy: "none" | "synthesis" | "structural" =
        rankAfterSyn !== undefined && rankAfterSyn <= maxEntries &&
        (rankAfterLex === undefined || rankAfterLex > maxEntries)
          ? "synthesis"
          : rankAfterStruct !== undefined && rankAfterStruct <= maxEntries &&
            (rankAfterSyn === undefined || rankAfterSyn > maxEntries)
            ? "structural"
            : "none";
      return Object.freeze({
        candidate_key: candidateKey,
        object_id: entry.object_id,
        object_kind: objectKind,
        dimension: entry.dimension,
        origin_plane: originPlane,
        admission_planes: admissionPlanes,
        plane_first_admitted: candidate.firstAdmissionPlane ?? admissionPlanes[0] ?? "activation",
        plane_winning_admission: attributionPlane,
        pre_budget_rank: candidate.fusion.fused_rank,
        selection_order: selectionOrder,
        fused_rank: candidate.fusion.fused_rank,
        fused_score: candidate.fusion.fused_score,
        per_stream_rank: candidate.fusion.per_stream_rank,
        fused_rank_contribution_per_stream: candidate.fusion.fused_rank_contribution_per_stream,
        final_rank: finalRank,
        dropped_reason: droppedReason,
        within_budget: droppedReason === null,
        relevance_score: candidate.effectiveScore,
        lexical_rank: candidate.objectKind === "synthesis_capsule"
          ? supplementaryData.synthesisFtsRanks[entry.object_id] ?? null
          : supplementaryData.ftsRanks[entry.object_id] ?? null,
        structural_score: clamp01(candidate.structuralScore ?? supplementaryData.structuralScores[entry.object_id] ?? 0),
        score_factors: scoreFactors,
        source_channels: Object.freeze(uniqueStrings([
          candidate.originPlane ?? "workspace_local",
          candidate.sourceChannel ?? "",
          ...(candidate.sourceChannels ?? []),
          ...((scoreFactors.embedding_similarity ?? 0) > 0 ? ["semantic_supplement"] : []),
          ...(admissionPlanes).map((plane) => `plane:${plane}`)
        ].filter((channel) => channel.length > 0))),
        path_expansion_sources: Object.freeze([...(candidate.pathExpansionSources ?? [])]),
        rank_after_fusion: rankAfterFusion.get(candidateKey),
        rank_after_feature_rerank: rankAfterFeatureRerank.get(candidateKey),
        rank_after_lexical_priority: rankAfterLex,
        rank_after_synthesis_reserve: rankAfterSyn,
        rank_after_structural_reserve: rankAfterStruct,
        reserved_by: reservedBy
      });
    };

    if (accumulator.seen.has(candidateKey)) {
      return {
        ...accumulator,
        diagnostics: Object.freeze([
          ...accumulator.diagnostics,
          createDiagnostic("duplicate", null)
        ])
      };
    }

    const tokenEstimate = tokenEstimator.estimate(entry.content);
    const dimensionCount = accumulator.perDimensionCounts.get(entry.dimension) ?? 0;
    const dimensionLimit = config.budgets.per_dimension_limits?.[entry.dimension] ?? null;
    const nextEntryCount = accumulator.selected.length + 1;
    const nextTokenCount = accumulator.totalTokens + tokenEstimate;

    if (dimensionLimit !== null && dimensionCount >= dimensionLimit) {
      return {
        ...accumulator,
        diagnostics: Object.freeze([
          ...accumulator.diagnostics,
          createDiagnostic("dimension_limit", null)
        ])
      };
    }

    if (nextEntryCount > config.budgets.max_entries) {
      return {
        ...accumulator,
        diagnostics: Object.freeze([
          ...accumulator.diagnostics,
          createDiagnostic("max_entries", null)
        ])
      };
    }

    if (nextTokenCount > config.budgets.max_total_tokens) {
      return {
        ...accumulator,
        diagnostics: Object.freeze([
          ...accumulator.diagnostics,
          createDiagnostic("max_total_tokens", null)
        ])
      };
    }

    const nextCandidate = buildRecallCandidate({
      candidate,
      relevanceScore: candidate.effectiveScore,
      scoreFactors,
      tokenEstimator,
      tokenEstimate,
      budgets: config.budgets,
      index: accumulator.selected.length,
      usedTokensBeforeCandidate: accumulator.totalTokens,
      // governance HARD CEILING; absent => unrestricted (full_eligible).
      // see also: collectGovernanceCeilings, path-manifestation-policy.ts.
      governanceCeiling: supplementaryData.governanceCeilingByMemoryId[entry.object_id]
    });

    return {
      selected: Object.freeze([...accumulator.selected, nextCandidate]),
      diagnostics: Object.freeze([
        ...accumulator.diagnostics,
        createDiagnostic(null, accumulator.selected.length + 1)
      ]),
      seen: new Set([...accumulator.seen, candidateKey]),
      perDimensionCounts: new Map([
        ...accumulator.perDimensionCounts,
        [entry.dimension, dimensionCount + 1]
      ]),
      totalTokens: nextTokenCount
    };
  };

  const finalAccumulator = deliveryOrderedCandidates.reduce(
    (accumulator, candidate, index) => appendCandidate(accumulator, candidate, index + 1),
    initialAccumulator
  );

  return Object.freeze({
    candidates: Object.freeze([...finalAccumulator.selected]),
    diagnostics: Object.freeze([...finalAccumulator.diagnostics])
  });

}
