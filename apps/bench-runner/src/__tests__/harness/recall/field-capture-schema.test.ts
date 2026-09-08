import { describe, expect, it } from "vitest";
import { RECALL_FIELD_SELECTOR_EXCHANGE_BOUND_OPERATOR_ID } from "@do-soul/alaya-protocol";
import { LongMemEvalQuestionDiagnosticSchema } from
  "../../../diagnostics/schema/diagnostics-schema.js";
import { buildQuestionDiagnostic } from
  "../../../diagnostics/diagnostics-question.js";

describe("recall field capture persistence", () => {
  it("round-trips archived field metadata without its retired producers", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const retrieval = ["lexical_relaxed_exact", "evidence_fts_porter", "explicit_pointer"].map((channel_id) => ({
      schema_version: 1, operator_id: "recall_finite_field_channel_capture_v1",
      source_snapshot_digest: digest, capture_digest: digest,
      channel: { channel_id, status: "unavailable", depth: 0, observations: [], unseen_upper_bound: null }
    }));
    const diagnostic = buildQuestionDiagnostic({
      questionId: "archived-field-capture", goldMemoryIds: [], answerSessionIds: [], deliveredResults: [],
      hitAt1: false, hitAt5: false, hitAt10: false, degradationReason: null, embeddingMode: "disabled",
      recallResult: { diagnostics: {
        retrieval_field_captures: retrieval,
        query_entity_extraction: {
          schema_version: 1, operator_id: "query_entity_extraction_capture_v1", status: "ineligible",
          query_text_digest: digest, producer_operator_id: null, candidates: [], capture_digest: digest
        }
      } }
    });
    const parsed = LongMemEvalQuestionDiagnosticSchema.parse(diagnostic);
    expect(parsed.retrieval_field_captures).toEqual(retrieval);
    expect(parsed.query_entity_extraction?.status).toBe("ineligible");
    expect(() => LongMemEvalQuestionDiagnosticSchema.parse({
      ...diagnostic,
      retrieval_field_captures: [{ ...retrieval[0], channel: { ...retrieval[0]!.channel, channel_id: "invented" } }]
    })).toThrow();
  });

  it("accepts dynamic selection capacity and rejects inconsistent membership", () => {
    const base = stopCertificateWithSelection(6, [
      "candidate-1",
      "candidate-2",
      "candidate-3",
      "candidate-4",
      "candidate-5",
      "candidate-6"
    ]);

    expect(LongMemEvalQuestionDiagnosticSchema.parse({
      ...emptyQuestionDiagnostic(),
      field_refinement_stop_certificate: base
    }).field_refinement_stop_certificate?.selection_capacity).toBe(6);
    expect(() => LongMemEvalQuestionDiagnosticSchema.parse({
      ...emptyQuestionDiagnostic(),
      field_refinement_stop_certificate: {
        ...base,
        selection_capacity: 5
      }
    })).toThrow();
  });
});

function stopCertificateWithSelection(
  selectionCapacity: number,
  selectedCandidateKeys: readonly string[]
) {
  return {
    schema_version: 1 as const,
    operator_id: RECALL_FIELD_SELECTOR_EXCHANGE_BOUND_OPERATOR_ID,
    activation_mode: "live" as const,
    field_seal_digest: `sha256:${"b".repeat(64)}`,
    refinement_receipt_digests: [],
    objective: {
      schema_version: 1 as const,
      operator_id: "duplicate_gist_penalty_v1",
      mathematical_class: null,
      configuration_digest: null
    },
    relevance_upper_bound: null,
    selection_capacity: selectionCapacity,
    selected_candidate_keys: selectedCandidateKeys,
    exchange_bounds: selectedCandidateKeys.map((candidateKey) => ({
      removed_candidate_key: candidateKey,
      incumbent_loss: 0,
      unseen_gain_upper_bound: 0,
      improvement_upper_bound: 0
    })),
    maximum_exchange_improvement_upper_bound: 0,
    status: "certified" as const,
    reason: "exchange_dominated" as const,
    candidate_membership_changed: false as const,
    receipt_digest: `sha256:${"c".repeat(64)}`
  };
}

function emptyQuestionDiagnostic() {
  return {
    question_id: "field-selection-capacity",
    round_index: null,
    gold_memory_ids: [],
    answer_session_ids: [],
    delivered_results: [],
    active_constraint_results: [],
    hit_at_1: false,
    hit_at_5: false,
    hit_at_10: false,
    miss_classification: "no_gold",
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
    gold: []
  };
}
