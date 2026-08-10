import { describe, expect, it } from "vitest";
import { buildQuestionDiagnostic } from
  "../../../longmemeval/diagnostics/diagnostics-question.js";
import { LongMemEvalQuestionDiagnosticSchema } from
  "../../../longmemeval/diagnostics/schema/diagnostics-schema.js";

const digest = (value: string) => `sha256:${value.repeat(64)}`;

describe("LongMemEval open semantic factor diagnostics", () => {
  it("archives the exact formation, compatibility, composition, and activation receipts", () => {
    const formation = {
      schema_version: 1 as const,
      operator_id: "open_semantic_factor_formation_v1" as const,
      status: "unavailable" as const,
      producer_operator_id: null,
      source_sha256: null,
      graph: null,
      capture_digest: digest("1")
    };
    const compatibility = {
      schema_version: 1 as const,
      operator_id: "open_semantic_factor_compatibility_trace_v1" as const,
      query_capture_digest: formation.capture_digest,
      observed_evidence_count: 0,
      evaluated_evidence_count: 0,
      truncated: false,
      entries: [],
      trace_digest: digest("2")
    };
    const composition = {
      schema_version: 1 as const,
      operator_id: "open_semantic_factor_composition_v1" as const,
      status: "unavailable" as const,
      compatibility_trace_digest: compatibility.trace_digest,
      query_capture_digest: formation.capture_digest,
      result_variable_ids: [],
      search_step_count: 0,
      solution_count: 0,
      observed_binding_count: 0,
      binding_observation_count: 0,
      truncated: false,
      bindings: [],
      solutions: [],
      variable_collections: [],
      receipt_digest: digest("3")
    };
    const activation = {
      schema_version: 1 as const,
      operator_id: "open_semantic_solution_membership_activation_v1" as const,
      status: "unavailable" as const,
      composition_receipt_digest: composition.receipt_digest,
      entry_count: 0,
      truncated: false,
      entries: [],
      missing_evidence_policy: "no_op" as const,
      ranking_effect: "candidate_attribution" as const,
      receipt_digest: digest("4")
    };
    const row = buildQuestionDiagnostic({
      questionId: "q-open-semantic-factor-receipts",
      goldMemoryIds: [],
      answerSessionIds: [],
      deliveredResults: [],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: { diagnostics: {
        query_open_semantic_factor_formation: formation,
        open_semantic_factor_compatibility_trace: compatibility,
        open_semantic_factor_composition: composition,
        open_semantic_factor_activation: activation,
        candidates: []
      } }
    });

    expect(LongMemEvalQuestionDiagnosticSchema.parse(row)).toMatchObject({
      query_open_semantic_factor_formation: formation,
      open_semantic_factor_compatibility_trace: compatibility,
      open_semantic_factor_composition: composition,
      open_semantic_factor_activation: activation
    });
  });
});
