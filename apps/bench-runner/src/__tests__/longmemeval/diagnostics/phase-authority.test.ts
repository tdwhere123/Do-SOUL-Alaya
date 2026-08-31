import { describe, expect, it } from "vitest";
import {
  PRODUCT_PHASES,
  assertProductPhaseAuthority,
  readProductPhaseAuthority
} from "../../../diagnostics/phase/phase-authority.js";
import { LongMemEvalQuestionDiagnosticSchema } from
  "../../../diagnostics/schema/diagnostics-schema.js";

describe("product phase authority", () => {
  it("keeps formation through delivery explicit and does not treat top-5 rank as delivery", () => {
    expect(PRODUCT_PHASES).toEqual([
      "formation", "composition", "activation", "selection", "delivery"
    ]);
    const rankingOnly = readProductPhaseAuthority({
      candidates: [{ final_rank: 1 }]
    });
    expect(rankingOnly.selection.authority).toBe("not_observed");
    expect(rankingOnly.delivery).toEqual({
      phase: "delivery", status: null, authority: "not_observed"
    });
    expect(readProductPhaseAuthority({
      candidates: [{
        selection_order: 1,
        admission_attempts: [{ admitted: true }],
        final_rank: 7
      }]
    }).delivery).toEqual({
      phase: "delivery", status: null, authority: "not_observed"
    });

    const ledger = readProductPhaseAuthority({
      query_open_semantic_factor_formation: { status: "formed" },
      open_semantic_factor_composition: { status: "composed" },
      open_semantic_factor_activation: { status: "composed" },
      candidates: [{
        selection_order: 1,
        admission_attempts: [{ admitted: true }],
        final_rank: 7
      }],
      delivered_results: [{ object_id: "memory:1" }]
    });
    expect(ledger.formation).toMatchObject({ status: "formed", authority: "product" });
    expect(ledger.selection.status).toBe("selected");
    expect(ledger.delivery.status).toBe("delivered");
    expect(assertProductPhaseAuthority({
      query_open_semantic_factor_formation: { status: "formed" },
      open_semantic_factor_composition: { status: "no_match" }
    }).composition.status).toBe("no_match");
  });

  it("marks archived composition as diagnostic-only and empty packs as not delivered", () => {
    const archived = readProductPhaseAuthority({
      query_open_semantic_factor_formation: { status: "formed" },
      open_semantic_factor_composition: { status: "composed" },
      open_semantic_factor_archive: { replayable: false }
    });
    expect(archived.composition.authority).toBe("diagnostic_only");
    expect(archived.activation.authority).toBe("diagnostic_only");

    const emptyQuestion = {
      candidates: [{
        selection_order: 1,
        admission_attempts: [{ admitted: true }]
      }],
      delivered_results: []
    };
    const emptyPack = readProductPhaseAuthority(emptyQuestion);
    expect(emptyPack.selection.status).toBe("selected");
    expect(emptyPack.delivery).toEqual({
      phase: "delivery", status: "not_delivered", authority: "product"
    });
    expect(() => assertProductPhaseAuthority(emptyQuestion)).not.toThrow();
  });

  it("keeps selected-but-omitted delivery as not_observed for partial helpers", () => {
    const selectedWithoutDelivery = {
      candidates: [{
        selection_order: 1,
        admission_attempts: [{ admitted: true }]
      }]
    };
    const ledger = readProductPhaseAuthority(selectedWithoutDelivery);
    expect(ledger.selection).toEqual({
      phase: "selection", status: "selected", authority: "product"
    });
    expect(ledger.delivery).toEqual({
      phase: "delivery", status: null, authority: "not_observed"
    });
    expect(() => assertProductPhaseAuthority(selectedWithoutDelivery)).not.toThrow();
  });

  it("uses the canonical capture receipt as the product selection observation", () => {
    const selected = assertProductPhaseAuthority({
      open_semantic_factor_activation: { status: "composed" },
      capture_receipt: {
        execution: { status: "captured", reason: null },
        dispositions: [{
          candidate_key: "candidate:a",
          status: "selected",
          reason: "selected_by_gamma"
        }]
      }
    });
    expect(selected.selection).toEqual({
      phase: "selection", status: "selected", authority: "product"
    });

    const failClosed = assertProductPhaseAuthority({
      open_semantic_factor_activation: { status: "composed" },
      capture_receipt: {
        execution: { status: "fail_closed", reason: "invalid_state" },
        dispositions: [{
          candidate_key: "candidate:a",
          status: "unavailable",
          reason: "fail_closed_unavailable"
        }]
      }
    });
    expect(failClosed.selection).toEqual({
      phase: "selection", status: "not_selected", authority: "product"
    });
  });

  it("rejects a live question that omits delivered_results", () => {
    const live = {
      question_id: "q-live",
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
      recall_diagnostics_present: false,
      recall_diagnostics_keys: [],
      provider_state: "provider_not_requested",
      provider_degradation_reason: null,
      graph_expansion_plane_count_per_hop: [0, 0],
      graph_expansion_plane_count_per_edge_type: {
        derives_from: 0, recalls: 0, supports: 0
      },
      candidate_key_collisions: [],
      gold: []
    };
    expect(() => LongMemEvalQuestionDiagnosticSchema.parse(live)).not.toThrow();
    const { delivered_results: _omitted, ...missingDelivery } = live;
    expect(() => LongMemEvalQuestionDiagnosticSchema.parse(missingDelivery)).toThrow();
  });

  it("fail-closes silent drops and unrecognized statuses", () => {
    expect(() => assertProductPhaseAuthority({
      query_open_semantic_factor_formation: { status: "formed" }
    })).toThrow(/silently dropped before composition/u);
    expect(() => assertProductPhaseAuthority({
      open_semantic_factor_composition: { status: "composed" }
    })).toThrow(/silently dropped before activation/u);
    expect(() => assertProductPhaseAuthority({
      open_semantic_factor_activation: { status: "composed" },
      candidates: []
    })).toThrow(/no explicit selection observation/u);
    expect(readProductPhaseAuthority({
      fine_assessment_pruned_candidates: [{ candidate_key: "pruned" }],
      candidates: [{ final_rank: 1 }]
    }).delivery.authority).toBe("not_observed");
    expect(() => readProductPhaseAuthority({
      query_open_semantic_factor_formation: { status: "selected" }
    })).toThrow(/unrecognized product phase status/u);
    for (const status of ["rejected", "unavailable", "ineligible"] as const) {
      const ledger = assertProductPhaseAuthority({
        query_open_semantic_factor_formation: { status },
        open_semantic_factor_composition: { status },
        open_semantic_factor_activation: { status }
      });
      expect(ledger.formation).toEqual({
        phase: "formation", status, authority: "product"
      });
      expect(ledger.composition.status).toBe(status);
      expect(ledger.activation.status).toBe(status);
      expect(ledger.delivery.authority).toBe("not_observed");
    }
  });
});
