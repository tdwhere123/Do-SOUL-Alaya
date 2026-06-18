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
import { applyCoverageDeliverySelection } from "./coverage-delivery.js";
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
  // Coverage selector (default-off): rewrites the top-K from the top-M pool to
  // cover buried second-session/source/evidence gold; no-op when disabled, so
  // the window rerank below still owns the enabled-off path byte-for-byte.
  const coverageSelectedCandidates = applyCoverageDeliverySelection(
    prioritizedCandidates,
    supplementaryData,
    config.budgets.max_entries
  );
  const coverageOrderedCandidates = applySessionCoverageRerank(
    coverageSelectedCandidates,
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
  const rankAfterCoverageSelector = buildStageRankMap(coverageSelectedCandidates);
  const rankAfterSessionCoverage = buildStageRankMap(coverageOrderedCandidates);
  const rankAfterSynthesisReserve = buildStageRankMap(synthesisReservedCandidates);
  const rankAfterStructuralReserve = buildStageRankMap(deliveryOrderedCandidates);
  // Both stages return the input array by reference when they no-op, so a same
  // reference proves the stage did not run for this recall.
  const coverageSelectorNoop = coverageSelectedCandidates === prioritizedCandidates;
  const sessionCoverageNoop = coverageOrderedCandidates === coverageSelectedCandidates;
  const deliveryStageAction = (
    before: number | undefined,
    after: number | undefined,
    nooped: boolean
  ): "noop" | "kept" | "promoted" | "displaced" => {
    if (nooped) {
      return "noop";
    }
    if (before === undefined || after === undefined || before === after) {
      return "kept";
    }
    return after < before ? "promoted" : "displaced";
  };
  const sessionKeyOf = (entry: Readonly<CoarseRecallCandidate["entry"]>): string =>
    entry.surface_id ?? entry.run_id ?? "<no-session>";

  type FineAssessmentAccumulator = {
    readonly selected: Readonly<RecallCandidate>[];
    readonly diagnostics: Readonly<RecallCandidateDiagnostic>[];
    readonly seen: Set<string>;
    readonly perDimensionCounts: Map<MemoryDimensionType, number>;
    totalTokens: number;
  };

  const initialAccumulator: FineAssessmentAccumulator = {
    selected: [],
    diagnostics: [],
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
      const rankAfterCoverage = rankAfterCoverageSelector.get(candidateKey);
      const rankAfterSession = rankAfterSessionCoverage.get(candidateKey);
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
        rank_after_coverage_selector: rankAfterCoverage,
        rank_after_session_coverage: rankAfterSession,
        coverage_selector_action: deliveryStageAction(
          rankAfterLex,
          rankAfterCoverage,
          coverageSelectorNoop
        ),
        session_coverage_action: deliveryStageAction(
          rankAfterCoverage,
          rankAfterSession,
          sessionCoverageNoop
        ),
        session_key: sessionKeyOf(entry),
        source_cohort_key: supplementaryData.sourceCohortKeys[entry.object_id] ?? null,
        rank_after_synthesis_reserve: rankAfterSyn,
        rank_after_structural_reserve: rankAfterStruct,
        reserved_by: reservedBy
      });
    };

    if (accumulator.seen.has(candidateKey)) {
      accumulator.diagnostics.push(createDiagnostic("duplicate", null));
      return accumulator;
    }

    const tokenEstimate = tokenEstimator.estimate(entry.content);
    const dimensionCount = accumulator.perDimensionCounts.get(entry.dimension) ?? 0;
    const dimensionLimit = config.budgets.per_dimension_limits?.[entry.dimension] ?? null;
    const nextEntryCount = accumulator.selected.length + 1;
    const nextTokenCount = accumulator.totalTokens + tokenEstimate;

    if (dimensionLimit !== null && dimensionCount >= dimensionLimit) {
      accumulator.diagnostics.push(createDiagnostic("dimension_limit", null));
      return accumulator;
    }

    if (nextEntryCount > config.budgets.max_entries) {
      accumulator.diagnostics.push(createDiagnostic("max_entries", null));
      return accumulator;
    }

    if (nextTokenCount > config.budgets.max_total_tokens) {
      accumulator.diagnostics.push(createDiagnostic("max_total_tokens", null));
      return accumulator;
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

    accumulator.selected.push(nextCandidate);
    accumulator.diagnostics.push(createDiagnostic(null, accumulator.selected.length));
    accumulator.seen.add(candidateKey);
    accumulator.perDimensionCounts.set(entry.dimension, dimensionCount + 1);
    accumulator.totalTokens = nextTokenCount;
    return accumulator;
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
