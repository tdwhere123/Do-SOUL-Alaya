import { attachAbstentionConfidenceScore } from "./abstention-confidence.js";
import type {
  DiagnosticActiveConstraintResult,
  DiagnosticRecallResult,
  DiagnosticRecallResultInput,
  CandidateDiagnostic,
  LongMemEvalReplayCandidate,
  LongMemEvalQuestionDiagnostic,
  NarrowRecallDiagnostics,
  ProviderStateSummary
} from "./diagnostics-types.js";
import {
  buildObjectIdentityKey,
  isLongMemEvalGoldEligibleDiagnosticResult,
  readRecallDiagnostics
} from "./diagnostics-private.js";
import { buildGoldDiagnostics } from "./diagnostics/gold-diagnostics.js";
import {
  assembleQuestionDiagnostic,
  type QuestionDiagnosticInput
} from "./diagnostics/question-assembly.js";

export function buildQuestionDiagnostic(
  input: QuestionDiagnosticInput
): LongMemEvalQuestionDiagnostic {
  const diagnostics = readRecallDiagnostics(input.recallResult, input.embeddingMode);
  const deliveredResults = normalizeDeliveredResults(
    input.deliveredResults,
    diagnostics
  );
  const deliveredRankById = new Map(
    deliveredResults
      .filter(isLongMemEvalGoldEligibleDiagnosticResult)
      .map((result) => [result.object_id, result.rank] as const)
  );
  const activeConstraintResults = input.activeConstraintResults ?? [];
  const activeConstraintRankById = new Map(
    activeConstraintResults.map((result) => [result.object_id, result.rank])
  );
  const gold = buildGoldDiagnostics({
    goldMemoryIds: input.goldMemoryIds,
    deliveredRankById,
    activeConstraintRankById,
    diagnostics
  });
  const candidates = diagnostics === null ? [] : buildReplayCandidates(diagnostics);
  return assembleQuestionDiagnostic(input, {
    diagnostics,
    deliveredResults,
    activeConstraintResults,
    gold,
    candidates
  });
}

function buildReplayCandidates(
  diagnostics: NarrowRecallDiagnostics
): readonly LongMemEvalReplayCandidate[] {
  return [...diagnostics.candidatesByCandidateKey.values()]
    .sort(compareReplayCandidateDiagnostics)
    .map((candidate): LongMemEvalReplayCandidate => ({
      object_id: candidate.objectId,
      ...(candidate.objectKind === "memory_entry"
        ? {}
        : { object_kind: candidate.objectKind }),
      candidate_key: candidate.candidateKey,
      dimension: candidate.dimension,
      final_rank: candidate.finalRank,
      pre_budget_rank: candidate.preBudgetRank,
      selection_order: candidate.selectionOrder,
      fused_rank: candidate.fusedRank,
      fused_score: candidate.fusedScore,
      per_stream_rank: candidate.perStreamRank,
      fused_rank_contribution_per_stream:
        candidate.fusedRankContributionPerStream,
      per_axis_rank: candidate.perAxisRank,
      per_axis_contribution: candidate.perAxisContribution,
      flood_potential: candidate.floodPotential,
      plane_first_admitted: candidate.planeFirstAdmitted,
      plane_winning_admission: candidate.planeWinningAdmission,
      source_planes: candidate.sourcePlanes,
      source_channels: candidate.sourceChannels,
      rank_after_fusion: candidate.rankAfterFusion,
      rank_after_feature_rerank: candidate.rankAfterFeatureRerank,
      rank_after_lexical_priority: candidate.rankAfterLexicalPriority,
      rank_after_synthesis_reserve: candidate.rankAfterSynthesisReserve,
      rank_after_structural_reserve: candidate.rankAfterStructuralReserve,
      rank_after_coverage_selector: candidate.rankAfterCoverageSelector,
      rank_after_session_coverage: candidate.rankAfterSessionCoverage,
      answer_features: candidate.answerFeatures,
      path_suppression_score: candidate.pathSuppressionScore,
      score_factors: {
        ...(candidate.scoreFactors ?? {}),
        ...(candidate.facetOverlap === null
          ? {}
          : { facet_overlap: candidate.facetOverlap }),
        ...(candidate.createdAt === null ? {} : { created_at: candidate.createdAt })
      }
    }));
}

function compareReplayCandidateDiagnostics(
  left: CandidateDiagnostic,
  right: CandidateDiagnostic
): number {
  const leftOrder = left.selectionOrder ?? Number.MAX_SAFE_INTEGER;
  const rightOrder = right.selectionOrder ?? Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  const leftFused = left.fusedRank ?? Number.MAX_SAFE_INTEGER;
  const rightFused = right.fusedRank ?? Number.MAX_SAFE_INTEGER;
  if (leftFused !== rightFused) return leftFused - rightFused;
  return left.candidateKey.localeCompare(right.candidateKey);
}

function normalizeDeliveredResults(
  deliveredResults: readonly DiagnosticRecallResultInput[],
  diagnostics: NarrowRecallDiagnostics | null
): readonly DiagnosticRecallResult[] {
  const joined = deliveredResults.map((result): DiagnosticRecallResult => {
    const objectKind = result.object_kind ?? "memory_entry";
    const candidate = diagnostics?.candidatesByObjectIdentity.get(
      buildObjectIdentityKey(objectKind, result.object_id)
    );
    const fusedScore = result.fused_score ?? candidate?.fusedScore ?? null;
    const confidence =
      result.abstention_confidence_score !== undefined
        ? result.abstention_confidence_score
        : null;
    return {
      object_id: result.object_id,
      ...(objectKind === "memory_entry" ? {} : { object_kind: objectKind }),
      dimension: candidate?.dimension ?? null,
      rank: result.rank,
      relevance_score: result.relevance_score,
      fused_rank: result.fused_rank ?? candidate?.fusedRank ?? null,
      fused_score: fusedScore,
      abstention_confidence_score: confidence,
      per_stream_rank: candidate?.perStreamRank ?? null,
      fused_rank_contribution_per_stream:
        candidate?.fusedRankContributionPerStream ?? null,
      per_axis_rank: result.per_axis_rank ?? candidate?.perAxisRank ?? null,
      per_axis_contribution:
        result.per_axis_contribution ?? candidate?.perAxisContribution ?? null,
      flood_potential: result.flood_potential ?? candidate?.floodPotential ?? null,
      flood_fuel_coverage:
        result.flood_fuel_coverage ?? candidate?.floodFuelCoverage ?? null,
      plane_first_admitted:
        result.plane_first_admitted ?? candidate?.planeFirstAdmitted ?? null,
      plane_winning_admission:
        result.plane_winning_admission ?? candidate?.planeWinningAdmission ?? null,
      score_factors:
        result.score_factors ?? candidate?.scoreFactors ?? null
    };
  });
  return attachAbstentionConfidenceScore(joined);
}

export function summarizeProviderStates(
  diagnostics: readonly LongMemEvalQuestionDiagnostic[]
): ProviderStateSummary {
  let providerReturned = 0;
  let providerPending = 0;
  let providerFailed = 0;
  let providerNotRequested = 0;
  let unknown = 0;
  for (const row of diagnostics) {
    if (row.provider_state === "provider_returned") providerReturned++;
    else if (row.provider_state === "provider_pending") providerPending++;
    else if (row.provider_state === "provider_failed") providerFailed++;
    else if (row.provider_state === "provider_not_requested") providerNotRequested++;
    else unknown++;
  }
  const total = diagnostics.length;
  return {
    total,
    provider_returned: providerReturned,
    provider_pending: providerPending,
    provider_failed: providerFailed,
    provider_not_requested: providerNotRequested,
    unknown,
    provider_returned_rate: ratio(providerReturned, total),
    provider_pending_rate: ratio(providerPending, total),
    provider_failed_rate: ratio(providerFailed, total),
    provider_not_requested_rate: ratio(providerNotRequested, total),
    unknown_rate: ratio(unknown, total)
  };
}

export function rAt5WithProviderReturned(
  diagnostics: readonly LongMemEvalQuestionDiagnostic[]
): number | undefined {
  const returned = diagnostics.filter(
    (row) => row.provider_state === "provider_returned"
  );
  if (returned.length === 0) return undefined;
  return returned.filter((row) => row.hit_at_5).length / returned.length;
}

function ratio(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}
