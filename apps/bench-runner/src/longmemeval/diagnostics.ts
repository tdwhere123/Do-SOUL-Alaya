import type { QualityMetrics } from "@do-soul/alaya-eval";
import {
  ABSTENTION_FALSE_CONFIDENT_THRESHOLD,
  isAbstentionQuestionId
} from "./abstention.js";
import {
  DiagnosticActiveConstraintResultSchema,
  DiagnosticRecallResultSchema,
  LongMemEvalGoldDiagnosticSchema,
  LongMemEvalQuestionDiagnosticSchema
} from "./diagnostics-schema.js";
import type { z } from "zod";

const DELIVERY_BUDGET_LOSS_RANK = 10;

export type BenchEmbeddingProviderState =
  | "provider_returned"
  | "provider_pending"
  | "provider_failed"
  | "provider_not_requested"
  | "unknown";

// @anchor diagnostics-schema: the persisted shape of these records is owned
// by diagnostics-schema.ts; these aliases keep one source of truth.
export type DiagnosticRecallResult = z.infer<typeof DiagnosticRecallResultSchema>;

export type DiagnosticActiveConstraintResult = z.infer<
  typeof DiagnosticActiveConstraintResultSchema
>;

interface DiagnosticRecallResultInput {
  readonly object_id: string;
  readonly object_kind?: string | null;
  readonly rank: number;
  readonly relevance_score: number;
  readonly fused_rank?: number | null;
  readonly plane_first_admitted?: string | null;
  readonly plane_winning_admission?: string | null;
  readonly score_factors?: DiagnosticScoreFactors | null;
}

export type DiagnosticScoreFactors = Readonly<Record<string, unknown>>;
export type DiagnosticStreamRanks = Readonly<Record<string, number | null>>;
export type DiagnosticStreamContributions = Readonly<Record<string, number>>;

export type LongMemEvalGoldDiagnostic = z.infer<
  typeof LongMemEvalGoldDiagnosticSchema
>;

export type LongMemEvalQuestionDiagnostic = z.infer<
  typeof LongMemEvalQuestionDiagnosticSchema
>;

export interface ProviderStateSummary {
  readonly total: number;
  readonly provider_returned: number;
  readonly provider_pending: number;
  readonly provider_failed: number;
  readonly provider_not_requested: number;
  readonly unknown: number;
  readonly provider_returned_rate: number;
  readonly provider_pending_rate: number;
  readonly provider_failed_rate: number;
  readonly provider_not_requested_rate: number;
  readonly unknown_rate: number;
}

export interface LongMemEvalEmbeddingVectorCacheSummary {
  readonly expected_count: number;
  readonly ready_count: number;
  readonly not_ready_count: number;
  readonly ready_rate: number;
  readonly max_pass_count: number;
}

export interface LongMemEvalQueryEmbeddingCacheSummary {
  readonly requested_count: number;
  readonly ready_count: number;
  readonly not_ready_count: number;
  readonly ready_rate: number;
  readonly cache_hit_count: number;
  readonly provider_requested_count: number;
  readonly last_error?: string;
}

export interface LongMemEvalReportUsageSummary {
  readonly mode: "none" | "always-used" | "gold-only" | "mixed";
  readonly reports_attempted: number;
  readonly reports_used: number;
  readonly reports_skipped: number;
  readonly used_object_count: number;
}

export interface LongMemEvalReportSideEffectSnapshot {
  readonly question_id: string;
  readonly workspace_id: string;
  // invariant: `memory_graph_edges_*` are COMPATIBILITY ALIASES of the
  // unified `path_relations` (path-plane) counts, NOT a live
  // `memory_graph_edges` table — that table is retired (migration 085).
  // Names are kept verbatim so historical bench-archive schemas stay stable;
  // do not rename. Populated from path-plane counts in runner.ts
  // (readLongMemEvalReportSideEffectSnapshot); see graph-health-service.ts.
  readonly memory_graph_edges_total: number;
  readonly memory_graph_edges_by_type: Readonly<Record<string, number>>;
  readonly recalls_edge_count: number;
  readonly path_relations_total: number;
  readonly latest_path_event_at: string | null;
  readonly warnings: readonly string[];
}

export interface LongMemEvalReportSideEffectSummary {
  readonly mode: "none" | "always-used" | "gold-only" | "mixed";
  readonly workspaces_observed: number;
  readonly memory_graph_edges_total: number;
  readonly memory_graph_edges_by_type: Readonly<Record<string, number>>;
  readonly recalls_edge_count: number;
  readonly path_relations_total: number;
  readonly latest_path_event_at: string | null;
  readonly snapshots: readonly LongMemEvalReportSideEffectSnapshot[];
}

export type LongMemEvalGraphExpansionPlaneCountPerHop = readonly [number, number];

export interface LongMemEvalGraphExpansionPlaneCountPerEdgeType {
  readonly derives_from: number;
  readonly recalls: number;
  readonly supports: number;
}

export interface LongMemEvalRecallEvidenceSummary {
  readonly delivered_result_count: number;
  readonly graph_support_gold_count: number;
  readonly path_plasticity_gold_count: number;
  readonly graph_expansion_plane_count: number;
  readonly path_expansion_plane_count: number;
  readonly graph_expansion_plane_count_per_hop: LongMemEvalGraphExpansionPlaneCountPerHop;
  readonly graph_expansion_plane_count_per_edge_type: Readonly<LongMemEvalGraphExpansionPlaneCountPerEdgeType>;
  readonly delivered_plane_counts: Readonly<{
    readonly first_admitted: Readonly<Record<string, number>>;
    readonly winning_admission: Readonly<Record<string, number>>;
  }>;
  readonly gold_source_channel_counts: Readonly<Record<string, number>>;
  readonly gold_source_plane_counts: Readonly<Record<string, number>>;
}

export interface LongMemEvalDiagnosticsSidecar {
  readonly schema_version: 1;
  readonly bench_name: "public" | "public-multiturn" | "public-crossquestion" | "public-locomo";
  readonly split: string;
  readonly run_at: string;
  readonly alaya_commit: string;
  readonly recall_pipeline_version?: string;
  readonly embedding_provider: string;
  readonly embedding_mode: "disabled" | "env";
  readonly policy_shape?: "stress" | "chat";
  readonly simulate_report?: "none" | "always-used" | "gold-only" | "mixed";
  readonly report_usage?: LongMemEvalReportUsageSummary;
  readonly report_side_effects?: LongMemEvalReportSideEffectSummary;
  readonly scored_recall_evidence?: LongMemEvalRecallEvidenceSummary;
  readonly embedding_vector_cache?: LongMemEvalEmbeddingVectorCacheSummary;
  readonly query_embedding_cache?: LongMemEvalQueryEmbeddingCacheSummary;
  readonly provider_state_summary: ProviderStateSummary;
  readonly questions: readonly LongMemEvalQuestionDiagnostic[];
}

export interface LongMemEvalCompactDiagnosticsSidecar {
  readonly schema_version: 1;
  readonly compact_schema_version: 1;
  readonly bench_name: LongMemEvalDiagnosticsSidecar["bench_name"];
  readonly split: string;
  readonly run_at: string;
  readonly alaya_commit: string;
  readonly recall_pipeline_version?: string;
  readonly embedding_provider: string;
  readonly embedding_mode: "disabled" | "env";
  readonly policy_shape?: "stress" | "chat";
  readonly simulate_report?: "none" | "always-used" | "gold-only" | "mixed";
  readonly question_count: number;
  readonly full_diagnostics_artifact_path: string;
  readonly provider_state_summary: ProviderStateSummary;
  readonly report_usage?: LongMemEvalReportUsageSummary;
  readonly report_side_effects?: Omit<LongMemEvalReportSideEffectSummary, "snapshots"> & {
    readonly snapshot_count: number;
  };
  readonly scored_recall_evidence?: LongMemEvalRecallEvidenceSummary;
  readonly embedding_vector_cache?: LongMemEvalEmbeddingVectorCacheSummary;
  readonly query_embedding_cache?: LongMemEvalQueryEmbeddingCacheSummary;
}

interface NarrowRecallDiagnostics {
  readonly keys: readonly string[];
  readonly candidatesByObjectId: ReadonlyMap<string, CandidateDiagnostic>;
  readonly candidatesByObjectIdentity: ReadonlyMap<string, CandidateDiagnostic>;
  readonly candidatesByCandidateKey: ReadonlyMap<string, CandidateDiagnostic>;
  readonly candidateKeysByObjectId: ReadonlyMap<string, readonly string[]>;
  readonly providerState: BenchEmbeddingProviderState;
  readonly providerDegradationReason: string | null;
  readonly graphExpansionPlaneCountPerHop: LongMemEvalGraphExpansionPlaneCountPerHop;
  readonly graphExpansionPlaneCountPerEdgeType: Readonly<LongMemEvalGraphExpansionPlaneCountPerEdgeType>;
}

interface CandidateDiagnostic {
  readonly candidateKey: string;
  readonly objectId: string;
  readonly objectKind: string;
  readonly originPlane: string;
  readonly preBudgetRank: number | null;
  readonly selectionOrder: number | null;
  readonly finalRank: number | null;
  readonly fusedRank: number | null;
  readonly fusedScore: number | null;
  readonly perStreamRank: DiagnosticStreamRanks | null;
  readonly fusedRankContributionPerStream: DiagnosticStreamContributions | null;
  readonly planeFirstAdmitted: string | null;
  readonly planeWinningAdmission: string | null;
  readonly sourcePlanes: readonly string[];
  readonly lexicalRank: number | null;
  readonly structuralScore: number | null;
  readonly scoreFactors: DiagnosticScoreFactors | null;
  readonly sourceChannels: readonly string[];
  readonly budgetDropReason: string | null;
}

interface ReadCandidateDiagnosticsResult {
  readonly byObjectId: ReadonlyMap<string, CandidateDiagnostic>;
  readonly byObjectIdentity: ReadonlyMap<string, CandidateDiagnostic>;
  readonly byCandidateKey: ReadonlyMap<string, CandidateDiagnostic>;
  readonly keysByObjectId: ReadonlyMap<string, readonly string[]>;
}

const DIAGNOSTIC_ADMISSION_PLANES = Object.freeze([
  "protected_winner",
  "activation",
  "object_probe",
  "lexical",
  "evidence_anchor",
  "domain_tag_cluster",
  "session_surface_cohort",
  "source_proximity",
  "graph_expansion",
  "path_expansion",
  "semantic_supplement"
] as const);

// Recall admission-plane label for the multi-session cohort plane. The cohort
// fan-in attribution split (codex I2) keys on this plane to measure how the
// session cohort representative converts to delivered top-5 gold.
// see also: packages/core/src/recall-service.ts addContentDerivedExpansionCandidates.
const COHORT_PLANE = "session_surface_cohort";

const DIAGNOSTIC_SOURCE_LABELS = new Set<string>([
  ...DIAGNOSTIC_ADMISSION_PLANES,
  ...DIAGNOSTIC_ADMISSION_PLANES.map((plane) => `plane:${plane}`),
  "query_probe_lexical",
  "warm_cascade",
  "cold_cascade",
  "semantic_supplement",
  "graph_support",
  "path_plasticity",
  "ranked_recall",
  "workspace_local",
  "project",
  "global",
  "advisory",
  // Lexical-coverage source channels: word-level/exact lexical FTS,
  // deterministic query-expansion hits, and the evidence-capsule FTS join.
  // Listed so per-plane coverage counts them. The trigram substring lane is
  // a fusion stream (per_stream_rank.trigram_fts), not a source channel, so
  // it is intentionally absent here.
  "lexical",
  "lexical_expanded",
  "evidence_fts"
]);

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

  const gold = input.goldMemoryIds.map((objectId): LongMemEvalGoldDiagnostic => {
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
      budget_drop_reason: candidate?.budgetDropReason ?? null
    };
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
    candidate_key_collisions: diagnostics === null
      ? []
      : [...diagnostics.candidateKeysByObjectId.entries()]
          .filter(([, candidateKeys]) => candidateKeys.length > 1)
          .map(([objectId, candidateKeys]) => ({
            object_id: objectId,
            candidate_keys: candidateKeys
          })),
    gold
  };
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

export function buildLongMemEvalQualityMetrics(
  diagnostics: readonly LongMemEvalQuestionDiagnostic[]
): QualityMetrics {
  const missDistribution: Record<string, number> = {};
  const budgetDropCounts = new Map<string, number>();
  let nonMonotonicCount = 0;
  let nonMonotonicDenominator = 0;
  let highLexicalDemotedCount = 0;
  let highLexicalDemotedDenominator = 0;
  let candidateAbsentCount = 0;
  let noGoldCount = 0;
  let budgetDropDenominator = 0;
  let evidenceStreamGoldDeliveryCount = 0;
  let evidenceStreamGoldDeliveryDenominator = 0;
  let pathStreamTop10Count = 0;
  let pathStreamTop10Denominator = 0;
  // @anchor longmemeval-abstention: calibrated-confidence audit counters.
  let abstentionTotal = 0;
  let abstentionCorrectAt1 = 0;
  let abstentionCorrectAt5 = 0;
  let abstentionCorrectAt10 = 0;
  // invariant: per-plane recall coverage keys are driven by the gold
  // candidates' source_planes, never a hardcoded plane list.
  const planeGoldCounts = new Map<string, number>();
  const planeHitAt5Counts = new Map<string, number>();
  // Cohort fan-in attribution (codex I2). Five classes splitting how the session
  // cohort plane participates in gold delivery; see CohortAttributionSchema.
  let cohortDeliveredPlaneCount = 0;
  let cohortGoldSourcePlaneCount = 0;
  let cohortGoldFirstAdmittedCount = 0;
  let cohortGoldWinningAdmissionCount = 0;
  let cohortGoldHitAt5Count = 0;
  // Durable-edge fan-in proof instrument: how the path_expansion (direct hop-1
  // co_recalled fan-in) vs graph_expansion (multi-hop) streams carry gold into
  // top-5 SEPARATELY. The unified path plane's double-count guard credits a
  // direct 1-hop path_expansion term before any multi-hop graph_expansion term,
  // so a gold bearing both is attributed path-primary. graph_only isolates gold
  // that reached top-5 purely via multi-hop. This is the load-bearing signal
  // that the retired session_cohort_fanin heuristic was replaced by the durable
  // co_recalled PathRelation carrier. see also: PathVsGraphFaninSchema.
  let pathFaninGoldSourceCount = 0;
  let pathFaninGoldHitAt5Count = 0;
  let graphFaninGoldSourceCount = 0;
  let graphFaninGoldHitAt5Count = 0;
  let pathPrimaryGoldHitAt5Count = 0;
  let graphOnlyGoldHitAt5Count = 0;

  for (const question of diagnostics) {
    missDistribution[question.miss_classification] =
      (missDistribution[question.miss_classification] ?? 0) + 1;
    if (question.miss_classification === "candidate_absent") {
      candidateAbsentCount++;
    }
    if (question.miss_classification === "no_gold") {
      noGoldCount++;
    }
    if (isAbstentionQuestionId(question.question_id)) {
      abstentionTotal++;
      if (question.hit_at_1) abstentionCorrectAt1++;
      if (question.hit_at_5) abstentionCorrectAt5++;
      if (question.hit_at_10) abstentionCorrectAt10++;
    }

    if (question.delivered_results.length >= 2) {
      nonMonotonicDenominator++;
      if (isDeliveredOrderNonMonotonic(question.delivered_results)) {
        nonMonotonicCount++;
      }
    }

    for (const delivered of question.delivered_results) {
      pathStreamTop10Denominator++;
      if (hasPathStreamContribution(delivered)) {
        pathStreamTop10Count++;
      }
      if (
        delivered.plane_first_admitted === COHORT_PLANE ||
        delivered.plane_winning_admission === COHORT_PLANE
      ) {
        cohortDeliveredPlaneCount++;
      }
    }

    for (const gold of question.gold) {
      budgetDropDenominator++;
      const goldHitAt5 = gold.final_rank !== null && gold.final_rank <= 5;
      for (const plane of new Set(gold.source_planes)) {
        planeGoldCounts.set(plane, (planeGoldCounts.get(plane) ?? 0) + 1);
        if (goldHitAt5) {
          planeHitAt5Counts.set(
            plane,
            (planeHitAt5Counts.get(plane) ?? 0) + 1
          );
        }
      }
      if (gold.source_planes.includes(COHORT_PLANE)) {
        cohortGoldSourcePlaneCount++;
        if (goldHitAt5) {
          cohortGoldHitAt5Count++;
        }
      }
      if (gold.plane_first_admitted === COHORT_PLANE) {
        cohortGoldFirstAdmittedCount++;
      }
      if (gold.plane_winning_admission === COHORT_PLANE) {
        cohortGoldWinningAdmissionCount++;
      }
      const bearsPathFanin = hasGoldPathExpansionStream(gold);
      const bearsGraphFanin = hasGoldGraphExpansionStream(gold);
      if (bearsPathFanin) {
        pathFaninGoldSourceCount++;
        if (goldHitAt5) {
          pathFaninGoldHitAt5Count++;
          // Double-count guard: a gold bearing the direct hop-1 path_expansion
          // term is attributed path-primary even if it also bears graph_expansion.
          pathPrimaryGoldHitAt5Count++;
        }
      }
      if (bearsGraphFanin) {
        graphFaninGoldSourceCount++;
        if (goldHitAt5) {
          graphFaninGoldHitAt5Count++;
          if (!bearsPathFanin) {
            graphOnlyGoldHitAt5Count++;
          }
        }
      }
      if (isDeliveryBudgetLoss(gold)) {
        const dropReason = gold.budget_drop_reason;
        if (dropReason === null) continue;
        budgetDropCounts.set(
          dropReason,
          (budgetDropCounts.get(dropReason) ?? 0) + 1
        );
      }
      if (gold.lexical_rank !== null && gold.final_rank !== null) {
        highLexicalDemotedDenominator++;
        if (gold.lexical_rank > 0.8 && gold.final_rank > 5) {
          highLexicalDemotedCount++;
        }
      }
      if (gold.final_rank !== null && gold.final_rank <= 5) {
        evidenceStreamGoldDeliveryDenominator++;
        if (hasEvidenceStreamContribution(gold)) {
          evidenceStreamGoldDeliveryCount++;
        }
      }
    }
  }

  const questionDenominator = diagnostics.length;
  if (!budgetDropCounts.has("max_entries")) {
    budgetDropCounts.set("max_entries", 0);
  }
  return {
    schema_version: "bench-quality-metrics.v1",
    non_monotonic_rate: ratio(nonMonotonicCount, questionDenominator),
    non_monotonic_count: nonMonotonicCount,
    non_monotonic_denominator: questionDenominator,
    budget_drop_distribution: Object.fromEntries(
      [...budgetDropCounts.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([key, count]) => [
          key,
          {
            count,
            share: ratio(count, budgetDropDenominator),
            denominator: budgetDropDenominator
          }
        ])
    ),
    high_lexical_demoted_rate: ratio(
      highLexicalDemotedCount,
      highLexicalDemotedDenominator
    ),
    high_lexical_demoted_count: highLexicalDemotedCount,
    high_lexical_demoted_denominator: highLexicalDemotedDenominator,
    candidate_absent_count: candidateAbsentCount,
    candidate_absent_denominator: questionDenominator,
    no_gold_count: noGoldCount,
    no_gold_denominator: questionDenominator,
    evidence_stream_gold_delivery_rate: ratio(
      evidenceStreamGoldDeliveryCount,
      evidenceStreamGoldDeliveryDenominator
    ),
    evidence_stream_gold_delivery_count: evidenceStreamGoldDeliveryCount,
    evidence_stream_gold_delivery_denominator: evidenceStreamGoldDeliveryDenominator,
    path_stream_top10_rate: ratio(pathStreamTop10Count, pathStreamTop10Denominator),
    path_stream_top10_count: pathStreamTop10Count,
    path_stream_top10_denominator: pathStreamTop10Denominator,
    per_plane_recall_coverage: buildPerPlaneRecallCoverage(
      planeGoldCounts,
      planeHitAt5Counts
    ),
    cohort_attribution: {
      delivered_plane_count: cohortDeliveredPlaneCount,
      gold_source_plane_count: cohortGoldSourcePlaneCount,
      gold_first_admitted_count: cohortGoldFirstAdmittedCount,
      gold_winning_admission_count: cohortGoldWinningAdmissionCount,
      hit_at_5_count: cohortGoldHitAt5Count,
      hit_at_5_rate: ratio(cohortGoldHitAt5Count, cohortGoldSourcePlaneCount)
    },
    path_vs_graph_fanin: {
      path_gold_source_count: pathFaninGoldSourceCount,
      path_gold_hit_at_5_count: pathFaninGoldHitAt5Count,
      path_gold_hit_at_5_rate: ratio(pathFaninGoldHitAt5Count, pathFaninGoldSourceCount),
      graph_gold_source_count: graphFaninGoldSourceCount,
      graph_gold_hit_at_5_count: graphFaninGoldHitAt5Count,
      graph_gold_hit_at_5_rate: ratio(graphFaninGoldHitAt5Count, graphFaninGoldSourceCount),
      path_primary_hit_at_5_count: pathPrimaryGoldHitAt5Count,
      graph_only_hit_at_5_count: graphOnlyGoldHitAt5Count
    },
    // Calibrated-confidence audit block: how many `_abs` questions were
    // scored, how many stayed appropriately unconfident at each k, and the
    // false-confident threshold the verdict used. A future benchmark swap
    // can re-derive the threshold from this record.
    abstention: {
      schema_version: "bench-abstention.v1",
      total: abstentionTotal,
      false_confident_threshold: ABSTENTION_FALSE_CONFIDENT_THRESHOLD,
      correct_at_1: abstentionCorrectAt1,
      correct_at_5: abstentionCorrectAt5,
      correct_at_10: abstentionCorrectAt10,
      false_confident_at_1: abstentionTotal - abstentionCorrectAt1,
      false_confident_at_5: abstentionTotal - abstentionCorrectAt5,
      false_confident_at_10: abstentionTotal - abstentionCorrectAt10
    },
    miss_distribution: missDistribution
  };
}

function hasEvidenceStreamContribution(gold: LongMemEvalGoldDiagnostic): boolean {
  return (
    gold.source_planes.includes("evidence_anchor") ||
    gold.source_planes.includes("evidence_fts") ||
    gold.source_channels.includes("evidence_anchor") ||
    gold.source_channels.includes("evidence_fts") ||
    (gold.per_stream_rank?.evidence_fts ?? null) !== null ||
    (gold.per_stream_rank?.evidence_structural_agreement ?? null) !== null ||
    (gold.per_stream_rank?.source_evidence_agreement ?? null) !== null
  );
}

function hasPathStreamContribution(delivered: DiagnosticRecallResult): boolean {
  return (
    delivered.plane_first_admitted === "path_expansion" ||
    delivered.plane_winning_admission === "path_expansion" ||
    (delivered.per_stream_rank?.path_expansion ?? null) !== null
  );
}

// Durable-edge fan-in proof: a gold candidate bears the path_expansion stream
// (direct hop-1 co_recalled fan-in) when it was admitted on the path plane or
// fired the path_expansion fusion stream. see also: buildLongMemEvalQualityMetrics.
function hasGoldPathExpansionStream(gold: LongMemEvalGoldDiagnostic): boolean {
  return (
    gold.source_planes.includes("path_expansion") ||
    gold.plane_first_admitted === "path_expansion" ||
    gold.plane_winning_admission === "path_expansion" ||
    (gold.per_stream_rank?.path_expansion ?? null) !== null
  );
}

// Durable-edge fan-in proof: a gold candidate bears the graph_expansion stream
// (multi-hop fan-in) when it was admitted on the graph plane or fired the
// graph_expansion fusion stream. see also: buildLongMemEvalQualityMetrics.
function hasGoldGraphExpansionStream(gold: LongMemEvalGoldDiagnostic): boolean {
  return (
    gold.source_planes.includes("graph_expansion") ||
    gold.plane_first_admitted === "graph_expansion" ||
    gold.plane_winning_admission === "graph_expansion" ||
    (gold.per_stream_rank?.graph_expansion ?? null) !== null
  );
}

function isDeliveredOrderNonMonotonic(
  results: readonly DiagnosticRecallResult[]
): boolean {
  const deliveredRanks = results.map((result) => result.rank);
  if (deliveredRanks.every(isFiniteDiagnosticRank)) {
    return isDeliveredRankOrderNonMonotonic(deliveredRanks);
  }
  const fusedRanks = results.map((result) => result.fused_rank);
  if (fusedRanks.every(isFiniteDiagnosticRank)) {
    return isDeliveredRankOrderNonMonotonic(fusedRanks);
  }
  return isDeliveredScoreOrderNonMonotonic(
    results.map((result) => result.relevance_score)
  );
}

function isFiniteDiagnosticRank(rank: number | null | undefined): rank is number {
  return typeof rank === "number" && Number.isFinite(rank);
}

function isDeliveredRankOrderNonMonotonic(ranks: readonly number[]): boolean {
  for (let i = 1; i < ranks.length; i++) {
    const current = ranks[i];
    const previous = ranks[i - 1];
    if (current === undefined || previous === undefined) continue;
    if (current < previous) return true;
  }
  return false;
}

function isDeliveredScoreOrderNonMonotonic(scores: readonly number[]): boolean {
  for (let i = 1; i < scores.length; i++) {
    const current = scores[i];
    const previous = scores[i - 1];
    if (current === undefined || previous === undefined) continue;
    if (current > previous) return true;
  }
  return false;
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

export function summarizeLongMemEvalReportSideEffects(input: {
  readonly mode: LongMemEvalReportSideEffectSummary["mode"];
  readonly snapshots: readonly LongMemEvalReportSideEffectSnapshot[];
}): LongMemEvalReportSideEffectSummary {
  const byType: Record<string, number> = {};
  let memoryGraphEdgesTotal = 0;
  let recallsEdgeCount = 0;
  let pathRelationsTotal = 0;
  let latestPathEventAt: string | null = null;

  for (const snapshot of input.snapshots) {
    memoryGraphEdgesTotal += snapshot.memory_graph_edges_total;
    recallsEdgeCount += snapshot.recalls_edge_count;
    pathRelationsTotal += snapshot.path_relations_total;
    for (const [edgeType, count] of Object.entries(snapshot.memory_graph_edges_by_type)) {
      byType[edgeType] = (byType[edgeType] ?? 0) + count;
    }
    if (
      snapshot.latest_path_event_at !== null &&
      (latestPathEventAt === null || snapshot.latest_path_event_at > latestPathEventAt)
    ) {
      latestPathEventAt = snapshot.latest_path_event_at;
    }
  }

  return {
    mode: input.mode,
    workspaces_observed: input.snapshots.length,
    memory_graph_edges_total: memoryGraphEdgesTotal,
    memory_graph_edges_by_type: byType,
    recalls_edge_count: recallsEdgeCount,
    path_relations_total: pathRelationsTotal,
    latest_path_event_at: latestPathEventAt,
    snapshots: input.snapshots
  };
}

export function summarizeLongMemEvalRecallEvidence(
  diagnostics: readonly LongMemEvalQuestionDiagnostic[]
): LongMemEvalRecallEvidenceSummary {
  const deliveredFirst: Record<string, number> = {};
  const deliveredWinning: Record<string, number> = {};
  const goldChannels: Record<string, number> = {};
  const goldPlanes: Record<string, number> = {};
  let deliveredResultCount = 0;
  let graphSupportGoldCount = 0;
  let pathPlasticityGoldCount = 0;
  let graphExpansionPlaneCount = 0;
  let pathExpansionPlaneCount = 0;
  let graphExpansionHop1Count = 0;
  let graphExpansionHop2Count = 0;
  const graphExpansionEdgeTypes = createEmptyMutableGraphExpansionPlaneCountPerEdgeType();

  for (const row of diagnostics) {
    const graphExpansionHopCounts =
      readGraphExpansionPlaneCountPerHop(
        (row as { readonly graph_expansion_plane_count_per_hop?: unknown })
          .graph_expansion_plane_count_per_hop
      ) ?? createEmptyGraphExpansionPlaneCountPerHop();
    const graphExpansionEdgeTypeCounts =
      readGraphExpansionPlaneCountPerEdgeType(
        (row as { readonly graph_expansion_plane_count_per_edge_type?: unknown })
          .graph_expansion_plane_count_per_edge_type
      ) ?? createEmptyGraphExpansionPlaneCountPerEdgeType();
    graphExpansionHop1Count += graphExpansionHopCounts[0];
    graphExpansionHop2Count += graphExpansionHopCounts[1];
    graphExpansionEdgeTypes.derives_from += graphExpansionEdgeTypeCounts.derives_from;
    graphExpansionEdgeTypes.recalls += graphExpansionEdgeTypeCounts.recalls;
    graphExpansionEdgeTypes.supports += graphExpansionEdgeTypeCounts.supports;
    for (const delivered of row.delivered_results) {
      deliveredResultCount += 1;
      incrementCount(deliveredFirst, delivered.plane_first_admitted ?? "unknown");
      incrementCount(deliveredWinning, delivered.plane_winning_admission ?? "unknown");
      if (
        delivered.plane_first_admitted === "graph_expansion" ||
        delivered.plane_winning_admission === "graph_expansion"
      ) {
        graphExpansionPlaneCount += 1;
      }
      if (
        delivered.plane_first_admitted === "path_expansion" ||
        delivered.plane_winning_admission === "path_expansion"
      ) {
        pathExpansionPlaneCount += 1;
      }
    }
    for (const gold of row.gold) {
      if (gold.source_channels.includes("graph_support")) {
        graphSupportGoldCount += 1;
      }
      if (gold.source_channels.includes("path_plasticity")) {
        pathPlasticityGoldCount += 1;
      }
      for (const channel of gold.source_channels) {
        incrementCount(goldChannels, channel);
      }
      for (const plane of gold.source_planes) {
        incrementCount(goldPlanes, plane);
        if (plane === "graph_expansion") {
          graphExpansionPlaneCount += 1;
        } else if (plane === "path_expansion") {
          pathExpansionPlaneCount += 1;
        }
      }
    }
  }

  return {
    delivered_result_count: deliveredResultCount,
    graph_support_gold_count: graphSupportGoldCount,
    path_plasticity_gold_count: pathPlasticityGoldCount,
    graph_expansion_plane_count: graphExpansionPlaneCount,
    path_expansion_plane_count: pathExpansionPlaneCount,
    graph_expansion_plane_count_per_hop: Object.freeze([
      graphExpansionHop1Count,
      graphExpansionHop2Count
    ]) as LongMemEvalGraphExpansionPlaneCountPerHop,
    graph_expansion_plane_count_per_edge_type:
      freezeGraphExpansionPlaneCountPerEdgeType(graphExpansionEdgeTypes),
    delivered_plane_counts: {
      first_admitted: deliveredFirst,
      winning_admission: deliveredWinning
    },
    gold_source_channel_counts: goldChannels,
    gold_source_plane_counts: goldPlanes
  };
}

export function renderDiagnosticsSidecar(
  sidecar: LongMemEvalDiagnosticsSidecar
): string {
  return JSON.stringify(sidecar, null, 2) + "\n";
}

export function renderCompactDiagnosticsSidecar(
  sidecar: LongMemEvalDiagnosticsSidecar,
  fullDiagnosticsArtifactPath: string
): string {
  const reportSideEffects = sidecar.report_side_effects;
  const compact: LongMemEvalCompactDiagnosticsSidecar = {
    schema_version: 1,
    compact_schema_version: 1,
    bench_name: sidecar.bench_name,
    split: sidecar.split,
    run_at: sidecar.run_at,
    alaya_commit: sidecar.alaya_commit,
    ...(sidecar.recall_pipeline_version === undefined
      ? {}
      : { recall_pipeline_version: sidecar.recall_pipeline_version }),
    embedding_provider: sidecar.embedding_provider,
    embedding_mode: sidecar.embedding_mode,
    ...(sidecar.policy_shape === undefined ? {} : { policy_shape: sidecar.policy_shape }),
    ...(sidecar.simulate_report === undefined ? {} : { simulate_report: sidecar.simulate_report }),
    question_count: sidecar.questions.length,
    full_diagnostics_artifact_path: fullDiagnosticsArtifactPath,
    provider_state_summary: sidecar.provider_state_summary,
    ...(sidecar.report_usage === undefined ? {} : { report_usage: sidecar.report_usage }),
    ...(reportSideEffects === undefined
      ? {}
      : {
          report_side_effects: {
            mode: reportSideEffects.mode,
            workspaces_observed: reportSideEffects.workspaces_observed,
            memory_graph_edges_total: reportSideEffects.memory_graph_edges_total,
            memory_graph_edges_by_type: reportSideEffects.memory_graph_edges_by_type,
            recalls_edge_count: reportSideEffects.recalls_edge_count,
            path_relations_total: reportSideEffects.path_relations_total,
            latest_path_event_at: reportSideEffects.latest_path_event_at,
            snapshot_count: reportSideEffects.snapshots.length
          }
        }),
    ...(sidecar.scored_recall_evidence === undefined
      ? {}
      : { scored_recall_evidence: sidecar.scored_recall_evidence }),
    ...(sidecar.embedding_vector_cache === undefined
      ? {}
      : { embedding_vector_cache: sidecar.embedding_vector_cache }),
    ...(sidecar.query_embedding_cache === undefined
      ? {}
      : { query_embedding_cache: sidecar.query_embedding_cache })
  };
  return JSON.stringify(compact, null, 2) + "\n";
}

function readRecallDiagnostics(
  recallResult: unknown,
  embeddingMode: "disabled" | "env"
): NarrowRecallDiagnostics | null {
  if (recallResult === null || typeof recallResult !== "object") return null;
  if (!("diagnostics" in recallResult)) return null;
  const raw = (recallResult as { readonly diagnostics?: unknown }).diagnostics;
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Readonly<Record<string, unknown>>;
  const candidates = readCandidates(record);
  return {
    keys: Object.keys(record).sort(),
    candidatesByObjectId: candidates.byObjectId,
    candidatesByObjectIdentity: candidates.byObjectIdentity,
    candidatesByCandidateKey: candidates.byCandidateKey,
    candidateKeysByObjectId: candidates.keysByObjectId,
    providerState: readProviderState(record, embeddingMode),
    providerDegradationReason: readProviderDegradationReason(record),
    graphExpansionPlaneCountPerHop:
      readGraphExpansionPlaneCountPerHop(record.graph_expansion_plane_count_per_hop) ??
      createEmptyGraphExpansionPlaneCountPerHop(),
    graphExpansionPlaneCountPerEdgeType:
      readGraphExpansionPlaneCountPerEdgeType(record.graph_expansion_plane_count_per_edge_type) ??
      createEmptyGraphExpansionPlaneCountPerEdgeType()
  };
}

function readCandidates(
  diagnostics: Readonly<Record<string, unknown>>
): ReadCandidateDiagnosticsResult {
  const source =
    readArray(diagnostics.candidate_pool) ??
    readArray(diagnostics.candidates) ??
    readArray(diagnostics.pool) ??
    [];
  const byObjectId = new Map<string, CandidateDiagnostic>();
  const byObjectIdentity = new Map<string, CandidateDiagnostic>();
  const byCandidateKey = new Map<string, CandidateDiagnostic>();
  const mutableKeysByObjectId = new Map<string, string[]>();
  for (let i = 0; i < source.length; i++) {
    const raw = source[i];
    if (raw === null || typeof raw !== "object") continue;
    const record = raw as Readonly<Record<string, unknown>>;
    const objectId =
      readString(record.object_id) ??
      readString(record.memory_id) ??
      readString(record.id);
    if (objectId === null) continue;
    const originPlane = readString(record.origin_plane) ?? "workspace_local";
    const objectKind = readString(record.object_kind) ?? "memory_entry";
    const candidate: CandidateDiagnostic = {
      candidateKey: readString(record.candidate_key) ?? `${originPlane}:${objectKind}:${objectId}`,
      objectId,
      objectKind,
      originPlane,
      preBudgetRank:
        readNumber(record.pre_budget_rank) ?? readNumber(record.internal_rank),
      selectionOrder: readNumber(record.selection_order),
      finalRank: readNumber(record.final_rank) ?? readNumber(record.rank),
      fusedRank: readNumber(record.fused_rank),
      fusedScore: readNumber(record.fused_score),
      perStreamRank: readNullableNumberRecord(record.per_stream_rank),
      fusedRankContributionPerStream:
        readNumberRecord(record.fused_rank_contribution_per_stream),
      planeFirstAdmitted: readString(record.plane_first_admitted),
      planeWinningAdmission:
        readString(record.plane_winning_admission) ??
        lastString(readStringArray(record.admission_planes)),
      sourcePlanes:
        readDiagnosticLabelArray(record.source_planes) ??
        readDiagnosticLabelArray(record.planes) ??
        readDiagnosticLabelArray(record.admission_planes) ??
        [],
      lexicalRank: readNumber(record.lexical_rank),
      structuralScore: readNumber(record.structural_score),
      scoreFactors: readScoreFactors(record.score_factors),
      sourceChannels: readDiagnosticLabelArray(record.source_channels) ?? [],
      budgetDropReason:
        readString(record.budget_drop_reason) ??
        readString(record.drop_reason) ??
        readString(record.dropped_reason)
    };
    const objectIdentityKey = buildObjectIdentityKey(candidate.objectKind, candidate.objectId);
    byCandidateKey.set(candidate.candidateKey, candidate);
    const existingByIdentity = byObjectIdentity.get(objectIdentityKey);
    if (
      existingByIdentity === undefined ||
      shouldPreferCandidateDiagnostic(candidate, existingByIdentity)
    ) {
      byObjectIdentity.set(objectIdentityKey, candidate);
    }
    const keysForObject = mutableKeysByObjectId.get(objectId) ?? [];
    keysForObject.push(candidate.candidateKey);
    mutableKeysByObjectId.set(objectId, keysForObject);
    const existing = byObjectId.get(objectId);
    if (existing === undefined || shouldPreferCandidateDiagnostic(candidate, existing)) {
      byObjectId.set(objectId, candidate);
    }
  }
  const keysByObjectId = new Map(
    [...mutableKeysByObjectId.entries()].map(([objectId, keys]) => [
      objectId,
      Object.freeze([...keys].sort())
    ] as const)
  );
  return {
    byObjectId: Object.freeze(byObjectId),
    byObjectIdentity: Object.freeze(byObjectIdentity),
    byCandidateKey: Object.freeze(byCandidateKey),
    keysByObjectId: Object.freeze(keysByObjectId)
  };
}

function buildObjectIdentityKey(objectKind: string, objectId: string): string {
  return `${objectKind}:${objectId}`;
}

function isLongMemEvalGoldEligibleDiagnosticResult(
  result: Readonly<{ readonly object_kind?: string | null }>
): boolean {
  return (result.object_kind ?? "memory_entry") === "memory_entry";
}

function shouldPreferCandidateDiagnostic(
  candidate: CandidateDiagnostic,
  existing: CandidateDiagnostic
): boolean {
  const candidateFinal = candidate.finalRank ?? Number.MAX_SAFE_INTEGER;
  const existingFinal = existing.finalRank ?? Number.MAX_SAFE_INTEGER;
  if (candidateFinal !== existingFinal) {
    return candidateFinal < existingFinal;
  }

  const candidateFused = candidate.fusedRank ?? Number.MAX_SAFE_INTEGER;
  const existingFused = existing.fusedRank ?? Number.MAX_SAFE_INTEGER;
  if (candidateFused !== existingFused) {
    return candidateFused < existingFused;
  }

  if (candidate.originPlane !== existing.originPlane) {
    return candidate.originPlane === "workspace_local";
  }

  return candidate.candidateKey.localeCompare(existing.candidateKey) < 0;
}

function readScoreFactors(value: unknown): DiagnosticScoreFactors | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  const result: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(record)) {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      result[key] = raw;
      continue;
    }
    const nested = readNumberRecord(raw);
    if (nested !== null) {
      result[key] = nested;
    }
  }
  return Object.keys(result).length === 0 ? null : Object.freeze(result);
}

function readNumberRecord(value: unknown): Readonly<Record<string, number>> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  const result: Record<string, number> = {};
  for (const [key, raw] of Object.entries(record)) {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      result[key] = raw;
    }
  }
  return Object.keys(result).length === 0 ? null : Object.freeze(result);
}

function readGraphExpansionPlaneCountPerHop(
  value: unknown
): LongMemEvalGraphExpansionPlaneCountPerHop | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const first = readNumber(value[0]);
  const second = readNumber(value[1]);
  if (first === null || second === null) return null;
  return Object.freeze([Math.trunc(first), Math.trunc(second)]) as LongMemEvalGraphExpansionPlaneCountPerHop;
}

function readGraphExpansionPlaneCountPerEdgeType(
  value: unknown
): Readonly<LongMemEvalGraphExpansionPlaneCountPerEdgeType> | null {
  const record = readRecord(value);
  if (record === null) return null;
  const derivesFrom = readNumber(record.derives_from);
  const recalls = readNumber(record.recalls);
  const supports = readNumber(record.supports);
  if (derivesFrom === null || recalls === null || supports === null) {
    return null;
  }
  return freezeGraphExpansionPlaneCountPerEdgeType({
    derives_from: Math.trunc(derivesFrom),
    recalls: Math.trunc(recalls),
    supports: Math.trunc(supports)
  });
}

function createEmptyGraphExpansionPlaneCountPerHop(): LongMemEvalGraphExpansionPlaneCountPerHop {
  return Object.freeze([0, 0]) as LongMemEvalGraphExpansionPlaneCountPerHop;
}

function createEmptyMutableGraphExpansionPlaneCountPerEdgeType(): {
  derives_from: number;
  recalls: number;
  supports: number;
} {
  return {
    derives_from: 0,
    recalls: 0,
    supports: 0
  };
}

function createEmptyGraphExpansionPlaneCountPerEdgeType(): Readonly<LongMemEvalGraphExpansionPlaneCountPerEdgeType> {
  return freezeGraphExpansionPlaneCountPerEdgeType(
    createEmptyMutableGraphExpansionPlaneCountPerEdgeType()
  );
}

function freezeGraphExpansionPlaneCountPerEdgeType(input: {
  readonly derives_from: number;
  readonly recalls: number;
  readonly supports: number;
}): Readonly<LongMemEvalGraphExpansionPlaneCountPerEdgeType> {
  return Object.freeze({
    derives_from: input.derives_from,
    recalls: input.recalls,
    supports: input.supports
  });
}

function readNullableNumberRecord(value: unknown): Readonly<Record<string, number | null>> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  const result: Record<string, number | null> = {};
  for (const [key, raw] of Object.entries(record)) {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      result[key] = raw;
    } else if (raw === null) {
      result[key] = null;
    }
  }
  return Object.keys(result).length === 0 ? null : Object.freeze(result);
}

function readProviderState(
  diagnostics: Readonly<Record<string, unknown>>,
  embeddingMode: "disabled" | "env"
): BenchEmbeddingProviderState {
  const embedding = readRecord(diagnostics.embedding);
  const provider = readRecord(diagnostics.provider);
  const raw =
    readString(diagnostics.provider_state) ??
    readString(diagnostics.embedding_provider_status) ??
    readString(diagnostics.provider_status) ??
    readString(embedding?.provider_state) ??
    readString(embedding?.provider_status) ??
    readString(provider?.state) ??
    readString(provider?.status) ??
    readString(diagnostics.degradation_reason) ??
    readString(embedding?.degradation_reason);
  if (raw === null) {
    return embeddingMode === "disabled" ? "provider_not_requested" : "unknown";
  }
  return normalizeProviderState(raw);
}

function readProviderDegradationReason(
  diagnostics: Readonly<Record<string, unknown>>
): string | null {
  const embedding = readRecord(diagnostics.embedding);
  const provider = readRecord(diagnostics.provider);
  return sanitizeProviderDegradationReason(
    readString(diagnostics.provider_degradation_reason) ??
      readString(diagnostics.degradation_reason) ??
      readString(embedding?.degradation_reason) ??
      readString(provider?.degradation_reason)
  );
}

function normalizeProviderState(value: string): BenchEmbeddingProviderState {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "provider_returned" ||
    normalized === "returned" ||
    normalized === "success" ||
    normalized === "succeeded" ||
    normalized === "vector_returned"
  ) {
    return "provider_returned";
  }
  if (
    normalized === "provider_pending" ||
    normalized === "pending" ||
    normalized === "query_embedding_pending"
  ) {
    return "provider_pending";
  }
  if (
    normalized === "provider_failed" ||
    normalized === "failed" ||
    normalized === "error" ||
    normalized === "query_embedding_failed" ||
    normalized === "provider_unavailable" ||
    normalized === "local_vector_lookup_failed"
  ) {
    return "provider_failed";
  }
  if (normalized === "provider_not_requested" || normalized === "not_requested") {
    return "provider_not_requested";
  }
  return "unknown";
}

function sanitizeProviderDegradationReason(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "query_embedding_failed" ||
    normalized === "query_embedding_pending" ||
    normalized === "provider_unavailable" ||
    normalized === "local_vector_lookup_failed"
  ) {
    return normalized;
  }
  return null;
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

function isDeliveryBudgetLoss(item: LongMemEvalGoldDiagnostic): boolean {
  if (item.budget_drop_reason === null) return false;
  const candidateRank = item.pre_budget_rank ?? item.fused_rank;
  return candidateRank !== null && candidateRank <= DELIVERY_BUDGET_LOSS_RANK;
}

function hasStructuralPlane(planes: readonly string[]): boolean {
  return planes.some((plane) =>
    [
      "object_probe",
      "evidence_anchor",
      "domain_tag_cluster",
      "session_surface_cohort",
      "source_proximity",
      "graph_expansion",
      "path_expansion"
    ].includes(plane)
  );
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Readonly<Record<string, unknown>>;
}

function readArray(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readStringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const strings = value.filter(
    (item): item is string => typeof item === "string" && item.length > 0
  );
  return strings.length === value.length ? strings : null;
}

function readDiagnosticLabelArray(value: unknown): readonly string[] | null {
  const strings = readStringArray(value);
  if (strings === null) return null;
  return strings.filter((item) => DIAGNOSTIC_SOURCE_LABELS.has(item));
}

function incrementCount(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function lastString(values: readonly string[] | null): string | null {
  if (values === null || values.length === 0) return null;
  return values[values.length - 1] ?? null;
}

function ratio(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}

// @anchor per-plane-recall-coverage: shared by buildLongMemEvalQualityMetrics
// and cli.ts mergeQualityMetrics so single-shard and merged kpi.json carry
// the same per-plane block shape.
export function buildPerPlaneRecallCoverage(
  goldCounts: ReadonlyMap<string, number>,
  hitAt5Counts: ReadonlyMap<string, number>
): QualityMetrics["per_plane_recall_coverage"] {
  return Object.fromEntries(
    [...goldCounts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([plane, goldCount]) => {
        const hitCount = hitAt5Counts.get(plane) ?? 0;
        return [
          plane,
          {
            gold_count: goldCount,
            hit_at_5_count: hitCount,
            hit_at_5_rate: ratio(hitCount, goldCount)
          }
        ];
      })
  );
}
