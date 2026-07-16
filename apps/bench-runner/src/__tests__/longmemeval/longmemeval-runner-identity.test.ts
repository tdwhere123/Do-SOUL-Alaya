import { describe, expect, it } from "vitest";
import { KpiPayloadSchema, type KpiPayload } from "@do-soul/alaya-eval";
import {
  buildLongMemEvalQualityMetrics,
  buildQuestionDiagnostic
} from "../../longmemeval/diagnostics.js";
import { readRecallDiagnostics } from "../../longmemeval/diagnostics-private.js";
import { buildLongMemEvalArchivePayload } from "./longmemeval-runner-fixture.js";

function answerFeatures(content: string) {
  return {
    content,
    evidence_gist: null,
    evidence_gist_truncated: false,
    domain_tags: [],
    evidence_refs: [],
    facet_tags: [],
    canonical_entities: [],
    projection_schema_version: null,
    event_time_start: null,
    event_time_end: null,
    valid_from: null,
    valid_to: null,
    time_precision: null,
    time_source: null,
    preference_subject: null,
    preference_predicate: null,
    preference_object: null,
    preference_category: null,
    preference_polarity: null
  };
}

describe("LongMemEval runner", () => {

  it("keeps one gold memory scorable when multiple recall planes admit it", () => {
    const row = buildQuestionDiagnostic({
      questionId: "q-multiplane-gold",
      goldMemoryIds: ["memory-gold"],
      answerSessionIds: ["session-a"],
      deliveredResults: [{ object_id: "memory-gold", rank: 1, relevance_score: 0.9 }],
      hitAt1: true,
      hitAt5: true,
      hitAt10: true,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: {
        diagnostics: {
          candidate_pool: [
            {
              candidate_key: "lexical:memory_entry:memory-gold",
              object_id: "memory-gold",
              object_kind: "memory_entry",
              origin_plane: "lexical"
            },
            {
              candidate_key: "evidence_anchor:memory_entry:memory-gold",
              object_id: "memory-gold",
              object_kind: "memory_entry",
              origin_plane: "evidence_anchor"
            }
          ]
        }
      }
    });

    expect(row.candidate_key_collisions).toHaveLength(1);
    expect(row.cohort_ledger).toMatchObject({
      measurement_status: "scorable",
      evaluator_gold_identity: { status: "present" },
      evaluation_issue_reason: null,
      retrieval_status: "hit_at_5"
    });
  });

  it.each([
    [
      "identity field",
      {
        candidate_key: "evidence_anchor:memory_entry:memory-gold",
        object_id: "memory-gold",
        object_kind: "memory_entry",
        origin_plane: "evidence_anchor",
        created_at: "2026-07-12T01:00:00.000Z"
      }
    ]
  ])("fails closed when duplicate gold candidates conflict on %s", (_label, conflicting) => {
    const row = buildQuestionDiagnostic({
      questionId: "q-conflicting-gold-identity",
      goldMemoryIds: ["memory-gold"],
      answerSessionIds: ["session-a"],
      deliveredResults: [{ object_id: "memory-gold", rank: 1, relevance_score: 0.9 }],
      hitAt1: true,
      hitAt5: true,
      hitAt10: true,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: {
        diagnostics: {
          candidate_pool: [
            {
              candidate_key: "lexical:memory_entry:memory-gold",
              object_id: "memory-gold",
              object_kind: "memory_entry",
              origin_plane: "lexical",
              created_at: "2026-07-12T00:00:00.000Z"
            },
            conflicting
          ]
        }
      }
    });

    expect(row.candidate_key_collisions).toHaveLength(1);
    expect(row.cohort_ledger).toMatchObject({
      measurement_status: "evaluator_identity_unscorable",
      evaluator_gold_identity: { status: "ambiguous" },
      evaluation_issue_reason: "identity_join_error",
      retrieval_status: "not_applicable"
    });
  });

  it("keeps memory gold scorable beside a same-id synthesis capsule", () => {
    const row = buildQuestionDiagnostic({
      questionId: "q-cross-kind-same-id",
      goldMemoryIds: ["memory-gold"],
      answerSessionIds: ["session-a"],
      deliveredResults: [{ object_id: "memory-gold", rank: 1, relevance_score: 0.9 }],
      hitAt1: true,
      hitAt5: true,
      hitAt10: true,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: {
        diagnostics: {
          candidate_pool: [
            {
              candidate_key: "lexical:memory_entry:memory-gold",
              object_id: "memory-gold",
              object_kind: "memory_entry",
              origin_plane: "lexical"
            },
            {
              candidate_key: "synthesis:synthesis_capsule:memory-gold",
              object_id: "memory-gold",
              object_kind: "synthesis_capsule",
              origin_plane: "synthesis"
            }
          ]
        }
      }
    });

    expect(row.candidate_key_collisions).toEqual([]);
    expect(row.cohort_ledger).toMatchObject({
      measurement_status: "scorable",
      evaluator_gold_identity: { status: "present" },
      evaluation_issue_reason: null,
      retrieval_status: "hit_at_5"
    });
  });

  it("does not let a conflicting same-id synthesis group poison memory gold", () => {
    const row = buildQuestionDiagnostic({
      questionId: "q-cross-kind-conflict",
      goldMemoryIds: ["memory-gold"],
      answerSessionIds: ["session-a"],
      deliveredResults: [{ object_id: "memory-gold", rank: 1, relevance_score: 0.9 }],
      hitAt1: true,
      hitAt5: true,
      hitAt10: true,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: {
        diagnostics: {
          candidate_pool: [
            {
              candidate_key: "lexical:memory_entry:memory-gold",
              object_id: "memory-gold",
              object_kind: "memory_entry",
              origin_plane: "lexical"
            },
            {
              candidate_key: "synthesis-a:synthesis_capsule:memory-gold",
              object_id: "memory-gold",
              object_kind: "synthesis_capsule",
              origin_plane: "synthesis",
              created_at: "2026-07-12T00:00:00.000Z"
            },
            {
              candidate_key: "synthesis-b:synthesis_capsule:memory-gold",
              object_id: "memory-gold",
              object_kind: "synthesis_capsule",
              origin_plane: "synthesis",
              created_at: "2026-07-12T01:00:00.000Z"
            }
          ]
        }
      }
    });

    expect(row.candidate_key_collisions).toHaveLength(1);
    expect(row.cohort_ledger).toMatchObject({
      measurement_status: "scorable",
      evaluator_gold_identity: { status: "present" },
      evaluation_issue_reason: null,
      retrieval_status: "hit_at_5"
    });
  });

  it("marks a diagnostics pool incomplete when candidate keys repeat", () => {
    const rawCandidates = [
      {
        candidate_key: "duplicate-key",
        object_id: "memory-gold",
        object_kind: "memory_entry"
      },
      {
        candidate_key: "duplicate-key",
        object_id: "other-memory",
        object_kind: "memory_entry"
      }
    ];
    expect(readRecallDiagnostics({ diagnostics: { candidate_pool: rawCandidates } }, "disabled")
      ?.candidatePoolComplete).toBe(false);
    const row = buildQuestionDiagnostic({
      questionId: "q-duplicate-candidate-key",
      goldMemoryIds: ["memory-gold"],
      answerSessionIds: ["session-a"],
      deliveredResults: [],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: {
        diagnostics: {
          candidate_pool: rawCandidates
        }
      }
    });

    expect(row.candidate_pool_complete).toBe(false);
    expect(row.cohort_ledger?.evidence_status).toBe("partial");
  });

  it("fails closed when duplicate gold candidates contradict answer features", () => {
    const row = buildQuestionDiagnostic({
      questionId: "q-conflicting-answer-features",
      goldMemoryIds: ["memory-gold"],
      answerSessionIds: ["session-a"],
      deliveredResults: [{ object_id: "memory-gold", rank: 1, relevance_score: 0.9 }],
      hitAt1: true,
      hitAt5: true,
      hitAt10: true,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: {
        diagnostics: {
          candidate_pool: [
            {
              candidate_key: "lexical:memory_entry:memory-gold",
              object_id: "memory-gold",
              object_kind: "memory_entry",
              origin_plane: "lexical",
              answer_features: answerFeatures("first canonical content")
            },
            {
              candidate_key: "evidence_anchor:memory_entry:memory-gold",
              object_id: "memory-gold",
              object_kind: "memory_entry",
              origin_plane: "evidence_anchor",
              answer_features: answerFeatures("contradictory canonical content")
            }
          ]
        }
      }
    });

    expect(row.cohort_ledger).toMatchObject({
      measurement_status: "evaluator_identity_unscorable",
      evaluator_gold_identity: { status: "ambiguous" },
      evaluation_issue_reason: "identity_join_error"
    });
  });

  it("invalidates an abstention row that carries evaluator gold identity", () => {
    const row = buildQuestionDiagnostic({
      questionId: "q-conflicted_abs",
      goldMemoryIds: ["memory-gold"],
      answerSessionIds: ["session-a"],
      deliveredResults: [{ object_id: "memory-gold", rank: 1, relevance_score: 0.9 }],
      hitAt1: true,
      hitAt5: true,
      hitAt10: true,
      isAbstention: true,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: { diagnostics: { candidate_pool: [] } }
    });

    expect(row.cohort_ledger).toMatchObject({
      dataset_cohort: "adjudicated_invalid",
      measurement_status: "evaluator_identity_unscorable",
      evaluation_issue_reason: "evaluator_data_identity_inconsistency",
      retrieval_status: "not_applicable",
      final_verdict: "evaluator_data_identity_inconsistency"
    });
    expect(row.miss_classification).toBe("evaluator_identity_inconsistent");

    const metrics = buildLongMemEvalQualityMetrics([row]);
    expect(metrics.abstention).toMatchObject({ total: 0, unscorable: 0 });
    expect(metrics.evaluator_identity_issue_count).toBe(1);
    expect(metrics.evaluator_identity_issue_denominator).toBe(1);
    expect(metrics.evaluator_identity_unscorable_count).toBe(1);
    expect(metrics.evaluator_identity_unscorable_denominator).toBe(1);
    expect(metrics.miss_distribution).toMatchObject({
      evaluator_identity_inconsistent: 1
    });

    const base = buildLongMemEvalArchivePayload();
    const payload: KpiPayload = {
      ...base,
      sample_size: 1,
      evaluated_count: 1,
      answerable_evaluated_count: 0,
      measurement_attribution: {
        schema_version: "bench-measurement-attribution.v2",
        status: "ineligible",
        gate_eligible: false,
        evidence_status: "partial",
        candidate_pool_complete: false,
        provenance_complete: false,
        abstention_calibration_status: "not_applicable",
        evaluator_identity_status: "invalid"
      },
      kpi: {
        ...base.kpi,
        r_at_1: 0,
        r_at_5: 0,
        r_at_10: 0,
        per_scenario: [
          { id: row.question_id, version: 1, hit_at_5: false, scorable: false, tier: "hot" }
        ],
        quality_metrics: metrics
      }
    };
    expect(() => KpiPayloadSchema.parse(payload)).not.toThrow();
  });


});
