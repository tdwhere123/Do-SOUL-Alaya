import { describe, expect, it } from "vitest";
import { LongMemEvalQuestionDiagnosticSchema } from "../../longmemeval/diagnostics-schema.js";
import { aggregateLongMemEvalRunResults } from "../../longmemeval/runner-archive-aggregate.js";
import type { LongMemEvalWorkerResult } from "../../longmemeval/runner-question.js";
import { accumulateRecallEvalRows } from "../../longmemeval/kpi/recall-eval-accumulator.js";
import type { RecallEvalQuestionResult } from "../../longmemeval/recall-eval.js";

interface ResultInput {
  id: string;
  abstention: boolean;
  hitAt1: boolean;
  hitAt5: boolean;
  hitAt10: boolean;
  evaluatorInvalid?: boolean;
}

function result(input: ResultInput): LongMemEvalWorkerResult {
  return {
    questionId: input.id,
    hitAt1: input.hitAt1,
    hitAt5: input.hitAt5,
    hitAt10: input.hitAt10,
    firstTier: "hot",
    latencyMs: 1,
    degradationReason: null,
    seedTurnsTruncated: 0,
    answerTurnsTruncated: 0,
    seedCharsClipped: 0,
    diagnostics: diagnostic(input),
    embeddingWarmup: null,
    queryEmbeddingWarmup: null,
    reportUsageStats: {
      reportsAttempted: 0,
      reportsUsed: 0,
      reportsSkipped: 0,
      usedObjectCount: 0
    },
    reportSideEffectSnapshot: {} as LongMemEvalWorkerResult["reportSideEffectSnapshot"],
    tokenMetrics: {} as LongMemEvalWorkerResult["tokenMetrics"],
    recallTokenEconomy: null,
    edgeProposalKpiRows: []
  };
}

function diagnostic(input: ResultInput) {
  return LongMemEvalQuestionDiagnosticSchema.parse({
    question_id: input.id,
    question_type: "single-session-user",
    is_abstention: input.abstention,
    premise_invalid: false,
    round_index: null,
    gold_memory_ids: ["gold"],
    answer_session_ids: [],
    delivered_results: [],
    active_constraint_results: [],
    hit_at_1: input.hitAt1,
    hit_at_5: input.hitAt5,
    hit_at_10: input.hitAt10,
    miss_classification: input.abstention
      ? "abstained_correctly"
      : input.hitAt5 ? "hit_at_5" : "candidate_absent",
    miss_taxonomy: null,
    degradation_reason: null,
    recall_diagnostics_present: true,
    recall_diagnostics_keys: [],
    provider_state: "provider_not_requested",
    provider_degradation_reason: null,
    graph_expansion_plane_count_per_hop: [0, 0],
    graph_expansion_plane_count_per_edge_type: { derives_from: 0, recalls: 0, supports: 0 },
    candidate_pool_complete: true,
    query_sought_facets: null,
    candidates: [],
    candidate_key_collisions: [],
    gold: [],
    cohort_ledger: cohortLedger(input)
  });
}

function cohortLedger(input: ResultInput) {
  if (input.evaluatorInvalid) {
    return {
      measurement_status: "evaluator_identity_unscorable",
      dataset_cohort: "answerable",
      extraction_materialization: {
        status: "memory_emitted", emitted_memory_count: 1, reason: null
      },
      evaluator_gold_identity: { status: "present", object_ids: ["wrong-gold"] },
      retrieval_status: "not_applicable",
      evidence_status: "complete",
      evaluation_issue_reason: "evaluator_data_identity_inconsistency",
      candidate_pool_complete: true,
      stage_ranks: [],
      final_verdict: "evaluator_data_identity_inconsistency"
    };
  }
  return {
    measurement_status: input.abstention ? "abstention_unscorable" : "scorable",
    dataset_cohort: input.abstention ? "abstention" : "answerable",
    extraction_materialization: {
      status: input.abstention ? "unknown" : "memory_emitted",
      emitted_memory_count: input.abstention ? 0 : 1,
      reason: null
    },
    evaluator_gold_identity: { status: "present", object_ids: ["gold"] },
    retrieval_status: input.abstention
      ? "not_applicable"
      : input.hitAt5 ? "hit_at_5" : "miss_at_5",
    evidence_status: "complete",
    evaluation_issue_reason: null,
    candidate_pool_complete: true,
    stage_ranks: [],
    final_verdict: input.abstention
      ? "abstained_correctly"
      : input.hitAt5 ? "hit_at_5" : "miss_at_5"
  };
}

describe("LongMemEval answerable metric denominator", () => {
  it("marks answerable rows scorable and excludes abstention from the denominator", () => {
    const aggregate = aggregateLongMemEvalRunResults([
      result({ id: "q-answer", abstention: false, hitAt1: true, hitAt5: true, hitAt10: true }),
      result({ id: "q-abstain", abstention: true, hitAt1: false, hitAt5: false, hitAt10: false })
    ]);

    expect(aggregate.perScenario).toEqual([
      expect.objectContaining({ id: "q-answer", scorable: true }),
      expect.objectContaining({ id: "q-abstain", scorable: false })
    ]);
    expect(aggregate.answerableCount).toBe(1);
  });

  it("excludes answerable evaluator-invalid rows instead of counting them as misses", () => {
    const invalid = result({
      id: "q-identity-invalid",
      abstention: false,
      evaluatorInvalid: true,
      hitAt1: false,
      hitAt5: false,
      hitAt10: false
    });
    const archive = aggregateLongMemEvalRunResults([invalid]);
    const recallEval = accumulateRecallEvalRows([
      invalid as unknown as RecallEvalQuestionResult
    ]);

    expect(archive.perScenario[0]).toMatchObject({ scorable: false, hit_at_5: false });
    expect(archive.answerableCount).toBe(0);
    expect(recallEval.perScenario[0]).toMatchObject({ scorable: false, hit_at_5: false });
    expect(recallEval.answerableCount).toBe(0);
  });
});
