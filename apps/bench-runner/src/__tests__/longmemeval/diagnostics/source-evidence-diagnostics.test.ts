import { describe, expect, it } from "vitest";

import { buildQuestionMeasurementAxes } from
  "../../../bench/diagnostics/diagnostics-measurement-axes.js";
import {
  buildLongMemEvalDetailedGoldCoverage
} from "../../../bench/diagnostics/diagnostics-full-gold-coverage.js";
import { buildQuestionDiagnostic } from
  "../../../bench/diagnostics/diagnostics-question.js";
import { readGoldObjectIds } from
  "../../../bench/diagnostics/gold-object-identities.js";
import { buildLongMemEvalQualityMetrics } from
  "../../../bench/diagnostics/quality/diagnostics-quality.js";
import {
  LongMemEvalQuestionDiagnosticSchema
} from "../../../bench/diagnostics/schema/diagnostics-schema.js";
import type { LongMemEvalQuestionDiagnostic } from
  "../../../bench/diagnostics/schema/diagnostics-types.js";

describe("LongMemEval source-evidence diagnostics", () => {
  it("persists evidence gold separately and joins delivery by object identity", () => {
    const row = buildQuestionDiagnostic({
      questionId: "q-source-evidence",
      goldMemoryIds: [],
      goldEvidenceIds: ["shared-id"],
      goldObjectIds: ["shared-id"],
      answerSessionIds: ["answer-session"],
      deliveredResults: [
        {
          object_id: "shared-id",
          object_kind: "evidence_capsule",
          rank: 1,
          relevance_score: 0.9
        }
      ],
      hitAt1: true,
      hitAt5: true,
      hitAt10: true,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: {
        diagnostics: {
          candidates: [
            candidate("shared-id", "evidence_capsule", 1),
            candidate("shared-id", "memory_entry", 2)
          ]
        }
      }
    });

    expect(row).toMatchObject({
      gold_memory_ids: [],
      gold_evidence_ids: ["shared-id"],
      gold_object_ids: ["shared-id"],
      miss_classification: "hit_at_5",
      miss_taxonomy: null
    });
    expect(row.gold).toEqual([
      expect.objectContaining({
        object_id: "shared-id",
        object_kind: "evidence_capsule",
        candidate_status: "delivered",
        final_rank: 1
      })
    ]);
    expect(row.cohort_ledger).toMatchObject({
      extraction_materialization: {
        status: "evidence_preserved",
        emitted_memory_count: 0,
        reason: null
      },
      evaluator_gold_identity: {
        status: "present",
        object_ids: ["shared-id"]
      }
    });
    expect(LongMemEvalQuestionDiagnosticSchema.parse(row)).toEqual(row);
  });

  it("does not let a memory candidate with the same id satisfy evidence gold", () => {
    const row = buildQuestionDiagnostic({
      questionId: "q-cross-kind",
      goldMemoryIds: [],
      goldEvidenceIds: ["shared-id"],
      goldObjectIds: ["shared-id"],
      answerSessionIds: ["answer-session"],
      deliveredResults: [
        {
          object_id: "shared-id",
          object_kind: "memory_entry",
          rank: 1,
          relevance_score: 0.9
        }
      ],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: {
        diagnostics: {
          candidates: [candidate("shared-id", "memory_entry", 1)]
        }
      }
    });

    expect(row.gold[0]).toMatchObject({
      object_kind: "evidence_capsule",
      final_rank: null
    });
  });

  it("reads legacy rows as memory-only without redefining gold_memory_ids", () => {
    const parsed = LongMemEvalQuestionDiagnosticSchema.parse(legacyQuestion());

    expect(parsed.gold_memory_ids).toEqual(["memory-1"]);
    expect(parsed.gold_evidence_ids).toEqual([]);
    expect(readGoldObjectIds(parsed)).toEqual(["memory-1"]);
  });

  it("rejects evidence gold when the eligible union is silently omitted", () => {
    expect(() => LongMemEvalQuestionDiagnosticSchema.parse({
      ...legacyQuestion(),
      gold_evidence_ids: ["evidence-1"]
    })).toThrow(/gold_object_ids/u);
  });

  it("rejects evidence_preserved when no evidence gold identity exists", () => {
    const memoryDiagnostic = buildQuestionDiagnostic({
      questionId: "q-memory-only",
      goldMemoryIds: ["memory-1"],
      answerSessionIds: [],
      deliveredResults: [],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: { diagnostics: { candidates: [] } }
    });
    expect(() => LongMemEvalQuestionDiagnosticSchema.parse({
      ...memoryDiagnostic,
      cohort_ledger: {
        ...memoryDiagnostic.cohort_ledger,
        extraction_materialization: {
          status: "evidence_preserved",
          emitted_memory_count: 0,
          reason: null
        }
      }
    })).toThrow(/evidence-only gold identity/u);
  });

  it("reports all-object and memory-only full-gold coverage separately", () => {
    const row = {
      ...legacyQuestion(),
      gold_memory_ids: ["memory-1"],
      gold_evidence_ids: ["evidence-1"],
      gold_object_ids: ["memory-1", "evidence-1"],
      gold: [
        gold("memory-1", "memory_entry", 1),
        gold("evidence-1", "evidence_capsule", 8)
      ]
    } as unknown as LongMemEvalQuestionDiagnostic;

    const coverage = buildLongMemEvalDetailedGoldCoverage([row]);

    expect(coverage).toMatchObject({
      gold_bearing_questions: 1,
      full_gold_at_5: 0,
      gold_coverage_at_5: 0.5
    });
    expect(coverage.memory_only).toMatchObject({
      gold_bearing_questions: 1,
      full_gold_at_5: 1,
      gold_coverage_at_5: 1
    });
  });

  it("measures evidence identity and delivery without counting writer absence", () => {
    const diagnostic = buildQuestionDiagnostic({
      questionId: "q-evidence-quality",
      goldMemoryIds: [],
      goldEvidenceIds: ["evidence-1"],
      goldObjectIds: ["evidence-1"],
      answerSessionIds: ["answer-session"],
      deliveredResults: [
        {
          object_id: "evidence-1",
          object_kind: "evidence_capsule",
          rank: 1,
          relevance_score: 0.9
        }
      ],
      hitAt1: true,
      hitAt5: true,
      hitAt10: true,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: {
        diagnostics: {
          candidates: [candidate("evidence-1", "evidence_capsule", 1)]
        }
      }
    });
    const quality = buildLongMemEvalQualityMetrics([diagnostic]);
    const axes = buildQuestionMeasurementAxes({
      answer: "Blue option",
      answerSessionIds: ["answer-session"],
      sourceDatesBySession: new Map([
        ["answer-session", "2026-07-26T00:00:00.000Z"]
      ]),
      deliveredResults: diagnostic.delivered_results,
      candidates: diagnostic.candidates,
      sidecar: new Map([
        ["evidence_capsule:evidence-1", {
          objectId: "evidence-1",
          objectKind: "evidence_capsule",
          sessionId: "answer-session",
          hasAnswer: true
        }]
      ]),
      isAbstention: false,
      evaluatorGoldMemoryIds: [],
      evaluatorGoldEvidenceIds: ["evidence-1"],
      evaluatorGoldObjectIds: ["evidence-1"],
      evaluatorHitAt5: true
    });

    expect(quality).toMatchObject({
      candidate_absent_count: 0,
      object_kind_delivery: {
        memory_entry: 0,
        synthesis_capsule: 0,
        evidence_capsule: 1,
        total_delivered: 1
      }
    });
    expect(axes.evaluator_identity_integrity_at_5).toMatchObject({
      applicable: true,
      status: "consistent",
      exact_gold_count: 1,
      exact_memory_gold_count: 0,
      exact_evidence_gold_count: 1
    });
  });
});

function candidate(
  objectId: string,
  objectKind: "memory_entry" | "evidence_capsule",
  rank: number
) {
  return {
    object_id: objectId,
    object_kind: objectKind,
    origin_plane: "workspace_local",
    candidate_key: `workspace_local:${objectKind}:${objectId}`,
    final_rank: rank,
    pre_budget_rank: rank,
    selection_order: rank,
    fused_rank: rank,
    fused_score: 0.5,
    answer_features: {
      content: "The assistant recommended the Blue option",
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
    }
  };
}

function gold(
  objectId: string,
  objectKind: "memory_entry" | "evidence_capsule",
  finalRank: number
) {
  return {
    object_id: objectId,
    object_kind: objectKind,
    candidate_status: "delivered",
    final_rank: finalRank,
    active_constraint_rank: null,
    pre_budget_rank: finalRank,
    selection_order: finalRank,
    fused_rank: finalRank,
    fused_score: 0.5,
    per_stream_rank: null,
    fused_rank_contribution_per_stream: null,
    plane_first_admitted: null,
    plane_winning_admission: null,
    source_planes: [],
    miss_taxonomy: null,
    lexical_rank: null,
    structural_score: null,
    score_factors: null,
    source_channels: [],
    budget_drop_reason: null
  };
}

function legacyQuestion() {
  return {
    question_id: "q-legacy",
    round_index: null,
    gold_memory_ids: ["memory-1"],
    answer_session_ids: ["answer-session"],
    delivered_results: [],
    active_constraint_results: [],
    hit_at_1: true,
    hit_at_5: true,
    hit_at_10: true,
    miss_classification: "hit_at_5",
    degradation_reason: null,
    recall_diagnostics_present: true,
    recall_diagnostics_keys: [],
    provider_state: "provider_not_requested",
    provider_degradation_reason: null,
    graph_expansion_plane_count_per_hop: [0, 0],
    graph_expansion_plane_count_per_edge_type: {
      derives_from: 0,
      recalls: 0,
      supports: 0
    },
    candidate_key_collisions: [],
    gold: [gold("memory-1", "memory_entry", 1)]
  };
}
