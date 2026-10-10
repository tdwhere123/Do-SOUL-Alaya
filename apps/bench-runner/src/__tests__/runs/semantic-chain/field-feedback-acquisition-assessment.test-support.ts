import { canonicalJson, indexEntryCacheKey, sourceSemanticQueryIdentity, type SourceSemanticWorkerWork } from "@do-soul/alaya-protocol";
import { fieldContractSha256, sourceSemanticLibraryRequestIdentity } from "@do-soul/alaya-core";
import { CLOCK, WS } from "../../../../../core-daemon/src/__tests__/runtime/recall/source-semantic-access.test-support.js";
import { initialObservations, type Delivery } from "./field-obligation-rediscovery.test-support.js";
import { accessBudget, allowance, COMMON_RESERVATION, ORIGINAL_QUERY, postForkReservation, QUERY, SCOPES,
  type FrozenCell } from "./field-feedback-acquisition-fixture.test-support.js";
import type { Invocation, NativeReport } from "./field-feedback-acquisition-native.test-support.js";

type Endpoint = { status: "success" | "failure" | "unknown"; reason: string };
const endpoint = (status: Endpoint["status"], reason: string): Endpoint => ({ status, reason });
const workOf = (call: Invocation) => call.response?.work ?? call.error?.work ?? null;
function sumWork(rows: readonly (SourceSemanticWorkerWork | null)[]) {
  return { known_subtotal: rows.reduce((sum, row) => ({ native_work: sum.native_work + (row?.native_work ?? 0),
    native_bytes: sum.native_bytes + (row?.native_bytes ?? 0), logical_work: sum.logical_work + (row?.logical_work ?? row?.native_work ?? 0),
    logical_memory_bytes: sum.logical_memory_bytes + (row?.logical_memory_bytes ?? 0) }),
  { native_work: 0, native_bytes: 0, logical_work: 0, logical_memory_bytes: 0 }),
  metered_calls: rows.filter(row => row !== null).length, unmetered_calls: rows.filter(row => row === null).length };
}

function checkPublicIdentities(report: NativeReport, frozen: FrozenCell): string[] {
  const problems: string[] = [], prepare = report.access.prepare, delivery = report.access.delivery;
  const queryId = sourceSemanticQueryIdentity(QUERY, fieldContractSha256);
  if (prepare?.query_semantics_id !== undefined && prepare.query_semantics_id !== queryId) problems.push("prepared_Q_identity_mismatch");
  for (const descriptor of prepare?.candidates ?? []) {
    const expected = frozen.sources.find(row => row.source_id === descriptor.source_id);
    if (expected === undefined || descriptor.source_version !== expected.source_version || descriptor.content_digest !== expected.content_digest
      || descriptor.interpretation_id !== expected.interpretation_id || descriptor.interpretation !== undefined
      && canonicalJson(descriptor.interpretation) !== canonicalJson(expected.interpretation)) problems.push("returned_H_binding_mismatch");
  }
  if (delivery === undefined) return problems;
  if (prepare === undefined) return [...problems, "delivery_without_captured_preparation"];
  const identity = sourceSemanticLibraryRequestIdentity({ workspace_id: WS, as_of: CLOCK, authorized_scopes: SCOPES.scopes,
    original_query: ORIGINAL_QUERY, query_semantics: QUERY, query_semantics_status: prepare.query_semantics_status,
    access_policy: "query-conditioned-v1", semantic_correspondences: [], budget: accessBudget(report.slot), output_byte_limit: 1_000_000,
    ...(report.policy.selected_hint === null ? {} : { access_hint: report.policy.selected_hint }) });
  if (delivery.request_identity !== identity) problems.push("public_request_identity_mismatch");
  if ((delivery.proofs?.length ?? 0) > 0 || delivery.coverage.conditional_computation !== "unexercised") problems.push("post_fork_reasoning_was_exercised");
  for (const [index, result] of (delivery.results ?? []).entries()) {
    if (result.target.kind !== "source_evidence") { problems.push("non_source_public_result"); continue; }
    const record = result.target.root_id;
    const expected = frozen.sources.find(row => row.record_id === record);
    if (expected === undefined || !expected.text.includes(result.content_preview)) problems.push("public_source_bytes_or_identity_mismatch");
    const entry = delivery.index?.entries[index];
    if (entry === undefined || canonicalJson(entry.target) !== canonicalJson(result.target)) problems.push("public_result_index_identity_mismatch");
  }
  return problems;
}

function qualifiedRaw(delivery: Delivery | undefined, frozen: FrozenCell) {
  if (delivery?.results === undefined || delivery.index === undefined) return { delivered: false, rows: [] };
  const rows = delivery.results.map((row, index) => {
    const target = row.target;
    const source = target.kind === "source_evidence" ? frozen.sources.find(source => source.record_id === target.root_id) : undefined;
    const entry = delivery.index!.entries[index];
    const qualifiers = delivery.slot_qualifiers?.filter(qualifier => qualifier.index === index) ?? [];
    const disclosure = entry === undefined ? undefined : delivery.source_disclosures?.[indexEntryCacheKey(entry)];
    const complete = source !== undefined && row.content_preview === source.text;
    const qualified = entry !== undefined && canonicalJson(entry.target) === canonicalJson(target)
      && qualifiers.some(qualifier => qualifier.evidence_kind === "source_evidence")
      && disclosure?.proof_use.kind === "source_only";
    return { result: row, source_id: source?.source_id ?? null, complete, qualified, qualifiers, disclosure: disclosure ?? null };
  });
  return { rows, delivered: rows.some(row => row.source_id === frozen.assessment_only.sufficient_source_id && row.complete && row.qualified) };
}

function terminalBudget(report: NativeReport): boolean {
  if (report.access.prepare?.outcome?.status === "resource_exhausted") return true;
  if (report.status !== "native_failure" || report.stop !== "public_delivery_failed") return false;
  const calls = report.calls.filter(call => call.name === "access-delivery"), call = calls[0];
  if (calls.length !== 1 || call === undefined || call.request.operation !== "recall"
    || !call.capture_complete || call.response !== undefined || call.error?.work == null) return false;
  if (call.request.query_handle === undefined || call.request.query_handle !== report.access.prepare?.query_handle
    || canonicalJson(call.request.budget) !== canonicalJson(accessBudget(report.slot))) return false;
  // The pinned worker wraps SourceSemanticResourceExhausted in CoreError; callNative retains String(error).
  // The same code/subcode also covers lease capacity, whose message is not a request-budget exhaustion.
  return call.error.code === "CONFLICT" && call.error.sub_code === "RETRYABLE_BACKPRESSURE"
    && /^CoreError: source semantic [^\r\n]+ budget exhausted$/u.test(call.error.message)
    && !call.error.message.includes("\n") && !call.error.message.includes("\r");
}

function acquisitionEndpoint(report: NativeReport, present: boolean, identityProblems: readonly string[], kind: "raw" | "H"): Endpoint {
  if (!report.common.ready) return endpoint("unknown", report.stop);
  if (report.protocol_contradiction !== null || identityProblems.length > 0) return endpoint("unknown", "identity_or_protocol_inconsistent");
  if (report.calls.some(call => !call.capture_complete)) return endpoint("unknown", "native_capture_incomplete");
  if (report.calls.some(call => call.meter_error !== undefined)) return endpoint("unknown", "native_meter_retention_failed");
  if (present) return endpoint("success", kind === "raw" ? "exact_qualified_public_sufficient_raw" : "necessary_H_body_publicly_returned");
  if (terminalBudget(report)) return endpoint("failure", "captured_bound_terminal_exhaustion");
  if (report.status === "observed" && (kind === "H" ? report.access.prepare !== undefined : report.access.delivery?.results !== undefined)) {
    return endpoint("failure", kind === "raw" ? "complete_public_delivery_without_sufficient_raw" : "complete_preparation_without_necessary_H");
  }
  return endpoint("unknown", report.stop);
}

/** Oracle identities enter only this post-access assessment. They never choose a native request. */
export function assessSlot(report: NativeReport, frozen: FrozenCell) {
  const identities = checkPublicIdentities(report, frozen), raw = qualifiedRaw(report.access.delivery, frozen);
  const h = report.access.prepare?.candidates.find(row => row.interpretation_id === frozen.assessment_only.sufficient_interpretation_id
    && row.interpretation !== undefined);
  const before = initialObservations([report.common.prepare?.access, report.common.delivery?.discovery?.access]);
  const after = initialObservations([report.access.prepare?.access, report.access.delivery?.discovery?.access]);
  const priorRaw = new Set((report.common.delivery?.results ?? []).map(row => canonicalJson({ target: row.target, text: row.content_preview })));
  const priorRecords = new Set(before.read_sources.map(row => row.record_id));
  const actual = sumWork(report.calls.map(workOf));
  const common = sumWork(report.calls.filter(row => row.name.startsWith("common-")).map(workOf));
  const post = sumWork(report.calls.filter(row => !row.name.startsWith("common-")).map(workOf));
  const publication = report.setup?.known_publication_subtotal ?? report.publication_receipts.reduce((sum, row) => ({
    work_units: sum.work_units + row.usage.work_units, memory_bytes: sum.memory_bytes + row.usage.memory_bytes
  }), { work_units: 0, memory_bytes: 0 });
  const reserved = report.allowance;
  return { slot: report.slot, execution_status: report.status, stop: report.stop, native_started: report.native_started,
    endpoints: { public_sufficient_raw: acquisitionEndpoint(report, raw.delivered, identities, "raw"),
      returned_necessary_H: acquisitionEndpoint(report, h !== undefined, identities, "H") },
    identity_problems: identities, policy: { selected_hint: report.policy.selected_hint, decision: report.policy.decision,
      initial_bindings: report.policy.initial_bindings,
      expected_hint: frozen.assessment_only.expected_hint, expected_hint_is_assessment_only: true,
      matched_expected: report.slot.arm === "F" && report.policy.selected_hint !== null
        ? report.policy.selected_hint === frozen.assessment_only.expected_hint : null },
    public_raw: raw.rows,
    newly_delivered_raw: raw.rows.filter(row => !priorRaw.has(canonicalJson({ target: row.result.target, text: row.result.content_preview }))),
    returned_necessary_H: h ?? null,
    observation: { before, after, newly_observed_sources: before.complete && after.complete
      ? after.read_sources.filter(row => !priorRecords.has(row.record_id)) : null,
      physical_first_read_novelty: "unknown_no_physical_IO_trace", public_delivery_is_not_new_observation: true },
    reservations: { declared_common: COMMON_RESERVATION, declared_post_fork: postForkReservation(report.slot.point),
      declared_total: allowance(report.slot.point), actual: reserved === null ? null
        : { work_units: reserved.work_reserved, memory_bytes: reserved.memory_reserved,
          read_count: reserved.read_count, effect_count: reserved.effect_count },
      complete_post_fork_reservation: !report.common.ready || reserved === null ? null
        : reserved.work_reserved === allowance(report.slot.point).total_work_units
          && reserved.memory_reserved === allowance(report.slot.point).total_memory_bytes,
      native_debits_are_inside_reservations: true, refunded: false },
    native_cost: { publication: { known_subtotal: publication, coverage: report.setup?.status === "complete" ? "complete" : "known_prefix_only",
      boundary_receipts_are_not_additional_debits: true }, public_calls: actual, common_public_calls: common, post_fork_public_calls: post },
    lifecycle_cost: "C0(cell) + publication native subtotal + common/public native components + U_arm",
    C0: "unknown_source_admission_and_authored_construction", U_arm: "unknown_host_policy_selection_and_serialization",
    total_lifecycle_cost: "unknown", physical_efficiency: "not_established", final_reader: "not_exercised",
    allowance: reserved, failure: report.failure, protocol_contradiction: report.protocol_contradiction };
}
export type Assessment = ReturnType<typeof assessSlot>;

/** Worker capabilities and RSS differ across fresh instances; every semantic binding and logical receipt remains compared. */
function commonComparable(report: NativeReport): unknown {
  const omitEphemeral = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(omitEphemeral);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "rss_bytes").map(([key, child]) => [key,
      ["source_handle", "query_handle", "continuation_handle"].includes(key) ? "present_process_local_capability" : omitEphemeral(child)]));
  };
  return { manifest: report.manifest, setup: report.setup,
    publication_receipts: report.publication_receipts,
    native_calls: report.calls.filter(row => row.name.startsWith("common-")).map(row => ({ name: row.name,
      request: omitEphemeral(row.request), response: omitEphemeral(row.response), error: omitEphemeral(row.error) })) };
}

export function compareCellCommon(reports: readonly NativeReport[]) {
  const ready = reports.filter(row => row.common.ready), reference = ready[0];
  const divergent = reference === undefined ? [] : ready.filter(row =>
    canonicalJson(commonComparable(row)) !== canonicalJson(commonComparable(reference))).map(row => row.slot.id);
  return { status: reference === undefined ? "no_ready_reference" : divergent.length > 0 ? "diverged" : "matched",
    reference_slot: reference?.slot.id ?? null, compared_slots: ready.map(row => row.slot.id), divergent_slots: divergent,
    unready_slots: reports.filter(row => !row.common.ready).map(row => row.slot.id),
    excludes: ["fresh_process_capability_strings", "RSS", "elapsed_time"] };
}

export function comparePoint(reports: readonly NativeReport[], assessments: readonly Assessment[], cellCommon: ReturnType<typeof compareCellCommon>,
  globalProtocolFailure: string | null) {
  const common = globalProtocolFailure === null && cellCommon.status === "matched" && reports.length === 4 && reports.every(row => row.common.ready);
  const f = assessments.find(row => row.slot.arm === "F")!;
  const comparison = assessments.filter(row => row.slot.arm !== "F").map(control => {
    const fEndpoint = f.endpoints.public_sufficient_raw, baselineEndpoint = control.endpoints.public_sufficient_raw;
    const reserved = f.reservations.complete_post_fork_reservation === true && control.reservations.complete_post_fork_reservation === true;
    const known = common && reserved && fEndpoint.status !== "unknown" && baselineEndpoint.status !== "unknown";
    const native = f.native_cost.post_fork_public_calls, baselineNative = control.native_cost.post_fork_public_calls;
    const measured = native.unmetered_calls === 0 && baselineNative.unmetered_calls === 0;
    const delta = known && measured ? { work_units: native.known_subtotal.logical_work - baselineNative.known_subtotal.logical_work,
      memory_bytes: native.known_subtotal.logical_memory_bytes - baselineNative.known_subtotal.logical_memory_bytes } : null;
    return { control: control.slot.arm, outcome: !known ? "unknown" : fEndpoint.status === baselineEndpoint.status ? "tie"
      : fEndpoint.status === "success" ? "F_win" : "F_loss",
    H_readiness_only: known && fEndpoint.status === baselineEndpoint.status
      && f.endpoints.returned_necessary_H.status === "success" && control.endpoints.returned_necessary_H.status === "failure",
    post_fork_native_delta_F_minus_control: delta,
    equal_declared_reservation: canonicalJson(f.reservations.declared_post_fork) === canonicalJson(control.reservations.declared_post_fork),
    actual_reservations_completed: reserved,
    full_lifecycle_cost_comparison: "unknown_C0_and_U", physical_cost_comparison: "not_established" };
  });
  return { cell: f.slot.cell, point: f.slot.point, paired_common: common ? "matched" : "unknown",
    cell_common: cellCommon, global_protocol_failure: globalProtocolFailure, comparison,
    slots: assessments.map(row => ({ id: row.slot.id, status: row.execution_status, endpoints: row.endpoints,
      reservations: row.reservations, native_cost: row.native_cost })),
    finite_authored_workload_only: true, consumer_utility: "not_exercised" };
}
