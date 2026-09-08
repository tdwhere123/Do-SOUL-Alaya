import { describe, expect, it } from "vitest";
import { InformationIndexSchema, type MemorySearchResult } from "@do-soul/alaya-protocol";
import { measureConditionalFieldResponse } from "../../../runs/measurement/conditional-field-measurement.js";
import { buildQuestionDiagnostic } from "../../../diagnostics/diagnostics-question.js";
import { LongMemEvalQuestionDiagnosticSchema } from "../../../diagnostics/schema/diagnostics-schema.js";
import { classifyQuestionMeasurementStatus } from "../../../runs/measurement/question-validity.js";
import { reclassifyQuestionDiagnostic } from "../../../diagnostics/miss/reclassify-question-diagnostics.js";

const NOW = "2026-09-08T00:00:00.000Z";
const SNAPSHOT = `sha256:${"a".repeat(64)}`;
const BUDGET = { schema_version: 1 as const, work_units: 10000, memory_bytes: 1000000,
  page_budget: 10, finalization_reserve: 100, min_envelope: 10 };
const SECRET = "private source body must never appear in a measurement artifact";

function fixture(ids = ["gold"] ) {
  const index = InformationIndexSchema.parse({
    schema_version: 1, query_id: "query-observed", snapshot_id: SNAPSHOT, result_version: "v1",
    interpretation_id: "interpretation-observed", as_of: NOW,
    entries: ids.map((object_id, offset) => ({ schema_version: 1, object_id,
      hypothesis_id: `h${offset}`, output_binding: `binding${offset}`, role: "requested",
      association_milligrades: 850, claim: "unknown", explanation_ids: ["unresolved-explanation"] })),
    completeness: { schema_version: 1, logical_index: "open", observed_coverage: "open",
      interpretation_coverage: "open", transport: "partial", payload: "complete", representation: "complete" },
    continuation: { schema_version: 1, continuation_id: "next", query_id: "query-observed",
      snapshot_id: SNAPSHOT, result_version: "v1", cursor: "cursor", expires_at: "2099-01-01T00:00:00.000Z",
      interpretation_id: "interpretation-observed", interpretation_clock: NOW },
    representation: { schema_version: 1, policy: "construct_index_then_page_then_payload",
      page_budget: 10, identity_tie_break: "serialization" }
  });
  const results: MemorySearchResult[] = index.entries.map((entry) => ({
    object_id: entry.object_id, object_kind: "memory_entry", relevance_score: 0.85,
    content_preview: SECRET, evidence_pointers: [], selection_reason: "observed association",
    hypothesis_id: entry.hypothesis_id, output_binding: entry.output_binding,
    source_channels: ["conditional_field"], score_factors: { activation: 0.85, relevance: 0.85 },
    budget_state: { token_estimate: 1, max_entries: 10, max_total_tokens: 2000,
      remaining_entries: 0, remaining_tokens: 0, within_budget: true }
  }));
  const recallResult = { delivery_id: "delivery", protocol_version: 1, index, results,
    total_count: results.length, strategy_mix: { deterministic_match: true, precomputed_rank: false,
      semantic_supplement: false, graph_support: false, path_plasticity: false, global_recall: false },
    provider_calls: 0, garden_enqueue: 0, request_budget: BUDGET };
  const deliveredResults = results.slice(0, 10).map((row, offset) => ({
    object_id: row.object_id, object_kind: row.object_kind, rank: offset + 1, relevance_score: row.relevance_score
  }));
  return { recallResult, deliveredResults, queryText: "deployment checklist", referenceTime: NOW,
    expectedIndexSnapshotId: SNAPSHOT, requestBudget: BUDGET, recallLatencyMs: 12 };
}

function diagnostic(input = fixture(), hitAt5 = true) {
  return buildQuestionDiagnostic({ ...input, questionId: "q1", goldMemoryIds: ["gold"],
    answerSessionIds: ["session"], hitAt1: hitAt5, hitAt5, hitAt10: hitAt5,
    degradationReason: null, embeddingMode: "disabled" });
}

describe("conditional target measurement evidence", () => {
  it("makes observed target delivery scorable without claiming complete pool or legacy diagnostics", () => {
    const row = diagnostic();
    expect(classifyQuestionMeasurementStatus(row)).toBe("scorable");
    expect(row.recall_diagnostics_present).toBe(false);
    expect(row.recall_diagnostics_keys).toEqual([]);
    expect(row.candidate_pool_complete).toBe(false);
    expect(row.cohort_ledger).toMatchObject({ evaluation_issue_reason: null, evidence_status: "partial" });
    expect(row.conditional_field_measurement).toMatchObject({ status: "validated",
      comparison: "non_equivalent_to_legacy_ranked_candidate_pool",
      completeness: { logical_index: "open", interpretation_coverage: "open", transport: "partial" },
      request: { budget: BUDGET }, metrics: { latency_ms: 12, resolved_explanation_reference_count: 0,
        explanation_correctness: { status: "unavailable", value: null }, work: { status: "unavailable", value: null } } });
    expect(JSON.stringify(row)).not.toContain(SECRET);
    expect(LongMemEvalQuestionDiagnosticSchema.parse(row).conditional_field_measurement).toEqual(row.conditional_field_measurement);
  });

  it("keeps misses in the fixed evaluator universe without calling an unseen index entry candidate-absent", () => {
    const row = diagnostic(fixture(["other"]), false);
    expect(classifyQuestionMeasurementStatus(row)).toBe("scorable");
    expect(row.miss_taxonomy).toBeNull();
    expect(row.gold[0]?.candidate_status).toBe("unknown");
    expect(reclassifyQuestionDiagnostic(row)).toEqual(row);
  });

  it("preserves duplicate objects as distinct serialized slots and retains exact continuation identity", () => {
    const measured = measureConditionalFieldResponse(fixture(["gold", "gold"]));
    expect(measured?.status).toBe("validated");
    if (measured?.status !== "validated") throw new Error("valid metric expected");
    expect(measured.evaluated_slots.map((slot) => [slot.rank, slot.object_id, slot.hypothesis_id]))
      .toEqual([[1, "gold", "h0"], [2, "gold", "h1"]]);
    expect(measured.metrics).toMatchObject({ index_entry_count: 2, distinct_object_count: 1 });
    expect(measured.continuation?.snapshot_id).toBe(measured.identity.snapshot_id);
  });

  it("rejects malformed index and absent or nonzero provider evidence despite gold delivery", () => {
    const input = fixture();
    for (const recallResult of [
      { ...input.recallResult, index: {} },
      { ...input.recallResult, provider_calls: undefined },
      { ...input.recallResult, provider_calls: 1 },
      { ...input.recallResult, garden_enqueue: 1 }
    ]) {
      const row = buildQuestionDiagnostic({ ...input, recallResult, questionId: "bad",
        goldMemoryIds: ["gold"], answerSessionIds: ["session"], hitAt1: true, hitAt5: true,
        hitAt10: true, degradationReason: null, embeddingMode: "disabled" });
      expect(row.conditional_field_measurement?.status).toBe("invalid");
      expect(classifyQuestionMeasurementStatus(row)).toBe("evaluator_identity_unscorable");
    }
  });

  it("rejects mismatched snapshot, budget, continuation or evaluated delivery slot", () => {
    const input = fixture();
    expect(measureConditionalFieldResponse({ ...input, expectedIndexSnapshotId: `sha256:${"b".repeat(64)}` }))
      .toMatchObject({ status: "invalid", reason: "snapshot_mismatch" });
    expect(measureConditionalFieldResponse({ ...input, requestBudget: { ...BUDGET, work_units: 9 } }))
      .toMatchObject({ status: "invalid", reason: "request_budget_mismatch" });
    expect(measureConditionalFieldResponse({ ...input, requestBudget: undefined,
      recallResult: { ...input.recallResult, request_budget: undefined } }))
      .toMatchObject({ status: "invalid", reason: "missing_request_budget" });
    expect(measureConditionalFieldResponse({ ...input, recallResult: { ...input.recallResult,
      index: { ...input.recallResult.index, representation: { ...input.recallResult.index.representation, page_budget: 9 } } } }))
      .toMatchObject({ status: "invalid", reason: "request_budget_mismatch" });
    expect(measureConditionalFieldResponse({ ...input, deliveredResults: [] }))
      .toMatchObject({ status: "invalid", reason: "evaluated_slot_mismatch" });
    expect(measureConditionalFieldResponse({ ...input, recallResult: { ...input.recallResult,
      index: { ...input.recallResult.index, continuation: { ...input.recallResult.index.continuation!, query_id: "foreign" } } } }))
      .toMatchObject({ status: "invalid", reason: "continuation_identity_mismatch" });
  });

  it("excludes unusable source states from KPI denominators despite schema-valid gold delivery", () => {
    for (const axis of ["logical_index", "observed_coverage"] as const) {
      for (const state of ["resource_rejected", "cancelled", "invalidated", "unavailable", "interrupted", "unknown", "omitted", "not_applicable"] as const) {
        const input = fixture();
        const row = diagnostic({ ...input, recallResult: { ...input.recallResult,
          index: { ...input.recallResult.index,
            completeness: { ...input.recallResult.index.completeness, [axis]: state } } } });
        expect(row.conditional_field_measurement).toMatchObject({ status: "invalid", reason: "unusable_source_state" });
        expect(classifyQuestionMeasurementStatus(row)).toBe("evaluator_identity_unscorable");
      }
    }
  });
});
