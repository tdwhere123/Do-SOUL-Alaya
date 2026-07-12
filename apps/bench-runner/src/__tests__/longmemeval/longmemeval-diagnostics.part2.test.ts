import { describe, expect, it } from "vitest";

import { BenchRecallDiagnosticsSchema } from "../../harness/recall-diagnostics-schema.js";

import {
  LongMemEvalGoldDiagnosticSchema,
  LongMemEvalMissTaxonomySchema,
  LongMemEvalQuestionDiagnosticSchema
} from "../../longmemeval/diagnostics-schema.js";

import {
  buildLongMemEvalQualityMetrics,
  buildQuestionDiagnostic,
  renderCompactDiagnosticsSidecar,
  renderDiagnosticsSidecar,
  stripReplayCandidatePoolsForGateWrite,
  summarizeLongMemEvalRecallEvidence,
  summarizeProviderStates,
  type LongMemEvalQuestionDiagnostic
} from "../../longmemeval/diagnostics.js";

const emptyQueryProbes = {
  object_ids: [],
  subject_hints: [],
  evidence_refs: [],
  run_ids: [],
  surface_ids: [],
  file_paths: [],
  command_names: [],
  package_names: [],
  task_refs: [],
  dimensions: [],
  scope_classes: [],
  domain_tags: [],
  lexical_terms: [],
  expanded_terms: [],
  phrases: [],
  char_ngrams: [],
  date_terms: []
};

describe("LongMemEval recall diagnostics (legacy/order/pool)", () => {

  it("classifies question misses into the durable diagnostics taxonomy", () => {
    expect(LongMemEvalMissTaxonomySchema.options).toEqual([
      "candidate_absent",
      "materialization_drop",
      "budget_drop",
      "delivery_order_drop",
      "answer_set_coverage_drop",
      "evaluation_or_gold_issue"
    ]);
    const materializationDrop = buildQuestionDiagnostic({
      questionId: "q-materialization-drop",
      goldMemoryIds: ["gold-a"],
      answerSessionIds: ["session-a"],
      deliveredResults: [],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: {
        diagnostics: {
          candidates: [
            {
              object_id: "gold-a",
              object_kind: "synthesis_capsule",
              origin_plane: "workspace_local",
              candidate_key: "workspace_local:synthesis_capsule:gold-a"
            }
          ]
        }
      }
    });
    const budgetDrop = buildQuestionDiagnostic({
      questionId: "q-budget-drop",
      goldMemoryIds: ["gold-b"],
      answerSessionIds: ["session-a"],
      deliveredResults: [],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: {
        diagnostics: {
          candidates: [
            {
              object_id: "gold-b",
              object_kind: "memory_entry",
              origin_plane: "workspace_local",
              candidate_key: "workspace_local:memory_entry:gold-b",
              pre_budget_rank: 4,
              final_rank: null,
              dropped_reason: "max_entries"
            }
          ]
        }
      }
    });
    const deliveryOrderDrop = buildQuestionDiagnostic({
      questionId: "q-delivery-order-drop",
      goldMemoryIds: ["gold-c"],
      answerSessionIds: ["session-a"],
      deliveredResults: [{ object_id: "gold-c", rank: 8, relevance_score: 0.3 }],
      hitAt1: false,
      hitAt5: false,
      hitAt10: true,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: {
        diagnostics: {
          candidates: [
            {
              object_id: "gold-c",
              object_kind: "memory_entry",
              origin_plane: "workspace_local",
              candidate_key: "workspace_local:memory_entry:gold-c",
              final_rank: 8,
              fused_rank: 4
            }
          ]
        }
      }
    });
    const candidateAbsent = buildQuestionDiagnostic({
      questionId: "q-candidate-absent",
      goldMemoryIds: ["gold-d"],
      answerSessionIds: ["session-a"],
      deliveredResults: [],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: { diagnostics: { candidates: [] } }
    });
    const noGold = buildQuestionDiagnostic({
      questionId: "q-no-gold",
      goldMemoryIds: [],
      answerSessionIds: ["session-a"],
      deliveredResults: [],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: { diagnostics: { candidates: [] } }
    });
    const noGoldMaterializationDrop = buildQuestionDiagnostic({
      questionId: "q-no-gold-materialization-drop",
      goldMemoryIds: [],
      answerSessionIds: ["session-a"],
      deliveredResults: [],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      degradationReason: null,
      embeddingMode: "disabled",
      seedDropReasons: {
        candidate_absent: 0,
        materialization_drop: 1
      },
      recallResult: { diagnostics: { candidates: [] } }
    });
    const noGoldCandidateAbsent = buildQuestionDiagnostic({
      questionId: "q-no-gold-candidate-absent",
      goldMemoryIds: [],
      answerSessionIds: ["session-a"],
      deliveredResults: [],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      degradationReason: null,
      embeddingMode: "disabled",
      seedDropReasons: {
        candidate_absent: 2,
        materialization_drop: 0
      },
      recallResult: { diagnostics: { candidates: [] } }
    });

    expect(materializationDrop.miss_taxonomy).toBe("materialization_drop");
    expect(materializationDrop.gold[0]?.miss_taxonomy).toBe("materialization_drop");
    expect(budgetDrop.miss_taxonomy).toBe("budget_drop");
    expect(deliveryOrderDrop.miss_taxonomy).toBe("delivery_order_drop");
    expect(candidateAbsent.miss_taxonomy).toBe("candidate_absent");
    expect(noGold.miss_taxonomy).toBe("evaluation_or_gold_issue");
    expect(noGoldMaterializationDrop.miss_taxonomy).toBe("materialization_drop");
    expect(noGoldCandidateAbsent.miss_taxonomy).toBe("candidate_absent");

    const answerSetCoverageDrop = buildQuestionDiagnostic({
      questionId: "q-answer-set-coverage-drop",
      goldMemoryIds: ["gold-e"],
      answerSessionIds: ["session-a"],
      deliveredResults: [{ object_id: "gold-e", rank: 8, relevance_score: 0.3 }],
      hitAt1: false,
      hitAt5: false,
      hitAt10: true,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: {
        diagnostics: {
          candidates: [
            {
              object_id: "gold-e",
              object_kind: "memory_entry",
              origin_plane: "workspace_local",
              candidate_key: "workspace_local:memory_entry:gold-e",
              final_rank: 8,
              fused_rank: 3,
              rank_after_fusion: 3,
              rank_after_coverage_selector: 8,
              coverage_selector_action: "displaced"
            }
          ]
        }
      }
    });
    expect(answerSetCoverageDrop.miss_taxonomy).toBe("answer_set_coverage_drop");
    expect(answerSetCoverageDrop.gold[0]?.miss_taxonomy).toBe(
      "answer_set_coverage_drop"
    );

    const abstention = buildQuestionDiagnostic({
      questionId: "q-abstention_abs",
      goldMemoryIds: [],
      answerSessionIds: [],
      deliveredResults: [],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      isAbstention: true,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: { diagnostics: { candidates: [] } }
    });
    expect(abstention.miss_taxonomy).toBeNull();

    const hitWithStaleTaxonomy = {
      ...candidateAbsent,
      question_id: "q-hit-with-stale-taxonomy",
      hit_at_5: true,
      miss_taxonomy: "candidate_absent" as const
    };

    const questions = [
      materializationDrop,
      budgetDrop,
      deliveryOrderDrop,
      candidateAbsent,
      noGold,
      noGoldMaterializationDrop,
      noGoldCandidateAbsent,
      abstention,
      hitWithStaleTaxonomy
    ];
    const summary = summarizeLongMemEvalRecallEvidence(questions);
    expect(summary.miss_taxonomy_distribution).toEqual({
      candidate_absent: 1,
      materialization_drop: 1,
      budget_drop: 1,
      delivery_order_drop: 1,
      answer_set_coverage_drop: 0,
      evaluation_or_gold_issue: 0
    });
    const metrics = buildLongMemEvalQualityMetrics(questions);
    expect(metrics.miss_taxonomy_distribution).toEqual(summary.miss_taxonomy_distribution);
    expect(metrics.unscorable_reason_distribution).toEqual({
      abstention_uncalibrated: 1,
      empty_gold_identity: 1,
      extraction_materialization_drop: 2
    });
    const cohorts = metrics.measurement_cohort_counts!;
    expect(cohorts).toEqual({
      evaluated: 9,
      non_abstention: 8,
      abstention: 1,
      scorable_answerable: 5,
      unscorable_answerable: 3,
      hit_at_5: 1,
      miss_at_5: 4
    });
    expect(cohorts.evaluated).toBe(cohorts.non_abstention + cohorts.abstention);
    expect(cohorts.non_abstention).toBe(
      cohorts.scorable_answerable + cohorts.unscorable_answerable
    );
    expect(cohorts.scorable_answerable).toBe(cohorts.hit_at_5 + cohorts.miss_at_5);
  });

});
