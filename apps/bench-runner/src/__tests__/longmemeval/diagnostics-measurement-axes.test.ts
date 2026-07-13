import { describe, expect, it } from "vitest";
import {
  attachQuestionMeasurementAxes,
  buildQuestionMeasurementAxes,
  type QuestionMeasurementInput
} from "../../longmemeval/diagnostics-measurement-axes.js";
import { LongMemEvalQuestionMeasurementAxesSchema } from "../../longmemeval/diagnostics-schema.js";
import type { LongMemEvalQuestionDiagnostic } from "../../longmemeval/diagnostics-types.js";
import { renderLongMemEvalCohortLedger } from "../../longmemeval/cohort-ledger.js";
import { buildLongMemEvalQualityMetrics } from "../../longmemeval/diagnostics-quality.js";

type MeasurementCandidate = QuestionMeasurementInput["candidates"][number];
type AnswerFeatures = NonNullable<MeasurementCandidate["answer_features"]>;
type TemporalAnswerFeatures = Pick<
  AnswerFeatures,
  | "projection_schema_version"
  | "event_time_start"
  | "event_time_end"
  | "valid_from"
  | "valid_to"
  | "time_precision"
  | "time_source"
>;

function input(
  overrides: Partial<QuestionMeasurementInput> = {}
): QuestionMeasurementInput {
  return {
    answer: "Blue Jay",
    answerSessionIds: ["answer-a", "answer-b"],
    sourceDatesBySession: new Map([
      ["answer-a", "2026-01-01T00:00:00.000Z"],
      ["other", "2026-01-02T00:00:00.000Z"]
    ]),
    deliveredResults: [
      { object_id: "memory-a", rank: 1 },
      { object_id: "memory-other", rank: 2 },
      { object_id: "memory-b", rank: 6 }
    ],
    candidates: [
      candidate("memory-a", "A blue-jay landed nearby", null),
      candidate("memory-other", "Unrelated content", "BLUE JAY"),
      candidate("memory-b", "Blue Jay", null)
    ],
    sidecar: new Map([
      ["memory_entry:memory-a", sidecar("memory-a", "answer-a")],
      ["memory_entry:memory-other", sidecar("memory-other", "other")],
      ["memory_entry:memory-b", sidecar("memory-b", "answer-b")]
    ]),
    isAbstention: false,
    ...overrides
  };
}

function candidate(
  objectId: string,
  content: string,
  evidenceGist: string | null,
  temporal: Partial<TemporalAnswerFeatures> = {}
): MeasurementCandidate {
  return {
    object_id: objectId,
    candidate_key: `workspace_local:memory_entry:${objectId}`,
    answer_features: {
      content,
      evidence_gist: evidenceGist,
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
      preference_polarity: null,
      ...temporal
    }
  };
}

function sidecar(objectId: string, sessionId: string) {
  return {
    objectId,
    objectKind: "memory_entry" as const,
    sessionId,
    hasAnswer: false
  };
}

function answerSidecar(objectId: string, sessionId: string) {
  return { ...sidecar(objectId, sessionId), hasAnswer: true };
}

describe("LongMemEval measurement-only quality axes", () => {
  it("measures top-five answer-session coverage without changing gold identity", () => {
    const axes = buildQuestionMeasurementAxes(input());

    expect(axes.answer_session_coverage_at_5).toEqual({
      applicable: true,
      covered_count: 1,
      total_count: 2,
      ratio: 0.5,
      full_coverage: false
    });
  });

  it("records normalized literal witnesses as a lower bound from content or evidence gist", () => {
    const axes = buildQuestionMeasurementAxes(input());

    expect(axes.answer_literal_witness_lower_bound_at_5).toEqual({
      applicable: true,
      inspected_candidate_count: 2,
      matched_candidate_count: 2,
      witnessed: true,
      witnesses: [
        { object_id: "memory-a", object_kind: "memory_entry", rank: 1, field: "content" },
        { object_id: "memory-other", object_kind: "memory_entry", rank: 2, field: "evidence_gist" }
      ]
    });
  });

  it("counts source timestamps only when the delivered candidate joins to a dated source session", () => {
    const axes = buildQuestionMeasurementAxes(input());

    expect(axes.source_timestamp_availability_at_5).toEqual({
      source: "dataset_session_timestamp_join",
      candidate_count: 2,
      available_count: 2,
      ratio: 1,
      all_available: true
    });
  });

  it("reports runtime memory temporal projection separately from dataset timestamp joins", () => {
    const axes = buildQuestionMeasurementAxes(input({
      candidates: [
        candidate("memory-a", "Blue Jay", null, {
          projection_schema_version: 1,
          event_time_start: "2026-01-01",
          time_precision: "day",
          time_source: "explicit"
        }),
        candidate("memory-other", "Unrelated", null, {
          projection_schema_version: null,
          event_time_start: null,
          time_precision: null,
          time_source: null
        })
      ]
    }));

    expect(axes.memory_temporal_projection_integrity_at_5).toEqual({
      source: "runtime_candidate_answer_features",
      candidate_count: 2,
      projected_count: 1,
      provenance_complete_count: 1,
      integrity_ratio: 1
    });
  });

  it("keeps uncalibrated abstention separate from recall measurements", () => {
    const axes = buildQuestionMeasurementAxes(input({ isAbstention: true }));

    expect(axes.answer_session_coverage_at_5.applicable).toBe(false);
    expect(axes.answer_literal_witness_lower_bound_at_5.applicable).toBe(false);
    expect(axes.abstention).toEqual({ applicable: true, status: "uncalibrated" });
    expect(LongMemEvalQuestionMeasurementAxesSchema.parse(axes)).toEqual(axes);
  });

  it("rejects coverage applicability that contradicts abstention and target state", () => {
    const answerable = buildQuestionMeasurementAxes(input());
    expect(() => LongMemEvalQuestionMeasurementAxesSchema.parse({
      ...answerable,
      answer_session_coverage_at_5: {
        ...answerable.answer_session_coverage_at_5,
        applicable: false, covered_count: 0, ratio: null, full_coverage: false
      }
    })).toThrow(/applicability/u);

    const abstention = buildQuestionMeasurementAxes(input({ isAbstention: true }));
    expect(() => LongMemEvalQuestionMeasurementAxesSchema.parse({
      ...abstention,
      answer_session_coverage_at_5: {
        ...abstention.answer_session_coverage_at_5,
        applicable: true, ratio: 0
      }
    })).toThrow(/applicability/u);
  });

  it("attaches one identical additive contract to diagnostics and its cohort row", () => {
    const diagnostic = {
      question_id: "synthetic-question",
      cohort_ledger: { dataset_cohort: "answerable" }
    } as unknown as LongMemEvalQuestionDiagnostic;

    const attached = attachQuestionMeasurementAxes(diagnostic, input());

    expect(attached.quality_axes).toEqual(attached.cohort_ledger?.quality_axes);
    expect(diagnostic.quality_axes).toBeUndefined();
  });

  it("fails closed when an evaluator gold hit conflicts with both independent identity axes", () => {
    const diagnostic = {
      question_id: "synthetic-question",
      is_abstention: false,
      hit_at_5: true,
      gold_memory_ids: ["memory-a"],
      miss_classification: "hit_at_5",
      miss_taxonomy: null,
      delivered_results: [],
      gold: [],
      cohort_ledger: {
        dataset_cohort: "answerable",
        retrieval_status: "hit_at_5",
        evaluation_issue_reason: null,
        final_verdict: "hit_at_5"
      }
    } as unknown as LongMemEvalQuestionDiagnostic;
    const attached = attachQuestionMeasurementAxes(diagnostic, input({
      answerSessionIds: ["answer-b"],
      candidates: [
        candidate("memory-a", "Unrelated gold marker", null),
        candidate("memory-other", "Blue Jay", null)
      ],
      sidecar: new Map([
        ["memory_entry:memory-a", sidecar("memory-a", "other")],
        ["memory_entry:memory-other", sidecar("memory-other", "answer-b")]
      ])
    }));

    expect(attached.quality_axes?.evaluator_identity_integrity_at_5.status)
      .toBe("inconsistent");
    expect(attached.cohort_ledger).toMatchObject({
      measurement_status: "evaluator_identity_unscorable",
      retrieval_status: "not_applicable",
      evaluation_issue_reason: "evaluator_data_identity_inconsistency",
      final_verdict: "evaluator_data_identity_inconsistency"
    });
    expect(attached).toMatchObject({
      miss_classification: "evaluator_identity_inconsistent",
      miss_taxonomy: "evaluation_or_gold_issue",
      hit_at_5: true
    });
    expect(buildLongMemEvalQualityMetrics([attached]))
      .toMatchObject({ evaluator_identity_issue_count: 1 });
  });

  it("detects an exact miss when top-five independent evidence points to a different identity", () => {
    const diagnostic = {
      question_id: "synthetic-inverse-conflict",
      is_abstention: false,
      hit_at_5: false,
      gold_memory_ids: ["wrong-gold"],
      miss_classification: "candidate_absent",
      miss_taxonomy: "candidate_absent",
      delivered_results: [],
      gold: [],
      cohort_ledger: {
        dataset_cohort: "answerable",
        retrieval_status: "miss_at_5",
        evaluation_issue_reason: null,
        final_verdict: "miss_at_5"
      }
    } as unknown as LongMemEvalQuestionDiagnostic;
    const attached = attachQuestionMeasurementAxes(diagnostic, input({
      answerSessionIds: ["answer-a"],
      deliveredResults: [{ object_id: "answer-witness", rank: 1 }],
      candidates: [candidate("answer-witness", "Blue Jay", null)],
      sidecar: new Map([
        ["memory_entry:answer-witness", answerSidecar("answer-witness", "answer-a")]
      ])
    }));

    expect(attached.quality_axes?.evaluator_identity_integrity_at_5.status)
      .toBe("inconsistent");
    expect(attached.cohort_ledger).toMatchObject({
      retrieval_status: "not_applicable",
      evaluation_issue_reason: "evaluator_data_identity_inconsistency",
      final_verdict: "evaluator_data_identity_inconsistency"
    });
    expect(attached).toMatchObject({
      miss_classification: "evaluator_identity_inconsistent",
      miss_taxonomy: "evaluation_or_gold_issue",
      hit_at_5: false
    });
  });

  it("keeps a literal-bearing non-gold witness diagnostic-only on a miss", () => {
    const diagnostic = {
      question_id: "synthetic-session-neighbor",
      is_abstention: false,
      hit_at_5: false,
      gold_memory_ids: ["gold-memory"],
      miss_classification: "under_ranked",
      miss_taxonomy: "delivery_order_drop",
      delivered_results: [],
      gold: [],
      cohort_ledger: {
        dataset_cohort: "answerable",
        measurement_status: "scorable",
        retrieval_status: "miss_at_5",
        evaluation_issue_reason: null,
        final_verdict: "miss_at_5"
      }
    } as unknown as LongMemEvalQuestionDiagnostic;
    const attached = attachQuestionMeasurementAxes(diagnostic, input({
      answerSessionIds: ["answer-a"],
      deliveredResults: [{ object_id: "session-neighbor", rank: 1 }],
      candidates: [candidate("session-neighbor", "A Blue Jay appeared nearby", null)],
      sidecar: new Map([
        ["memory_entry:session-neighbor", sidecar("session-neighbor", "answer-a")]
      ])
    }));

    expect(attached.quality_axes?.evaluator_identity_integrity_at_5.status)
      .toBe("consistent");
    expect(attached.quality_axes?.answer_literal_witness_lower_bound_at_5)
      .toMatchObject({ witnessed: true, matched_candidate_count: 1 });
    expect(attached.cohort_ledger).toMatchObject({
      measurement_status: "scorable",
      retrieval_status: "miss_at_5",
      evaluation_issue_reason: null,
      final_verdict: "miss_at_5"
    });
  });

  it("keeps the additive axes reconstructable in the cohort ledger", () => {
    const diagnostic = attachQuestionMeasurementAxes({
      question_id: "synthetic-question",
      cohort_ledger: { dataset_cohort: "answerable" }
    } as unknown as LongMemEvalQuestionDiagnostic, input());

    const ledger = JSON.parse(renderLongMemEvalCohortLedger([diagnostic])) as {
      rows: Array<{ quality_axes?: unknown }>;
    };

    expect(ledger.rows[0]?.quality_axes).toEqual(diagnostic.quality_axes);
  });

  it("binds timestamp availability to the declared dataset-session join", () => {
    const axes = buildQuestionMeasurementAxes(input());

    expect(LongMemEvalQuestionMeasurementAxesSchema.parse(axes)).toEqual(axes);
    expect(() => LongMemEvalQuestionMeasurementAxesSchema.parse({
      ...axes,
      source_timestamp_availability_at_5: {
        ...axes.source_timestamp_availability_at_5,
        source: "runtime_candidate_timestamp"
      }
    })).toThrow();
  });

  it.each([
    ["coverage count", (axes: ReturnType<typeof buildQuestionMeasurementAxes>) => ({
      ...axes,
      answer_session_coverage_at_5: {
        ...axes.answer_session_coverage_at_5,
        covered_count: axes.answer_session_coverage_at_5.total_count + 1
      }
    })],
    ["coverage ratio", (axes: ReturnType<typeof buildQuestionMeasurementAxes>) => ({
      ...axes,
      answer_session_coverage_at_5: {
        ...axes.answer_session_coverage_at_5,
        ratio: 0.75
      }
    })],
    ["literal witness count", (axes: ReturnType<typeof buildQuestionMeasurementAxes>) => ({
      ...axes,
      answer_literal_witness_lower_bound_at_5: {
        ...axes.answer_literal_witness_lower_bound_at_5,
        matched_candidate_count:
          axes.answer_literal_witness_lower_bound_at_5.inspected_candidate_count + 1
      }
    })],
    ["timestamp count", (axes: ReturnType<typeof buildQuestionMeasurementAxes>) => ({
      ...axes,
      source_timestamp_availability_at_5: {
        ...axes.source_timestamp_availability_at_5,
        available_count: axes.source_timestamp_availability_at_5.candidate_count + 1
      }
    })]
  ])("rejects contradictory %s measurement axes", (_label, mutate) => {
    expect(() => LongMemEvalQuestionMeasurementAxesSchema.parse(
      mutate(buildQuestionMeasurementAxes(input()))
    )).toThrow();
  });
});
