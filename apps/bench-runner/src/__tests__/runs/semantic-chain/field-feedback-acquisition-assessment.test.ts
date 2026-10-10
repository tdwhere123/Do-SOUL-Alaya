import { expect, it } from "vitest";
import {
  SourceSemanticResourceExhausted, SourceSemanticResourceLedger, SoulInterpretationResponseSchema,
  sourceIndexEntry, indexEntryCacheKey, sourceSemanticQueryIdentity,
  SOURCE_SEMANTIC_LIBRARY_PROTOCOL_VERSION, SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION,
  SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET, type SourceSemanticWorkerWork
} from "@do-soul/alaya-protocol";
import { CoreError, fieldContractSha256, sourceSemanticLibraryRequestIdentity } from "@do-soul/alaya-core";
import { CLOCK, WS } from "../../../../../core-daemon/src/__tests__/runtime/recall/source-semantic-access.test-support.js";
import { assessSlot, compareCellCommon, comparePoint } from "./field-feedback-acquisition-assessment.test-support.js";
import { accessBudget, allowance, CELLS, frozenCell, ORIGINAL_QUERY, QUERY, SCOPES, SLOTS,
  type Slot } from "./field-feedback-acquisition-fixture.test-support.js";
import type { Invocation, NativeReport } from "./field-feedback-acquisition-native.test-support.js";
import type { Preparation } from "./field-obligation-rediscovery.test-support.js";

const frozen = frozenCell(CELLS[0]);
const queryId = sourceSemanticQueryIdentity(QUERY, fieldContractSha256);
const work: SourceSemanticWorkerWork = { native_work: 0, native_bytes: 0, logical_work: 1, logical_memory_bytes: 64, rss_bytes: 0 };
const coverage: Preparation["coverage"] = { discovery: "complete", source_interpretation: "unexercised",
  query_semantics: "complete", semantic_correspondence: "unexercised", conditional_computation: "unexercised", payload: "complete" };

function capturedError(error: CoreError, measured: SourceSemanticWorkerWork | null = work): NonNullable<Invocation["error"]> {
  return { message: String(error), code: error.code, sub_code: error.subCode ?? null, work: measured };
}

function budgetError(limit: "work" | "memory" = "memory") {
  const meter = new SourceSemanticResourceLedger({ work_units: limit === "work" ? 0 : 1, memory_bytes: 64 });
  try { meter.retain({ pool: [] }, "leased access pool"); }
  catch (cause) {
    if (!(cause instanceof SourceSemanticResourceExhausted)) throw cause;
    const measured = { ...work, logical_work: meter.spentWork, logical_memory_bytes: meter.spentBytes };
    const error = new CoreError("CONFLICT", cause.message, {
      subCode: "RETRYABLE_BACKPRESSURE", details: { work: measured }
    });
    return capturedError(error, measured);
  }
  throw new Error("the constrained ledger must exhaust while retaining the pool");
}

function failedDelivery(arm: Slot["arm"] = "F", error = budgetError()): NativeReport {
  const slot = SLOTS.find(row => row.cell.name === frozen.cell.name && row.point.point === 1 && row.arm === arm)!;
  const reserved = allowance(slot.point), budget = accessBudget(slot);
  const prepare: Preparation = { operation: "prepare_query", query_semantics_id: queryId,
    query_semantics_status: { status: "admitted", query_semantics_id: queryId }, query_handle: "prepared-query",
    candidates: [], truncated: false, coverage, work, provider_attempts: 0 };
  return { slot, status: "native_failure", stop: "public_delivery_failed", setup: null, setup_elapsed_ms: null,
    native_started: true, manifest: null, publication_receipts: [], common: { ready: true },
    policy: { selected_hint: null, decision: null, initial_bindings: "not_exercised" }, access: { prepare },
    calls: [{ name: "access-prepare", request: { operation: "prepare_query", original_query: ORIGINAL_QUERY,
      query_semantics: QUERY, authorized_scopes: SCOPES, budget }, response: prepare,
      elapsed_ms: 0, encoded_response_bytes: Buffer.byteLength(JSON.stringify(prepare)), capture_complete: true },
    { name: "access-delivery", request: { operation: "recall", query_handle: prepare.query_handle,
      accepts_unreviewed_conditional_results: true, semantic_correspondences: [], authorized_scopes: SCOPES,
      budget, output_byte_limit: 1_000_000 }, error, elapsed_ms: 0, encoded_response_bytes: null, capture_complete: true }],
    failure: null, protocol_contradiction: null, allowance: { work_reserved: reserved.total_work_units,
      memory_reserved: reserved.total_memory_bytes, read_count: 1, effect_count: 2, actions: [], reads: [], actual_native: [] } };
}

function deliveredSource(arm: Slot["arm"]): NativeReport {
  const report = failedDelivery(arm), prepare = report.access.prepare!;
  const source = frozen.sources.find(row => row.source_id === frozen.assessment_only.sufficient_source_id)!;
  const entry = sourceIndexEntry({ workspace_id: WS, root_kind: "source_record", root_id: source.record_id,
    source_version: source.source_version, content_digest: source.content_digest, evidence_object_id: null,
    association_milligrades: 0, hypothesis_id: "source-only", output_binding: "source-evidence", role: "requested",
    claim: "unknown", explanation_ids: [] });
  const disclosure = { material_kind: "original_body", source_binding: "checked_record", evaluated_as_of: CLOCK,
    validity: { kind: "unknown", reason: "not_recorded" }, temporal_state: "unknown",
    proof_use: { kind: "source_only", qualification: "not_current_proof" } };
  const delivery = SoulInterpretationResponseSchema.parse({ operation: "recall", delivery_id: "captured-delivery",
    request_identity: sourceSemanticLibraryRequestIdentity({ workspace_id: WS, as_of: CLOCK, authorized_scopes: SCOPES.scopes,
      original_query: ORIGINAL_QUERY, query_semantics: QUERY, query_semantics_status: prepare.query_semantics_status,
      access_policy: "query-conditioned-v1", semantic_correspondences: [], budget: accessBudget(report.slot), output_byte_limit: 1_000_000 }),
    query_semantics_status: prepare.query_semantics_status, protocol_version: SOURCE_SEMANTIC_LIBRARY_PROTOCOL_VERSION, total_count: 1,
    index: { schema_version: 1, query_id: queryId, snapshot_id: source.content_digest,
      result_version: SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION, entries: [entry], continuation: null, page_purpose: "membership",
      completeness: { schema_version: 1, logical_index: "complete", observed_coverage: "complete", transport: "complete",
        payload: "complete", representation: "complete" }, representation: { schema_version: 1,
        policy: "construct_index_then_page_then_payload", page_budget: SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET, identity_tie_break: "serialization" } },
    page_purpose: "membership", discovery: { eligible_source_count: 33, visited_source_pages: 1, visited_source_interpretation_pages: 1,
      visited_source_interpretation_descriptors: 0, candidate_prefix: [], examined_source_interpretation_ids: [],
      unexamined_source_interpretation_count: 0, omitted_duplicate_bindings: 0, examination_cap: 32, open_residuals: false, truncated: false },
    order: { enumeration_policy: "evidence_support", tie_policy: "canonical_identity", occupancy: "source_gold_root_identity",
      occupancy_prefix: 5, page_budget: SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET },
    slot_qualifiers: [{ index: 0, evidence_kind: "source_evidence" }], source_disclosures: { [indexEntryCacheKey(entry)]: disclosure },
    results: [{ object_kind: "source_evidence", target: entry.target, relevance_score: 0, content_preview: source.text,
      source_disclosure: disclosure, evidence_pointers: [], selection_reason: "source access", source_channels: ["source"],
      score_factors: { activation: 0, relevance: 0 }, budget_state: { token_estimate: 1, max_entries: 5, max_total_tokens: 100_000,
        remaining_entries: 4, remaining_tokens: 99_999, within_budget: true } }], coverage, work, provider_attempts: 0 });
  if (delivery.operation !== "recall") throw new Error("authored capture must be a public recall response");
  report.status = "observed"; report.stop = "public_raw_and_H_acquisition_complete"; report.access.delivery = delivery;
  delete report.calls[1]!.error;
  report.calls[1]!.response = delivery;
  report.calls[1]!.encoded_response_bytes = Buffer.byteLength(JSON.stringify(delivery));
  return report;
}

it.each(["work", "memory"] as const)("classifies a fully captured %s budget error from the resource owner as a known failure", limit => {
  const error = budgetError(limit), report = failedDelivery("F", error);
  expect(error.message).toBe("CoreError: source semantic leased access pool budget exhausted");
  const result = assessSlot(report, frozen);
  expect(result.endpoints).toEqual({ public_sufficient_raw: { status: "failure", reason: "captured_bound_terminal_exhaustion" },
    returned_necessary_H: { status: "failure", reason: "captured_bound_terminal_exhaustion" } });
  expect(result.native_cost.post_fork_public_calls.unmetered_calls).toBe(0);
  expect(result.native_cost.post_fork_public_calls.known_subtotal.logical_work).toBe(1 + error.work!.logical_work!);
});

it.each([
  "source semantic preparation exceeds lease capacity",
  "recall worker is under pressure",
  "source semantic leased access pool budget exhausted; retry later",
  "source semantic leased access pool budget exhausted\n"
])("keeps non-budget retryable pressure unknown: %s", message => {
  const report = failedDelivery("F", capturedError(new CoreError("CONFLICT", message, { subCode: "RETRYABLE_BACKPRESSURE" })));
  expect(assessSlot(report, frozen).endpoints.public_sufficient_raw).toEqual({ status: "unknown", reason: "public_delivery_failed" });
});

it.each([
  { name: "missing work", change: (report: NativeReport) => { report.calls[1]!.error!.work = null; }, reason: "public_delivery_failed" },
  { name: "incomplete capture", change: (report: NativeReport) => { report.calls[1]!.capture_complete = false; }, reason: "native_capture_incomplete" },
  { name: "failed meter retention", change: (report: NativeReport) => { report.calls[1]!.meter_error = "receipt not retained"; }, reason: "native_meter_retention_failed" },
  { name: "missing delivery call", change: (report: NativeReport) => { report.calls.pop(); }, reason: "public_delivery_failed" },
  { name: "wrong request budget", change: (report: NativeReport) => {
    report.calls[1]!.request = { ...report.calls[1]!.request, budget: { ...accessBudget(report.slot), work_units: 1 } };
  }, reason: "public_delivery_failed" },
  { name: "wrong preparation handle", change: (report: NativeReport) => {
    report.access.prepare = { ...report.access.prepare!, query_handle: "different-query" };
  }, reason: "public_delivery_failed" },
  { name: "wrong code", change: (report: NativeReport) => { report.calls[1]!.error!.code = "VALIDATION"; }, reason: "public_delivery_failed" },
  { name: "wrong subcode", change: (report: NativeReport) => { report.calls[1]!.error!.sub_code = null; }, reason: "public_delivery_failed" },
  { name: "different call phase", change: (report: NativeReport) => { report.calls[1]!.name = "policy-reason"; }, reason: "public_delivery_failed" },
  { name: "different operation", change: (report: NativeReport) => { report.calls[1]!.request = report.calls[0]!.request; }, reason: "public_delivery_failed" },
  { name: "response alongside error", change: (report: NativeReport) => { report.calls[1]!.response = report.access.prepare; }, reason: "public_delivery_failed" },
  { name: "query identity mismatch", change: (report: NativeReport) => {
    report.access.prepare = { ...report.access.prepare!, query_semantics_id: `sha256:${"f".repeat(64)}` };
  }, reason: "identity_or_protocol_inconsistent" },
  { name: "protocol contradiction", change: (report: NativeReport) => { report.protocol_contradiction = "changed request"; }, reason: "identity_or_protocol_inconsistent" },
  { name: "setup not ready", change: (report: NativeReport) => { report.common.ready = false; report.stop = "setup_unready"; }, reason: "setup_unready" }
])("keeps $name unknown despite a budget-shaped error", ({ change, reason }) => {
  const report = failedDelivery(); change(report);
  expect(assessSlot(report, frozen).endpoints.public_sufficient_raw).toEqual({ status: "unknown", reason });
});

it("retains the existing structured preparation-exhaustion outcome", () => {
  const report = failedDelivery();
  report.status = "observed"; report.stop = "bound_preparation_terminated"; report.calls.pop();
  report.access.prepare = { ...report.access.prepare!, query_handle: undefined, outcome: { status: "resource_exhausted" }, truncated: true };
  report.calls[0]!.response = report.access.prepare;
  expect(assessSlot(report, frozen).endpoints.public_sufficient_raw)
    .toEqual({ status: "failure", reason: "captured_bound_terminal_exhaustion" });
});

it.each([false, true])("keeps all four arms and reports known budget failures in comparisons when F success is %s", fSucceeds => {
  const reports = [deliveredSource("A"), failedDelivery("B"),
    failedDelivery("M", capturedError(new CoreError("CONFLICT", "source semantic preparation exceeds lease capacity", { subCode: "RETRYABLE_BACKPRESSURE" }))),
    fSucceeds ? deliveredSource("F") : failedDelivery("F")];
  const assessments = reports.map(report => assessSlot(report, frozen));
  const result = comparePoint(reports, assessments, compareCellCommon(reports), null);
  expect(result.slots.map(slot => slot.id)).toEqual(reports.map(report => report.slot.id));
  expect(result.comparison.map(row => ({ control: row.control, outcome: row.outcome }))).toEqual([
    { control: "A", outcome: fSucceeds ? "tie" : "F_loss" },
    { control: "B", outcome: fSucceeds ? "F_win" : "tie" }, { control: "M", outcome: "unknown" }
  ]);
  expect(result.comparison[1]!.post_fork_native_delta_F_minus_control).not.toBeNull();
  expect(result.comparison[2]!.post_fork_native_delta_F_minus_control).toBeNull();
});
