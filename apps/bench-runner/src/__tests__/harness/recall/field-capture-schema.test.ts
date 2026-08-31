import { describe, expect, it } from "vitest";
import {
  captureRecallQueryEntities,
  captureRecallQueryFactFrames,
  createRecallRetrievalFieldRefinementReceipt,
  materializeRecallRetrievalFieldCaptures,
  RECALL_FIELD_SELECTOR_EXCHANGE_BOUND_OPERATOR_ID,
  RECALL_RETRIEVAL_FIELD_CHANNEL_CATALOG_V1
} from "@do-soul/alaya-core";
import { LongMemEvalQuestionDiagnosticSchema } from
  "../../../diagnostics/schema/diagnostics-schema.js";
import { buildQuestionDiagnostic } from
  "../../../diagnostics/diagnostics-question.js";

describe("recall field capture persistence", () => {
  it("preserves the fixed retrieval catalog and query entity receipt", async () => {
    const retrievalFieldCaptures = materializeRecallRetrievalFieldCaptures([]);
    const refinementReceipt = createRecallRetrievalFieldRefinementReceipt({
      request_digest: `sha256:${"a".repeat(64)}`,
      requested_depth: 1,
      object_kind: "memory_entry",
      result: {
        matches: [{ object_id: "memory-1", normalized_rank: 1 }],
        lanes: [
          emptyLane("exact"),
          {
            lane: "porter",
            status: "complete",
            depth: 1,
            observations: [{ object_id: "memory-1", rank: 1, normalized_rank: 1 }],
            unseen_upper_bound: 0
          },
          emptyLane("trigram")
        ]
      }
    });
    if (refinementReceipt === null) throw new Error("refinement receipt missing");
    const queryEntityExtraction = await captureRecallQueryEntities({ query_text: null });
    const queryFactFrameExtraction = await captureRecallQueryFactFrames({ query_text: null });
    const stopCertificate = {
      schema_version: 1 as const,
      operator_id: RECALL_FIELD_SELECTOR_EXCHANGE_BOUND_OPERATOR_ID,
      activation_mode: "live" as const,
      field_seal_digest: `sha256:${"b".repeat(64)}`,
      refinement_receipt_digests: [refinementReceipt.receipt_digest],
      objective: {
        schema_version: 1 as const,
        operator_id: "duplicate_gist_penalty_v1",
        mathematical_class: null,
        configuration_digest: null
      },
      relevance_upper_bound: null,
      selection_capacity: 0,
      selected_candidate_keys: [],
      exchange_bounds: [],
      maximum_exchange_improvement_upper_bound: null,
      status: "certified" as const,
      reason: "all_channels_closed" as const,
      candidate_membership_changed: false as const,
      receipt_digest: `sha256:${"c".repeat(64)}`
    };
    const diagnostic = buildQuestionDiagnostic({
      questionId: "field-capture-round-trip",
      goldMemoryIds: [],
      answerSessionIds: [],
      deliveredResults: [],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      degradationReason: null,
      recallResult: {
        diagnostics: {
          retrieval_field_captures: retrievalFieldCaptures,
          retrieval_field_refinement_receipts: [refinementReceipt],
          field_refinement_stop_certificate: stopCertificate,
          query_entity_extraction: queryEntityExtraction,
          query_fact_frame_extraction: queryFactFrameExtraction
        }
      },
      embeddingMode: "disabled"
    });

    const parsed = LongMemEvalQuestionDiagnosticSchema.parse(diagnostic);
    expect(parsed.retrieval_field_captures).toHaveLength(
      RECALL_RETRIEVAL_FIELD_CHANNEL_CATALOG_V1.length
    );
    expect(parsed.retrieval_field_captures?.every(({ channel }) =>
      channel.status === "unavailable")).toBe(true);
    expect(parsed.retrieval_field_refinement_receipts?.[0]?.receipt_digest)
      .toBe(refinementReceipt.receipt_digest);
    expect(parsed.field_refinement_stop_certificate?.reason)
      .toBe("all_channels_closed");
    expect(parsed.query_entity_extraction?.status).toBe("ineligible");
    expect(parsed.query_entity_extraction?.capture_digest)
      .toBe(queryEntityExtraction.capture_digest);
    expect(parsed.query_fact_frame_extraction?.status).toBe("ineligible");
    expect(parsed.query_fact_frame_extraction?.capture_digest)
      .toBe(queryFactFrameExtraction.capture_digest);
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

function emptyLane(lane: "exact" | "trigram") {
  return {
    lane,
    status: "ineligible" as const,
    depth: 0,
    observations: [],
    unseen_upper_bound: null
  };
}
