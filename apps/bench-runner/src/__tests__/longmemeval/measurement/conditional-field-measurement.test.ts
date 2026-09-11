import { describe, expect, it } from "vitest";
import { compileConditionalFieldQuery, interpretationIdentity } from "@do-soul/alaya-core";
import { InformationIndexSchema, type MemorySearchResult } from "@do-soul/alaya-protocol";
import { measureConditionalFieldResponse, ConditionalFieldMeasurementSchema } from "../../../runs/measurement/conditional-field-measurement.js";
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
  const compile_input = { source: "ordinary" as const, text: "deployment checklist",
    snapshot_id: SNAPSHOT, budget: BUDGET, interpretation_clock: NOW };
  const query_id = compileConditionalFieldQuery(compile_input).query_id;
  const interpretation_id = interpretationIdentity({ interpretation_clock: NOW });
  const execution_receipt = { schema_version: 1 as const, workspace_id: "workspace", requested_budget: BUDGET,
    compile_input, query_id, interpretation_id, snapshot_id: SNAPSHOT, interpretation_clock: NOW };
  const index = InformationIndexSchema.parse({
    schema_version: 1, query_id, snapshot_id: SNAPSHOT, result_version: "v1",
    interpretation_id, as_of: NOW,
    entries: ids.map((object_id, offset) => ({ schema_version: 1, object_id,
      target: { kind: "memory_entry" as const, workspace_id: "workspace", object_id, source_revision: "rev" },
      hypothesis_id: `h${offset}`, output_binding: `binding${offset}`, role: "requested",
      association_milligrades: 850, claim: "unknown", explanation_ids: ["unresolved-explanation"],
      program_state: "matched", time_state: "current" })),
    completeness: { schema_version: 1, logical_index: "open", observed_coverage: "open",
      interpretation_coverage: "open", transport: "partial", payload: "complete", representation: "complete" },
    continuation: { schema_version: 1, continuation_id: "next", query_id,
      snapshot_id: SNAPSHOT, result_version: "v1", cursor: "cursor", expires_at: "2099-01-01T00:00:00.000Z",
      interpretation_id, interpretation_clock: NOW },
    representation: { schema_version: 1, policy: "construct_index_then_page_then_payload",
      page_budget: 10, identity_tie_break: "serialization" }
  });
  const results: MemorySearchResult[] = index.entries.map((entry) => ({
    object_id: entry.object_id, object_kind: "memory_entry", target: entry.target, relevance_score: 0.85,
    content_preview: SECRET, evidence_pointers: [], selection_reason: "observed association",
    hypothesis_id: entry.hypothesis_id, output_binding: entry.output_binding,
    program_state: entry.program_state, time_state: entry.time_state,
    source_channels: ["conditional_field"], score_factors: { activation: 0.85, relevance: 0.85 },
    budget_state: { token_estimate: 1, max_entries: 10, max_total_tokens: 2000,
      remaining_entries: 0, remaining_tokens: 0, within_budget: true }
  }));
  const recallResult = { delivery_id: "delivery", protocol_version: 1, index, results,
    total_count: results.length,
    provider_calls: 0, garden_enqueue: 0, request_budget: BUDGET, execution_receipt };
  const deliveredResults = results.slice(0, 10).map((row, offset) => ({
    object_id: row.object_id, target: row.target, object_kind: row.object_kind, rank: offset + 1, relevance_score: row.relevance_score
    , hypothesis_id: row.hypothesis_id, output_binding: row.output_binding, program_state: row.program_state, time_state: row.time_state
  }));
  return { recallResult, deliveredResults, queryText: "deployment checklist", workspaceId: "workspace", referenceTime: NOW,
    expectedIndexSnapshotId: SNAPSHOT, requestBudget: BUDGET, recallLatencyMs: 12 };
}

function diagnostic(input = fixture(), hitAt5 = true) {
  return buildQuestionDiagnostic({ ...input, questionId: "q1", goldMemoryIds: ["gold"],
    answerSessionIds: ["session"], hitAt1: hitAt5, hitAt5, hitAt10: hitAt5,
    degradationReason: null, embeddingMode: "disabled" });
}

describe("conditional target measurement evidence", () => {
  it("preserves source-only identity through diagnostics, archived admission and reclassification", () => {
    const base = fixture();
    const target = { kind: "source_evidence" as const, workspace_id: "workspace", root_kind: "source_record" as const,
      root_id: "root", source_version: "v1", content_digest: SNAPSHOT, evidence_object_id: null };
    const { object_id: _entryId, ...entry } = base.recallResult.index.entries[0]!;
    const { object_id: _resultId, ...result } = base.recallResult.results[0]!;
    const delivered = { target, object_kind: "source_evidence", rank: 1, relevance_score: result.relevance_score,
      hypothesis_id: result.hypothesis_id, output_binding: result.output_binding, program_state: result.program_state, time_state: result.time_state };
    const input = { ...base, deliveredResults: [delivered], recallResult: { ...base.recallResult,
      index: { ...base.recallResult.index, entries: [{ ...entry, target }] },
      results: [{ ...result, object_kind: "source_evidence", target }] } };
    const diagnostic = buildQuestionDiagnostic({ ...input, questionId: "source", goldMemoryIds: ["gold"], answerSessionIds: ["session"],
      hitAt1: false, hitAt5: false, hitAt10: false, degradationReason: null, embeddingMode: "disabled" });
    expect(diagnostic.conditional_field_measurement?.status).toBe("validated");
    expect(diagnostic.delivered_results[0]).not.toHaveProperty("object_id");
    expect(diagnostic.delivered_results[0]?.target).toEqual(target);
    const archived = LongMemEvalQuestionDiagnosticSchema.parse(JSON.parse(JSON.stringify(diagnostic)));
    expect(reclassifyQuestionDiagnostic(archived).conditional_field_measurement?.status).toBe("validated");
    expect(classifyQuestionMeasurementStatus(archived)).toBe("scorable");
    expect(measureConditionalFieldResponse({ ...input, deliveredResults: [{ ...delivered, output_binding: "foreign-binding" }] })?.status).toBe("invalid");
  });

  it("preserves optional worker actual-cost fields on a validated measurement receipt", () => {
    const input = fixture();
    const execution_receipt = {
      ...input.recallResult.execution_receipt,
      worker: {
        native_visits: 9, bytes_read: 256, row_visits: 9, elapsed_ms: 3,
        rss_bytes: process.memoryUsage().rss, rss_sampling_method: "process.memoryUsage().rss" as const
      }
    };
    const measured = measureConditionalFieldResponse({
      ...input, recallResult: { ...input.recallResult, execution_receipt }
    });
    expect(measured?.status).toBe("validated");
    if (measured?.status !== "validated") throw new Error("validated measurement expected");
    expect(measured.request.execution_receipt.worker?.native_visits).toBe(9);
    expect(measured.request.execution_receipt.worker?.rss_sampling_method).toBe("process.memoryUsage().rss");
    expect(measured.request.execution_receipt.worker?.native_visits).not.toBe(BUDGET.work_units);
    expect(measured.request.execution_receipt.native_visits).toBeUndefined();
  });
  it("rejects a result whose tagged target revision differs from its index entry", () => {
    const input = fixture();
    const results = input.recallResult.results.map((result) => ({ ...result,
      target: { kind: "memory_entry" as const, workspace_id: "workspace", object_id: "gold", source_revision: "foreign-revision" }
    }));
    expect(measureConditionalFieldResponse({ ...input, recallResult: { ...input.recallResult, results } }))
      .toMatchObject({ status: "invalid", reason: "foreign_target_revision" });
  });

  it("rejects archived slots with foreign tagged target revisions", () => {
    const measured = measureConditionalFieldResponse(fixture());
    if (measured?.status !== "validated") throw new Error("valid fixture expected");
    const foreign = (slot: (typeof measured.response_slots)[number]) => ({ ...slot,
      target: { kind: "memory_entry" as const, workspace_id: "workspace", object_id: "gold", source_revision: "foreign-revision" }
    });
    expect(ConditionalFieldMeasurementSchema.safeParse({ ...measured,
      response_slots: measured.response_slots.map(foreign), evaluated_slots: measured.evaluated_slots.map(foreign)
    }).success).toBe(false);
  });

  it("rejects omitted and prefix product pages even when the evaluator copies the shortened slots", () => {
    const input = fixture(["gold", "other"]);
    for (const length of [0, 1]) {
      const recallResult = { ...input.recallResult, results: input.recallResult.results.slice(0, length),
        index: { ...input.recallResult.index, continuation: null,
          completeness: { ...input.recallResult.index.completeness, logical_index: "complete" as const } } };
      expect(measureConditionalFieldResponse({ ...input, recallResult,
        deliveredResults: input.deliveredResults.slice(0, length) }))
        .toMatchObject({ status: "invalid", reason: "omitted_prefix_page" });
    }
  });

  it("binds copied responses to the independently supplied query, workspace, clock and filters", () => {
    const input = fixture();
    for (const changed of [{ queryText: "unrelated medical query" }, { workspaceId: "foreign" },
      { referenceTime: "2020-01-01T00:00:00.000Z" }, { requestFilters: { authorized_scopes: ["private"] } },
      { requestFilters: { since: "2020-01-01T00:00:00.000Z" } }, { workspaceId: undefined }]) {
      expect(measureConditionalFieldResponse({ ...input, ...changed })?.status).toBe("invalid");
    }
    for (const index of [
      { ...input.recallResult.index, query_id: "foreign" },
      { ...input.recallResult.index, interpretation_id: undefined },
      { ...input.recallResult.index, interpretation_id: "foreign" },
      { ...input.recallResult.index, continuation: { ...input.recallResult.index.continuation!,
        interpretation_clock: "2020-01-01T00:00:00.000Z" } }
    ]) expect(measureConditionalFieldResponse({ ...input, recallResult: { ...input.recallResult, index } })?.status).toBe("invalid");
    expect(measureConditionalFieldResponse({ ...input,
      recallResult: { ...input.recallResult, execution_receipt: undefined } }))
      .toMatchObject({ status: "invalid", reason: "execution_receipt_invalid" });
  });

  it("joins program and temporal state in every structured product slot", () => {
    const input = fixture();
    for (const changed of [{ program_state: "foreign" }, { time_state: "foreign" },
      { program_state: undefined }, { time_state: undefined }]) {
      expect(measureConditionalFieldResponse({ ...input, recallResult: { ...input.recallResult,
        results: input.recallResult.results.map((row) => ({ ...row, ...changed })) } }))
        .toMatchObject({ status: "invalid", reason: "result_index_mismatch" });
    }
  });

  it("reuses canonical compiler identity for scoped and time-filtered requests", () => {
    const input = fixture();
    const requestFilters = { authorized_scopes: ["workspace", "project"],
      since: "2025-01-01T00:00:00.000Z", until: "2026-09-01T00:00:00.000Z",
      time_field: "last_used_at" as const, dimension_filter: ["knowledge"], domain_tag_filter: ["deployment"] };
    const compile_input = { ...input.recallResult.execution_receipt.compile_input, ...requestFilters };
    const query_id = compileConditionalFieldQuery(compile_input).query_id;
    const execution_receipt = { ...input.recallResult.execution_receipt, compile_input, query_id };
    const index = { ...input.recallResult.index, query_id,
      continuation: { ...input.recallResult.index.continuation!, query_id } };
    const scoped = { ...input, requestFilters, recallResult: { ...input.recallResult, index, execution_receipt } };
    expect(measureConditionalFieldResponse(scoped)?.status).toBe("validated");
    expect(measureConditionalFieldResponse({ ...scoped,
      requestFilters: { ...requestFilters, authorized_scopes: ["project", "workspace"] } })?.status).toBe("validated");
    expect(measureConditionalFieldResponse({ ...scoped, requestFilters: {} })?.status).toBe("invalid");
  });

  it("revalidates archived identity, cardinality, source usability and derived counters", () => {
    const row = diagnostic();
    const metric = row.conditional_field_measurement;
    if (metric?.status !== "validated") throw new Error("valid fixture expected");
    const corruptions = [
      { ...metric, response_slots: [] },
      { ...metric, evaluated_slots: [] },
      { ...metric, completeness: { ...metric.completeness, logical_index: "invalidated" } },
      { ...metric, metrics: { ...metric.metrics, index_entry_count: 0 } },
      { ...metric, metrics: { ...metric.metrics, association_min: 0 } },
      { ...metric, identity: { ...metric.identity, interpretation_id: "foreign" } },
      { ...metric, request: { ...metric.request, budget: { ...BUDGET, page_budget: 0 } } }
    ];
    for (const changed of corruptions) {
      expect(ConditionalFieldMeasurementSchema.safeParse(changed).success).toBe(false);
      const archived = { ...row, conditional_field_measurement: changed } as typeof row;
      expect(classifyQuestionMeasurementStatus(archived)).toBe("evaluator_identity_unscorable");
      expect(reclassifyQuestionDiagnostic(archived).conditional_field_measurement?.status).toBe("invalid");
    }
    const missingDelivery = { ...row, delivered_results: [] };
    expect(classifyQuestionMeasurementStatus(missingDelivery)).toBe("evaluator_identity_unscorable");
    expect(reclassifyQuestionDiagnostic(missingDelivery).conditional_field_measurement?.status).toBe("invalid");
  });

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
      .toMatchObject({ status: "invalid", reason: "missing_request_binding" });
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
    const unusable = ["resource_rejected", "cancelled", "invalidated", "unavailable", "interrupted", "omitted", "not_applicable"] as const;
    for (const axis of ["logical_index", "observed_coverage"] as const) {
      const states = axis === "logical_index" ? [...unusable, "unknown"] as const : unusable;
      for (const state of states) {
        const input = fixture();
        const row = diagnostic({ ...input, recallResult: { ...input.recallResult,
          index: { ...input.recallResult.index,
            completeness: { ...input.recallResult.index.completeness, [axis]: state } } } });
        expect(row.conditional_field_measurement).toMatchObject({ status: "invalid", reason: "unusable_source_state" });
        expect(classifyQuestionMeasurementStatus(row)).toBe("evaluator_identity_unscorable");
      }
    }
    const input = fixture();
    const unknownObserved = diagnostic({ ...input, recallResult: { ...input.recallResult,
      index: { ...input.recallResult.index,
        completeness: { ...input.recallResult.index.completeness, observed_coverage: "unknown" } } } });
    expect(unknownObserved.conditional_field_measurement?.status).toBe("validated");
    const emptyUnknown = diagnostic({ ...input, deliveredResults: [], recallResult: { ...input.recallResult,
      results: [],
      index: { ...input.recallResult.index, entries: [], continuation: null,
        completeness: { ...input.recallResult.index.completeness, observed_coverage: "unknown" } } } });
    expect(emptyUnknown.conditional_field_measurement).toMatchObject({ status: "invalid", reason: "unusable_source_state" });
    expect(classifyQuestionMeasurementStatus(emptyUnknown)).toBe("evaluator_identity_unscorable");
    const completeUnknown = diagnostic({ ...input, recallResult: { ...input.recallResult,
      index: { ...input.recallResult.index,
        completeness: { ...input.recallResult.index.completeness, logical_index: "complete", observed_coverage: "unknown" } } } });
    expect(completeUnknown.conditional_field_measurement).toMatchObject({ status: "invalid", reason: "unusable_source_state" });
  });

  it("retains source_evidence slot kind instead of rewriting it to memory_entry", () => {
    const digest = `sha256:${"d".repeat(64)}`;
    const input = fixture();
    const target = {
      kind: "source_evidence" as const,
      workspace_id: "workspace",
      root_kind: "source_record" as const,
      root_id: "rec-1",
      source_version: "v1",
      content_digest: digest,
      evidence_object_id: null
    };
    const entry = {
      ...input.recallResult.index.entries[0]!,
      object_id: undefined,
      target,
      hypothesis_id: "h0",
      output_binding: "binding0"
    };
    const result = {
      ...input.recallResult.results[0]!,
      object_id: undefined,
      object_kind: "source_evidence",
      target
    };
    const recallResult = {
      ...input.recallResult,
      index: { ...input.recallResult.index, entries: [entry] },
      results: [result],
      total_count: 1
    };
    const measured = measureConditionalFieldResponse({
      ...input,
      recallResult,
      deliveredResults: [{
        object_id: undefined,
        target,
        hypothesis_id: result.hypothesis_id,
        output_binding: result.output_binding,
        program_state: result.program_state,
        time_state: result.time_state,
        object_kind: "source_evidence",
        rank: 1,
        relevance_score: result.relevance_score
      }]
    });
    expect(measured?.status).toBe("validated");
    if (measured?.status !== "validated") return;
    expect(measured.response_slots[0]?.object_kind).toBe("source_evidence");
    expect(measured.response_slots[0]?.object_id).toBeUndefined();
    expect(measured.entries[0]?.target).toEqual(target);
  });
});
