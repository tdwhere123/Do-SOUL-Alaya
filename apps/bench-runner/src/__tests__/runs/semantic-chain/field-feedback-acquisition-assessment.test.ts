import { expect, it } from "vitest";
import {
  canonicalJson, SourceSemanticResourceExhausted, SourceSemanticResourceLedger, SoulInterpretationResponseSchema,
  sourceIndexEntry, indexEntryCacheKey, sourceSemanticQueryIdentity, packSourceSemanticAcquisition,
  packSourceSemanticQueryPreparation, sourceSemanticAcquisitionNotRun, sourceSemanticAccessPhases,
  sourceSemanticExecution, unavailableSourceQueryPreparation,
  SOURCE_SEMANTIC_LIBRARY_PROTOCOL_VERSION, SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION,
  SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET, type SourceSemanticWorkerWork
} from "@do-soul/alaya-protocol";
import { authorizedScopesFromAdmission, CoreError, fieldContractSha256, preparedDeliveryId,
  sourceSemanticLibraryQueryIdentity, sourceSemanticLibraryRequestIdentity } from "@do-soul/alaya-core";
import { CLOCK, WS } from "../../../../../core-daemon/src/__tests__/runtime/recall/source-semantic-access.test-support.js";
import { assessSlot, compareCellCommon, comparePoint } from "./field-feedback-acquisition-assessment.test-support.js";
import { accessBudget, allowance, CELLS, COMMON_BUDGET, frozenCell, ORIGINAL_QUERY, QUERY, SCOPES, SLOTS,
  type FrozenCell, type Slot } from "./field-feedback-acquisition-fixture.test-support.js";
import type { Invocation, NativeReport } from "./field-feedback-acquisition-native.test-support.js";
import type { Delivery, Preparation } from "./field-obligation-rediscovery.test-support.js";

const frozen = frozenCell(CELLS[0]);
const queryId = sourceSemanticQueryIdentity(QUERY, fieldContractSha256);
const work: SourceSemanticWorkerWork = { native_work: 0, native_bytes: 0, logical_work: 1, logical_memory_bytes: 64, rss_bytes: 0 };
const execution = sourceSemanticExecution();
const accessPreparation = unavailableSourceQueryPreparation("controlled_or_scoped_access", "not_requested");
const accessAcquisition = sourceSemanticAcquisitionNotRun("controlled_or_scoped_access");
const accessPhases = {
  phases: [1, packSourceSemanticQueryPreparation(accessPreparation),
    packSourceSemanticAcquisition(accessAcquisition), null] as const
};
const accessExecution = sourceSemanticExecution(accessPreparation, accessAcquisition);
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
    candidates: [], truncated: false, coverage, work, execution };
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

function capturedDelivery(source: FrozenCell["sources"][number], budget: ReturnType<typeof accessBudget>, sourceId?: string): Delivery {
  const entry = sourceIndexEntry({ workspace_id: WS, root_kind: "source_record", root_id: source.record_id,
    source_version: source.source_version, content_digest: source.content_digest, evidence_object_id: null,
    association_milligrades: 0, hypothesis_id: "source-only", output_binding: "source-evidence", role: "requested",
    claim: "unknown", explanation_ids: [] });
  const disclosure = { material_kind: "original_body", source_binding: "checked_record", evaluated_as_of: CLOCK,
    validity: { kind: "unknown", reason: "not_recorded" }, temporal_state: "unknown",
    proof_use: { kind: "source_only", qualification: "not_current_proof" } };
  const queryStatus = { status: "admitted" as const, query_semantics_id: queryId };
  const requestIdentity = sourceSemanticLibraryRequestIdentity({ workspace_id: WS, as_of: CLOCK, authorized_scopes: SCOPES.scopes,
    original_query: ORIGINAL_QUERY, query_semantics: QUERY, query_semantics_status: queryStatus, source_id: sourceId,
    access_policy: "query-conditioned-v1", semantic_correspondences: [], budget, output_byte_limit: 1_000_000 });
  const index = { schema_version: 1, query_id: sourceSemanticLibraryQueryIdentity(ORIGINAL_QUERY), snapshot_id: source.content_digest,
      result_version: SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION, entries: [entry], continuation: null, page_purpose: "membership",
      completeness: { schema_version: 1, logical_index: "complete", observed_coverage: "complete", transport: "complete",
        payload: "complete", representation: "complete" }, representation: { schema_version: 1,
        policy: "construct_index_then_page_then_payload", page_budget: SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET, identity_tie_break: "serialization" } } as const;
  const delivery = SoulInterpretationResponseSchema.parse({ operation: "recall", delivery_id: preparedDeliveryId(requestIdentity, index),
    request_identity: requestIdentity, query_semantics_status: queryStatus,
    protocol_version: SOURCE_SEMANTIC_LIBRARY_PROTOCOL_VERSION, total_count: 1, index,
    page_purpose: "membership", discovery: { eligible_source_count: 33, visited_source_pages: 1, visited_source_interpretation_pages: 1,
      visited_source_interpretation_descriptors: 0, candidate_prefix: [], examined_source_interpretation_ids: [],
      unexamined_source_interpretation_count: 0, omitted_duplicate_bindings: 0, examination_cap: 32, open_residuals: false, truncated: false },
    order: { enumeration_policy: "evidence_support", tie_policy: "canonical_identity", occupancy: "source_gold_root_identity",
      occupancy_prefix: 5, page_budget: SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET },
    slot_qualifiers: [{ index: 0, evidence_kind: "source_evidence" }], source_disclosures: { [indexEntryCacheKey(entry)]: disclosure },
    results: [{ object_kind: "source_evidence", target: entry.target, relevance_score: 0, content_preview: source.text,
      source_disclosure: disclosure, evidence_pointers: [], selection_reason: "source access", source_channels: ["source"],
      score_factors: { activation: 0, relevance: 0 }, budget_state: { token_estimate: 1, max_entries: 5, max_total_tokens: 100_000,
        remaining_entries: 4, remaining_tokens: 99_999, within_budget: true } }], coverage, work, execution });
  if (delivery.operation !== "recall") throw new Error("authored capture must be a public recall response");
  return delivery;
}

function deliveredSource(arm: Slot["arm"]): NativeReport {
  const report = failedDelivery(arm);
  const delivery = capturedDelivery(frozen.sources.find(row => row.source_id === frozen.assessment_only.sufficient_source_id)!, accessBudget(report.slot));
  report.status = "observed"; report.stop = "public_raw_and_H_acquisition_complete"; report.access.delivery = delivery;
  delete report.calls[1]!.error;
  report.calls[1]!.response = delivery;
  report.calls[1]!.encoded_response_bytes = Buffer.byteLength(JSON.stringify(delivery));
  return report;
}

function commonRequests(report: NativeReport) {
  const source = report.calls.find(call => call.name === "common-source")!;
  const prepare = report.calls.find(call => call.name === "common-prepare")!;
  const delivery = report.calls.find(call => call.name === "common-delivery")!;
  if (source.request.operation !== "prepare_source" || prepare.request.operation !== "prepare_query" || delivery.request.operation !== "recall") {
    throw new Error("expected authored common call operations");
  }
  return { source: source.request, prepare: prepare.request, delivery: delivery.request };
}

/** Recompute only public identity relationships after a deliberate stable-field mutation. */
function bindCommonCapture(report: NativeReport): void {
  const request = commonRequests(report), prepare = report.common.prepare!, delivery = report.common.delivery!;
  const identity = sourceSemanticLibraryRequestIdentity({ workspace_id: WS, as_of: CLOCK,
    authorized_scopes: authorizedScopesFromAdmission(request.delivery.authorized_scopes).authorized_scopes!,
    original_query: request.prepare.original_query, query_semantics: request.prepare.query_semantics,
    query_semantics_status: prepare.query_semantics_status, source_id: report.common.source!.source_id,
    access_policy: "query-conditioned-v1", semantic_correspondences: [], budget: request.delivery.budget,
    output_byte_limit: request.delivery.output_byte_limit });
  report.common.delivery = { ...delivery, request_identity: identity, delivery_id: preparedDeliveryId(identity, delivery.index!) };
  syncCommonCaptures(report);
}

function syncCommonCaptures(report: NativeReport): void {
  for (const [name, response] of [["common-source", report.common.source], ["common-prepare", report.common.prepare],
    ["common-delivery", report.common.delivery]] as const) {
    const call = report.calls.find(row => row.name === name)!;
    call.response = response; call.encoded_response_bytes = Buffer.byteLength(JSON.stringify(response));
  }
}

function withCommon(report: NativeReport, instance: string = report.slot.arm): NativeReport {
  const initial = frozen.sources[0]!, delivery = capturedDelivery(initial, COMMON_BUDGET, initial.source_id);
  const disclosure = delivery.results![0]!.source_disclosure!;
  const descriptor = { source_id: initial.source_id, source_version: initial.source_version, content_digest: initial.content_digest,
    interpretation_id: initial.interpretation_id, interpretation: initial.interpretation, producer_id: "access-test-author",
    producer_version: "p0", contract_version: "source-interpretation-v4", source_disclosure: disclosure };
  const access: NonNullable<Preparation["access"]> = { contract: "source-semantic-access-v2", ...accessPhases, policy: "query-conditioned-v1",
    input_id: `sha256:${"1".repeat(64)}`, pool_id: `sha256:${"2".repeat(64)}`, observed_source_count: 1, observed_interpretation_count: 1,
    source_candidates: [{ source_id: initial.source_id, record_id: initial.record_id, read_bytes: Buffer.byteLength(initial.text),
      body_bytes: Buffer.byteLength(initial.text), complete: true, signal: { source_text_score: 0, interpretation_reading_score: 0 } }],
    interpretation_candidates: [{ interpretation_id: initial.interpretation_id, record_id: initial.record_id,
      signal: { source_text_score: 0, interpretation_reading_score: 0 } }], trace: { kind: "preparation_page", source_offset: 0,
      interpretation_offset: 0, omitted_source_count: 0, omitted_interpretation_count: 0 },
    unvisited_sources: false, unvisited_interpretations: false, stopping_reasons: [] };
  report.common = { ready: true, initial_H: descriptor,
    source: { operation: "prepare_source", source_handle: `source-${instance}`, source_id: initial.source_id,
      source_version: initial.source_version, content_digest: initial.content_digest, catalog: initial.catalog,
      attribution_context: initial.attribution_context, source_disclosure: disclosure, coverage, work, execution },
    prepare: { operation: "prepare_query", query_handle: `query-${instance}`, query_semantics_id: queryId,
      query_semantics_status: { status: "admitted", query_semantics_id: queryId }, candidates: [descriptor], access,
      truncated: false, coverage, work, execution: accessExecution },
    delivery: { ...delivery, index: { ...delivery.index!, snapshot_id: `sha256:${fieldContractSha256(instance)}` } } };
  const requests: [string, Invocation["request"]][] = [
    ["common-source", { operation: "prepare_source", source_id: initial.source_id, authorized_scopes: SCOPES, budget: COMMON_BUDGET }],
    ["common-prepare", { operation: "prepare_query", original_query: ORIGINAL_QUERY, query_semantics: QUERY,
      source_handle: report.common.source!.source_handle, authorized_scopes: SCOPES, budget: COMMON_BUDGET }],
    ["common-delivery", { operation: "recall", accepts_unreviewed_conditional_results: true,
      query_handle: report.common.prepare!.query_handle, semantic_correspondences: [], authorized_scopes: SCOPES,
      budget: COMMON_BUDGET, output_byte_limit: 1_000_000 }]
  ];
  report.calls.push(...requests.map(([name, request]) => ({ name, request, elapsed_ms: 0, encoded_response_bytes: null, capture_complete: true })));
  bindCommonCapture(report);
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
    fSucceeds ? deliveredSource("F") : failedDelivery("F")].map(report => withCommon(report));
  const assessments = reports.map(report => assessSlot(report, frozen));
  const common = compareCellCommon(reports);
  expect(common.status).toBe("matched");
  const result = comparePoint(reports, assessments, common, null);
  expect(result.slots.map(slot => slot.id)).toEqual(reports.map(report => report.slot.id));
  expect(result.comparison.map(row => ({ control: row.control, outcome: row.outcome }))).toEqual([
    { control: "A", outcome: fSucceeds ? "tie" : "F_loss" },
    { control: "B", outcome: fSucceeds ? "F_win" : "tie" }, { control: "M", outcome: "unknown" }
  ]);
  expect(result.comparison[1]!.post_fork_native_delta_F_minus_control).not.toBeNull();
  expect(result.comparison[2]!.post_fork_native_delta_F_minus_control).toBeNull();
});

it("matches verified common deliveries across fresh capabilities without changing retained captures", () => {
  const reports = [withCommon(failedDelivery("A")), withCommon(failedDelivery("F"))];
  reports[1]!.common.delivery = { ...reports[1]!.common.delivery!, work: { ...work, rss_bytes: 999 } };
  syncCommonCaptures(reports[1]!);
  reports[1]!.calls.at(-1)!.elapsed_ms = 20;
  const before = canonicalJson(reports);
  expect(reports[0]!.common.source!.source_handle).not.toBe(reports[1]!.common.source!.source_handle);
  expect(reports[0]!.common.prepare!.query_handle).not.toBe(reports[1]!.common.prepare!.query_handle);
  expect(reports[0]!.common.delivery!.index!.snapshot_id).not.toBe(reports[1]!.common.delivery!.index!.snapshot_id);
  expect(reports[0]!.common.delivery!.delivery_id).not.toBe(reports[1]!.common.delivery!.delivery_id);
  expect(reports[0]!.common.delivery!.request_identity).toBe(reports[1]!.common.delivery!.request_identity);
  expect(compareCellCommon(reports)).toMatchObject({ status: "matched", invalid_slots: [], divergent_slots: [] });
  expect(canonicalJson(reports)).toBe(before);
});

const stableChanges: [string, (report: NativeReport) => void][] = [
  ["source tuple", report => { report.common.source = { ...report.common.source!, source_version: "2" }; }],
  ["source bytes", report => { const value = report.common.delivery!;
    report.common.delivery = { ...value, results: value.results!.map(row => ({ ...row, content_preview: `${row.content_preview} ` })) }; }],
  ["Q", report => {
    const call = report.calls.find(row => row.name === "common-prepare")!, request = commonRequests(report).prepare;
    const query = { ...QUERY, return_variables: ["package", "shipment"] }, id = sourceSemanticQueryIdentity(query, fieldContractSha256);
    call.request = { ...request, query_semantics: query };
    report.common.prepare = { ...report.common.prepare!, query_semantics_id: id, query_semantics_status: { status: "admitted", query_semantics_id: id } };
    report.common.delivery = { ...report.common.delivery!, query_semantics_status: report.common.prepare.query_semantics_status };
  }],
  ["H", report => { const h = frozen.sources[1]!;
    report.common.prepare = { ...report.common.prepare!, candidates: report.common.prepare!.candidates.map(row => ({ ...row,
      interpretation_id: h.interpretation_id, interpretation: h.interpretation })) }; }],
  ["scopes", report => { for (const call of report.calls.filter(row => row.name.startsWith("common-"))) {
    call.request = { ...call.request, authorized_scopes: { mode: "named", scopes: ["session"] } };
  } }],
  ["budget", report => { const call = report.calls.find(row => row.name === "common-delivery")!;
    call.request = { ...call.request, budget: { ...call.request.budget!, work_units: COMMON_BUDGET.work_units + 1 } }; }],
  ["access input", report => { report.common.prepare = { ...report.common.prepare!,
    access: { ...report.common.prepare!.access!, input_id: `sha256:${"3".repeat(64)}` } }; }],
  ["access pool", report => { report.common.prepare = { ...report.common.prepare!,
    access: { ...report.common.prepare!.access!, pool_id: `sha256:${"4".repeat(64)}` } }; }],
  ["membership", report => { const value = report.common.delivery!;
    report.common.delivery = { ...value, index: { ...value.index!, entries: [] }, total_count: 0, results: [],
      slot_qualifiers: [], source_disclosures: {} }; }],
  ["index query", report => { const value = report.common.delivery!;
    report.common.delivery = { ...value, index: { ...value.index!, query_id: sourceSemanticLibraryQueryIdentity("Another query") } }; }],
  ["disclosure", report => { const value = report.common.delivery!, at = new Date(Date.parse(CLOCK) + 1_000).toISOString();
    report.common.delivery = { ...value, source_disclosures: Object.fromEntries(Object.entries(value.source_disclosures!).map(([id, row]) =>
      [id, { ...row, evaluated_as_of: at }])), results: value.results!.map(row => ({ ...row,
        source_disclosure: { ...row.source_disclosure!, evaluated_as_of: at } })) }; }],
  ["coverage", report => { report.common.delivery = { ...report.common.delivery!, coverage: { ...coverage, discovery: "open" } }; }],
  ["logical work", report => { report.common.delivery = { ...report.common.delivery!, work: { ...work, logical_work: 2 } }; }],
  ["logical memory", report => { report.common.delivery = { ...report.common.delivery!, work: { ...work, logical_memory_bytes: 65 } }; }],
  ["native work", report => { report.common.delivery = { ...report.common.delivery!, work: { ...work, native_work: 1 } }; }],
  ["native bytes", report => { report.common.delivery = { ...report.common.delivery!, work: { ...work, native_bytes: 1 } }; }]
];

it.each(stableChanges)("retains a common %s mismatch despite valid per-instance delivery IDs", (_name, change) => {
  const reports = [withCommon(failedDelivery("A")), withCommon(failedDelivery("F"))];
  change(reports[1]!); bindCommonCapture(reports[1]!);
  expect(compareCellCommon(reports)).toMatchObject({ status: "diverged", invalid_slots: [], divergent_slots: [reports[1]!.slot.id] });
});

const invalidChanges: [string, (report: NativeReport) => void][] = [
  ["source capability link", report => { const call = report.calls.find(row => row.name === "common-prepare")!;
    call.request = { ...commonRequests(report).prepare, source_handle: "another-source" }; }],
  ["query capability link", report => { const call = report.calls.find(row => row.name === "common-delivery")!;
    call.request = { ...commonRequests(report).delivery, query_handle: "another-query" }; }],
  ["source resolution", report => { report.common.source = { ...report.common.source!, source_id: "another-source" }; syncCommonCaptures(report); }],
  ["delivery ID", report => { report.common.delivery = { ...report.common.delivery!, delivery_id: "unbound-delivery" }; syncCommonCaptures(report); }],
  ["resolved request ID", report => { report.common.delivery = { ...report.common.delivery!, request_identity: `sha256:${"5".repeat(64)}` };
    report.common.delivery = { ...report.common.delivery, delivery_id: preparedDeliveryId(report.common.delivery.request_identity!, report.common.delivery.index!) };
    syncCommonCaptures(report); }],
  ["missing call", report => { report.calls = report.calls.filter(row => row.name !== "common-prepare"); }],
  ["reordered calls", report => { report.calls = [...report.calls].reverse(); }],
  ["missing response", report => { delete report.calls.at(-1)!.response; }],
  ["incomplete capture", report => { report.calls.at(-1)!.capture_complete = false; }],
  ["unretained meter", report => { report.calls.at(-1)!.meter_error = "retention failed"; }],
  ["query preparation continuation", report => { report.common.prepare = { ...report.common.prepare!, continuation_handle: "unexpected-continuation" };
    syncCommonCaptures(report); }],
  ["delivery continuation", report => { const value = report.common.delivery!;
    report.common.delivery = { ...value, index: { ...value.index!, continuation: { schema_version: 1,
      continuation_id: "unexpected-continuation", query_id: value.index!.query_id, snapshot_id: value.index!.snapshot_id,
      result_version: SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION, expires_at: new Date(Date.parse(CLOCK) + 60_000).toISOString(),
      cursor: "next-member" } } };
    bindCommonCapture(report); }],
  ["capture alias", report => { report.common.delivery = { ...report.common.delivery!, delivery_id: "uncaptured-alias" }; }]
];

it.each(invalidChanges)("rejects a ready common chain with a malformed %s", (_name, change) => {
  const report = withCommon(failedDelivery());
  change(report);
  expect(compareCellCommon([report])).toMatchObject({ status: "diverged", reference_slot: null,
    invalid_slots: [{ slot: report.slot.id, reason: expect.any(String) }], divergent_slots: [report.slot.id] });
});

it("does not treat endpoint-only synthetic fixtures as captured ready common chains", () => {
  const reports = (["A", "B", "M", "F"] as const).map(arm => failedDelivery(arm));
  const common = compareCellCommon(reports);
  expect(common.status).toBe("diverged");
  expect(common.invalid_slots).toHaveLength(4);
  expect(comparePoint(reports, reports.map(report => assessSlot(report, frozen)), common, null).comparison
    .map(row => [row.control, row.outcome, row.post_fork_native_delta_F_minus_control]))
    .toEqual([["A", "unknown", null], ["B", "unknown", null], ["M", "unknown", null]]);
});

it("retains all four arms as unknown when their common captures genuinely diverge", () => {
  const reports = (["A", "B", "M", "F"] as const).map(arm => withCommon(deliveredSource(arm)));
  reports[1]!.common.delivery = { ...reports[1]!.common.delivery!, work: { ...work, logical_work: 2 } };
  bindCommonCapture(reports[1]!);
  const common = compareCellCommon(reports), result = comparePoint(reports, reports.map(report => assessSlot(report, frozen)), common, null);
  expect(common.status).toBe("diverged");
  expect(result.slots.map(row => row.id)).toEqual(reports.map(report => report.slot.id));
  expect(result.comparison.map(row => [row.control, row.outcome, row.post_fork_native_delta_F_minus_control]))
    .toEqual([["A", "unknown", null], ["B", "unknown", null], ["M", "unknown", null]]);
});

it("rejects a historic access v1 prepare receipt on the public interpretation consumer", () => {
  const report = withCommon(failedDelivery());
  const prepare = report.common.prepare!;
  const historic = { ...prepare.access!, contract: "source-semantic-access-v1" as const };
  delete (historic as { phases?: unknown }).phases;
  expect(SoulInterpretationResponseSchema.safeParse({ ...prepare, access: historic as never }).success).toBe(false);
  const { phases: _phases, ...withoutPhases } = prepare.access!;
  expect(SoulInterpretationResponseSchema.safeParse({ ...prepare, access: {
    ...withoutPhases, ...sourceSemanticAccessPhases(prepare.access!)
  } as never }).success).toBe(false);
  const { execution: _execution, ...withoutExecution } = prepare;
  expect(SoulInterpretationResponseSchema.safeParse(withoutExecution).success).toBe(false);
  expect(SoulInterpretationResponseSchema.safeParse(prepare).success).toBe(true);
});
