import type {
  DiagnosticActiveConstraintResult,
  DiagnosticRecallResult,
  DiagnosticRecallResultInput,
  LongMemEvalGoldDiagnostic,
  LongMemEvalQuestionDiagnostic,
  NarrowRecallDiagnostics,
  ProviderStateSummary
} from "./diagnostics-types.js";
import {
  buildObjectIdentityKey,
  createEmptyGraphExpansionPlaneCountPerEdgeType,
  createEmptyGraphExpansionPlaneCountPerHop,
  hasStructuralPlane,
  isDeliveryBudgetLoss,
  isLongMemEvalGoldEligibleDiagnosticResult,
  readRecallDiagnostics
} from "./diagnostics-private.js";

export function buildQuestionDiagnostic(input: {
  readonly questionId: string;
  readonly goldMemoryIds: readonly string[];
  readonly answerSessionIds: readonly string[];
  readonly deliveredResults: readonly DiagnosticRecallResultInput[];
  readonly activeConstraintResults?: readonly DiagnosticActiveConstraintResult[];
  readonly hitAt1: boolean;
  readonly hitAt5: boolean;
  readonly hitAt10: boolean;
  // True for LongMemEval abstention questions (`question_id` ending
  // `_abs`): the hit booleans then carry the calibrated-confidence verdict
  // and miss classification is `abstained_correctly` /
  // `abstain_false_confident` instead of `no_gold`.
  readonly isAbstention?: boolean;
  readonly degradationReason: string | null;
  readonly recallResult: unknown;
  readonly embeddingMode: "disabled" | "env";
  readonly roundIndex?: number;
}): LongMemEvalQuestionDiagnostic {
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

  return {
    question_id: input.questionId,
    round_index: input.roundIndex ?? null,
    gold_memory_ids: input.goldMemoryIds,
    answer_session_ids: input.answerSessionIds,
    delivered_results: deliveredResults,
    active_constraint_results: activeConstraintResults,
    hit_at_1: input.hitAt1,
    hit_at_5: input.hitAt5,
    hit_at_10: input.hitAt10,
    miss_classification: classifyMiss(
      input.hitAt5,
      gold,
      diagnostics !== null,
      input.isAbstention === true
    ),
    degradation_reason: input.degradationReason,
    recall_diagnostics_present: diagnostics !== null,
    recall_diagnostics_keys: diagnostics?.keys ?? [],
    ...(diagnostics?.phaseLatencyMs === null || diagnostics?.phaseLatencyMs === undefined
      ? {}
      : { phase_latency_ms: diagnostics.phaseLatencyMs }),
    provider_state:
      diagnostics?.providerState ??
      (input.embeddingMode === "disabled" ? "provider_not_requested" : "unknown"),
    provider_degradation_reason: diagnostics?.providerDegradationReason ?? null,
    graph_expansion_plane_count_per_hop:
      diagnostics?.graphExpansionPlaneCountPerHop ??
      createEmptyGraphExpansionPlaneCountPerHop(),
    graph_expansion_plane_count_per_edge_type:
      diagnostics?.graphExpansionPlaneCountPerEdgeType ??
      createEmptyGraphExpansionPlaneCountPerEdgeType(),
    candidate_key_collisions: buildCandidateKeyCollisions(diagnostics),
    gold
  };
}

function buildGoldDiagnostics(input: {
  readonly goldMemoryIds: readonly string[];
  readonly deliveredRankById: ReadonlyMap<string, number>;
  readonly activeConstraintRankById: ReadonlyMap<string, number>;
  readonly diagnostics: NarrowRecallDiagnostics | null;
}): LongMemEvalGoldDiagnostic[] {
  const { deliveredRankById, activeConstraintRankById, diagnostics } = input;
  return input.goldMemoryIds.map((objectId): LongMemEvalGoldDiagnostic => {
    const deliveredRank = deliveredRankById.get(objectId) ?? null;
    const activeConstraintRank = activeConstraintRankById.get(objectId) ?? null;
    const candidate = diagnostics?.candidatesByObjectIdentity.get(
      buildObjectIdentityKey("memory_entry", objectId)
    );
    const candidateStatus =
      deliveredRank !== null
        ? "delivered"
        : activeConstraintRank !== null
          ? "active_constraint_delivered"
          : candidate !== undefined
            ? "candidate_not_delivered"
            : diagnostics === null
              ? "unknown"
              : "candidate_absent";
    return {
      object_id: objectId,
      candidate_status: candidateStatus,
      dimension: candidate?.dimension ?? null,
      final_rank: deliveredRank,
      active_constraint_rank: activeConstraintRank,
      pre_budget_rank: candidate?.preBudgetRank ?? null,
      selection_order: candidate?.selectionOrder ?? null,
      fused_rank: candidate?.fusedRank ?? null,
      fused_score: candidate?.fusedScore ?? null,
      per_stream_rank: candidate?.perStreamRank ?? null,
      fused_rank_contribution_per_stream:
        candidate?.fusedRankContributionPerStream ?? null,
      plane_first_admitted: candidate?.planeFirstAdmitted ?? null,
      plane_winning_admission: candidate?.planeWinningAdmission ?? null,
      source_planes: candidate?.sourcePlanes ?? [],
      lexical_rank: candidate?.lexicalRank ?? null,
      structural_score: candidate?.structuralScore ?? null,
      score_factors: candidate?.scoreFactors ?? null,
      source_channels: candidate?.sourceChannels ?? [],
      budget_drop_reason: candidate?.budgetDropReason ?? null,
      rank_after_fusion: candidate?.rankAfterFusion ?? null,
      rank_after_feature_rerank: candidate?.rankAfterFeatureRerank ?? null,
      rank_after_lexical_priority: candidate?.rankAfterLexicalPriority ?? null,
      rank_after_synthesis_reserve: candidate?.rankAfterSynthesisReserve ?? null,
      rank_after_structural_reserve: candidate?.rankAfterStructuralReserve ?? null,
      rank_after_coverage_selector: candidate?.rankAfterCoverageSelector ?? null,
      rank_after_session_coverage: candidate?.rankAfterSessionCoverage ?? null,
      coverage_selector_action: candidate?.coverageSelectorAction ?? null,
      session_coverage_action: candidate?.sessionCoverageAction ?? null,
      session_key: candidate?.sessionKey ?? null,
      source_cohort_key: candidate?.sourceCohortKey ?? null,
      reserved_by: candidate?.reservedBy ?? null
    };
  });
}

function buildCandidateKeyCollisions(
  diagnostics: NarrowRecallDiagnostics | null
): LongMemEvalQuestionDiagnostic["candidate_key_collisions"] {
  if (diagnostics === null) {
    return [];
  }
  return [...diagnostics.candidateKeysByObjectId.entries()]
    .filter(([, candidateKeys]) => candidateKeys.length > 1)
    .map(([objectId, candidateKeys]) => ({
      object_id: objectId,
      candidate_keys: candidateKeys
    }));
}

function normalizeDeliveredResults(
  deliveredResults: readonly DiagnosticRecallResultInput[],
  diagnostics: NarrowRecallDiagnostics | null
): readonly DiagnosticRecallResult[] {
  return deliveredResults.map((result): DiagnosticRecallResult => {
    const objectKind = result.object_kind ?? "memory_entry";
    const candidate = diagnostics?.candidatesByObjectIdentity.get(
      buildObjectIdentityKey(objectKind, result.object_id)
    );
    return {
      object_id: result.object_id,
      ...(objectKind === "memory_entry" ? {} : { object_kind: objectKind }),
      dimension: candidate?.dimension ?? null,
      rank: result.rank,
      relevance_score: result.relevance_score,
      fused_rank: result.fused_rank ?? candidate?.fusedRank ?? null,
      fused_score: candidate?.fusedScore ?? null,
      per_stream_rank: candidate?.perStreamRank ?? null,
      fused_rank_contribution_per_stream:
        candidate?.fusedRankContributionPerStream ?? null,
      plane_first_admitted:
        result.plane_first_admitted ?? candidate?.planeFirstAdmitted ?? null,
      plane_winning_admission:
        result.plane_winning_admission ?? candidate?.planeWinningAdmission ?? null,
      score_factors:
        result.score_factors ?? candidate?.scoreFactors ?? null
    };
  });
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

function classifyMiss(
  hitAt5: boolean,
  gold: readonly LongMemEvalGoldDiagnostic[],
  diagnosticsAvailable: boolean,
  isAbstention: boolean
): LongMemEvalQuestionDiagnostic["miss_classification"] {
  // Abstention questions have no gold and never produce an id-equality
  // hit; `hitAt5` here carries the calibrated correct-at-5 verdict, so the
  // classification is purely "did recall stay unconfident".
  if (isAbstention) {
    return hitAt5 ? "abstained_correctly" : "abstain_false_confident";
  }
  if (hitAt5) return "hit_at_5";
  if (!diagnosticsAvailable) return "diagnostics_unavailable";
  if (gold.length === 0) return "no_gold";
  if (gold.some(isDeliveryBudgetLoss)) {
    return "budget_dropped";
  }
  if (
    gold.some(
      (item) =>
        (item.final_rank !== null && item.final_rank > 5) ||
        item.pre_budget_rank !== null ||
        item.fused_rank !== null
    )
  ) {
    return "under_ranked";
  }
  if (
    gold.some(
      (item) => item.candidate_status === "active_constraint_delivered"
    )
  ) {
    return "active_constraint_only";
  }
  const notDelivered = gold.filter(
    (item) => item.candidate_status === "candidate_not_delivered"
  );
  if (notDelivered.some((item) => !item.source_planes.includes("lexical"))) {
    return "lexical_gap";
  }
  if (notDelivered.some((item) => !hasStructuralPlane(item.source_planes))) {
    return "structural_gap";
  }
  return "candidate_absent";
}

function ratio(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}
