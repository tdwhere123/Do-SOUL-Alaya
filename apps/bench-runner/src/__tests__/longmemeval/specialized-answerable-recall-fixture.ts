import type { LongMemEvalQuestionDiagnostic } from
  "../../longmemeval/diagnostics-types.js";
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
    miss_classification: hit ? "hit_at_5" : "candidate_absent",
    provider_state: "provider_returned",
    cohort_ledger: measurementLedger(status, hit)
  };
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
    lastCacheKey: "key"
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
