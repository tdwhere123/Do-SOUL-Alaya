import type { LongMemEvalQuestionDiagnostic } from
  "../../longmemeval/diagnostics-types.js";
import { DiagnosticRecallResultSchema } from
  "../../longmemeval/diagnostics-schema.js";
import { LongMemEvalQuestionDiagnosticSchema } from
  "../../longmemeval/diagnostics-schema.js";
import { buildGoldDiagnostics } from
  "../../longmemeval/diagnostics/gold-diagnostics.js";
import { cohort, streamedQuestion } from "../cli/cli-merge-evidence-fixture.js";

export type MeasurementStatus =
  | "scorable"
  | "abstention"
  | "identity_unscorable";

export function measurementDiagnostic(
  questionId: string,
  status: MeasurementStatus,
  hit: boolean,
  roundIndex: number | null = null
): LongMemEvalQuestionDiagnostic {
  return {
    ...streamedQuestion(questionId),
    is_abstention: status === "abstention",
    round_index: roundIndex,
    hit_at_1: hit,
    hit_at_5: hit,
    hit_at_10: hit,
    miss_classification: status === "abstention"
      ? "abstention_uncalibrated"
      : status === "identity_unscorable"
        ? "evaluator_identity_inconsistent"
        : hit ? "hit_at_5" : "candidate_absent",
    provider_state: "provider_returned",
    cohort_ledger: measurementLedger(status, hit)
  };
}

export function promotionGoldId(questionId: string): string {
  return `${questionId}-gold`;
}

export function promotionMeasurementDiagnostic(
  questionId: string,
  status: MeasurementStatus,
  hit: boolean
): LongMemEvalQuestionDiagnostic {
  const base = measurementDiagnostic(questionId, status, hit);
  const goldIds = status === "scorable" ? [promotionGoldId(questionId)] : [];
  const delivered = hit && status === "scorable"
    ? [promotionDeliveredResult(goldIds[0]!)]
    : [];
  const gold = buildGoldDiagnostics({
    goldMemoryIds: goldIds,
    deliveredRankById: new Map(delivered.map((row) => [row.object_id, row.rank])),
    activeConstraintRankById: new Map(),
    diagnostics: null
  });
  const candidates = delivered.length === 0 ? [] : [promotionReplayCandidate(goldIds[0]!)];
  const projectedGold = candidates.length === 0
    ? gold
    : gold.map((row) => ({
        ...row,
        score_factors: { activation: 1, relevance: 1 }
      }));
  return LongMemEvalQuestionDiagnosticSchema.parse({
    ...base,
    gold_memory_ids: goldIds,
    delivered_results: delivered,
    cohort_ledger: {
      ...base.cohort_ledger!,
      extraction_materialization: status === "scorable"
        ? { status: "memory_emitted", emitted_memory_count: goldIds.length, reason: null }
        : { status: "unknown", emitted_memory_count: 0, reason: null },
      evaluator_gold_identity: {
        status: status === "scorable" ? "present" : "absent",
        object_ids: goldIds
      },
      candidate_pool_complete: true,
      stage_ranks: projectedGold.map((row) => ({
        object_id: row.object_id,
        fused_rank: row.fused_rank,
        rank_after_feature_rerank: row.rank_after_feature_rerank,
        rank_after_lexical_priority: row.rank_after_lexical_priority,
        rank_after_synthesis_reserve: row.rank_after_synthesis_reserve,
        rank_after_structural_reserve: row.rank_after_structural_reserve,
        rank_after_coverage_selector: row.rank_after_coverage_selector,
        rank_after_session_coverage: row.rank_after_session_coverage,
        selection_order: row.selection_order,
        final_rank: row.final_rank
      }))
    },
    candidate_pool_count: candidates.length,
    fine_pruned_count: 0,
    fine_assessment_pruned_candidates: [],
    candidate_pool_complete: true,
    candidates,
    gold: projectedGold
  });
}

function promotionReplayCandidate(objectId: string) {
  return {
    object_id: objectId,
    object_kind: "memory_entry",
    candidate_key: `workspace_local:memory_entry:${objectId}`,
    origin_plane: "workspace_local",
    final_rank: 1,
    pre_budget_rank: null,
    selection_order: null,
    fused_rank: null,
    fused_score: null,
    per_stream_rank: null,
    fused_rank_contribution_per_stream: null,
    score_factors: {
      activation: 1,
      relevance: 1,
      facet_overlap: 0,
      created_at: "2026-07-17T00:00:00.000Z"
    }
  };
}

function promotionDeliveredResult(objectId: string) {
  return DiagnosticRecallResultSchema.parse({
    object_id: objectId,
    object_kind: "memory_entry",
    rank: 1,
    relevance_score: 1,
    fused_rank: 1,
    fused_score: 1,
    per_stream_rank: null,
    fused_rank_contribution_per_stream: null,
    plane_first_admitted: null,
    plane_winning_admission: null,
    score_factors: null
  });
}

function measurementLedger(status: MeasurementStatus, hit: boolean) {
  if (status === "scorable") {
    return {
      ...cohort(),
      measurement_status: "scorable" as const,
      retrieval_status: hit ? "hit_at_5" as const : "miss_at_5" as const,
      final_verdict: hit ? "hit_at_5" as const : "miss_at_5" as const
    };
  }
  if (status === "abstention") return abstentionLedger();
  return identityUnscorableLedger();
}

function abstentionLedger() {
  return {
    ...cohort(),
    measurement_status: "abstention_unscorable" as const,
    dataset_cohort: "abstention" as const,
    retrieval_status: "not_applicable" as const,
    final_verdict: "abstention_uncalibrated" as const
  };
}

function identityUnscorableLedger() {
  return {
    ...cohort(),
    measurement_status: "evaluator_identity_unscorable" as const,
    retrieval_status: "not_applicable" as const,
    evaluation_issue_reason: "evaluator_data_identity_inconsistency" as const,
    final_verdict: "evaluator_data_identity_inconsistency" as const
  };
}

export function emptyTokenMetrics() {
  return {
    raw_history_tokens: 0,
    stored_memory_tokens: 0,
    recalled_context_tokens_total: 0,
    recall_event_count: 0,
    recalled_context_tokens_mean: 0,
    seed_event_count: 0
  };
}

export function seedStats() {
  return {
    path: "official_api_compile" as const,
    cacheHits: 1,
    llmCalls: 0,
    offlineFallbacks: 0,
    liveExtractionFailures: 0,
    cachedExtractionFailures: 0,
    factsProduced: 1,
    signalsDropped: 0,
    signalsDroppedByReason: { candidate_absent: 0, materialization_drop: 0 },
    parseDropped: 0,
    compileOverflowDropped: 0,
    lastTurnRawSignalCount: 1,
    lastTurnDraftCount: 1,
    lastExtractionSource: "cache" as const,
    lastCacheKey: "key",
    lastRawJsonSha256: null
  };
}

export function emptySeedResult() {
  return {
    signalIds: [],
    memoryEntryIds: [],
    rawSignalCount: 0,
    draftCount: 0,
    seedTurnsTruncated: 0,
    answerTurnsTruncated: 0,
    seedCharsClipped: 0
  };
}
