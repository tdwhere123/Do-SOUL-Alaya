import { expect, it, vi } from "vitest";
import { SourceSemanticResourceLedger, sourceIndexEntry, type InformationIndex } from "@do-soul/alaya-protocol";
import { encodeRecallResult } from "../../../recall/runtime/recall-result-encoding.js";
import { encodeIndexResults, encodeRecallPageResponse, frameEncodedIndex } from "../../../recall/runtime/recall-page-encoding.js";
import { fitProjectedRecallPage, framingInterruption, pageResourceRefusal } from "../../../recall/runtime/recall-page-fit.js";
import { runConditionalFieldRecallWithReceipt } from "../../../recall/runtime/recall-service-runner.js";
import type { ConditionalFieldRecallRequest } from "../../../recall/runtime/recall-service-runner-types.js";
import { defaultBudget, FAR_FUTURE_EXPIRY } from "../conditional-field/reference/deployment.fixture.js";

const request: ConditionalFieldRecallRequest = {
  workspace_id: "workspace", query_text: "needle", budget: defaultBudget(),
  snapshot_id: `sha256:${"a".repeat(64)}`, interpretation_clock: "2026-09-06T12:00:00.000Z",
  as_of: "2026-09-06T12:00:00.000Z", expires_at: FAR_FUTURE_EXPIRY, readers: {}, authorized_scopes: null
};
const index: InformationIndex = {
  schema_version: 1, query_id: `sha256:${"b".repeat(64)}`, snapshot_id: request.snapshot_id,
  result_version: "ordinary-native-field.v3", entries: [], continuation: null,
  completeness: { schema_version: 1, logical_index: "open", observed_coverage: "unknown",
    transport: "complete", payload: "complete", representation: "complete" },
  representation: { schema_version: 1, policy: "construct_index_then_page_then_payload",
    page_budget: 1, identity_tie_break: "serialization" }
};

it.each(["interrupted", "unknown", "invalidated", "unavailable", "resource_rejected", "cancelled", "omitted"] as const)(
  "preserves explicit payload %s through service and public encoders", payload => {
    const entry = sourceIndexEntry({ workspace_id: "workspace", root_kind: "source_record", root_id: "empty",
      source_version: "1", content_digest: `sha256:${"c".repeat(64)}`, evidence_object_id: null,
      association_milligrades: 500, hypothesis_id: "source", output_binding: "source", program_state: "matched", time_state: "current" });
    const page = { ...index, entries: [entry], as_of: request.as_of,
      completeness: { ...index.completeness, payload, transport: "interrupted" as const } };
    const service = encodeRecallResult(page);
    expect(service.index.completeness.payload).toBe(payload);
    const results = encodeIndexResults(service.index);
    const framed = frameEncodedIndex(service.index, results);
    const response = encodeRecallPageResponse({ delivery_id: "state-check", index: framed, results,
      active_constraints: [], active_constraints_count: null, degradation_reason: null });
    expect(response.index?.completeness.payload).toBe(payload);
    expect(response.results[0]?.content_preview).toBe("[payload omitted]");
    expect(response.results[0]?.target.kind === "source_evidence" ? response.results[0].target.span : undefined).toBeUndefined();
  });

it.each(["count", "metadata", "both fit gates"])("distinguishes %s omission from a fitted empty page", kind => {
  const entry = sourceIndexEntry({ workspace_id: "workspace", root_kind: "source_record", root_id: "private-source",
    source_version: "1", content_digest: `sha256:${"c".repeat(64)}`, evidence_object_id: null,
    association_milligrades: 500, hypothesis_id: "source", output_binding: "source", program_state: "matched", time_state: "current" });
  const page = { ...index, entries: [entry], as_of: request.as_of,
    representation: { ...index.representation, page_budget: kind === "count" ? 0 : 1 } };
  const meter = new SourceSemanticResourceLedger({ work_units: 10_000, memory_bytes: 1_000_000 });
  const fitRequest = { ...request,
    delivery_budget: { max_total_tokens: kind === "count" ? 2_000 : 1,
      max_encoded_bytes: kind === "both fit gates" ? 1 : 1_000_000 } };
  const fitted = fitProjectedRecallPage({ index: page, previews: new Map(), metadata: {}, meter,
    request_digest: "omission", request: fitRequest });
  expect(fitted.fits).toBe(false);
  expect(fitted.index.entries).toHaveLength(1);
  expect(fitted.result_count).toBe(0);
  expect(fitted.index.completeness.transport).toBe("partial");
  expect(fitted.interruption).toBeUndefined();
  const refusal = pageResourceRefusal({ message: "refused", fit: fitted.observation });
  expect(refusal.details).toMatchObject({ resource: "encoded_members", reason: "encoded_member_omission",
    page_fit: { measurement: "complete", expected_result_count: 1,
      byte_overflow: kind === "both fit gates", encoding: { candidate_count: kind === "count" ? 0 : 1,
        result_count: 0, used_tokens: 0, count_limited_entries: kind === "count" ? 1 : 0 } } });
  if (kind === "count") expect(fitted.observation.encoding?.metadata_block).toBeNull();
  else {
    expect(fitted.observation.encoding?.metadata_block?.remaining_tokens).toBe(1);
    expect(fitted.observation.encoding?.metadata_block?.essential_bytes).toBeGreaterThan(1);
  }
  if (kind !== "both fit gates") {
    expect(fitted.bytes).toBeLessThan(fitRequest.delivery_budget.max_encoded_bytes);
    expect(refusal.details).not.toHaveProperty("required_bytes");
  }
  expect(fitted.observation.spent_work).toBe(meter.spentWork);
  expect(meter.spentWork).toBeGreaterThan(0);
  expect(JSON.stringify(refusal.details)).not.toContain("private-source");
  expect(Buffer.byteLength(JSON.stringify(refusal.details))).toBeLessThan(1_024);
});

function frame(envelope: unknown, work = 1000, maxBytes = 1_000_000) {
  const meter = new SourceSemanticResourceLedger({ work_units: work, memory_bytes: 1_000_000 });
  const encode = vi.fn(() => envelope);
  const fit = fitProjectedRecallPage({ index, previews: new Map(), metadata: {}, meter,
    request_digest: "frame", request: { ...request, encode_page: encode,
      delivery_budget: { max_total_tokens: 2000, max_encoded_bytes: maxBytes } } });
  return { fit, meter, encode };
}

it("charges surface metadata to the same fit owner and reports the whole field balance", () => {
  const execute = (work: number) => {
    let budgetWork: number | undefined;
    let invocations = 0;
    const executed = runConditionalFieldRecallWithReceipt({ ...request,
      encode_page: (_index, _previews, _metadata, owner) => {
        invocations++;
        owner.charge(work, work === 0 ? 0 : 13, "surface metadata");
        return { ok: true };
      }
    }, { issue: "defer", capture_budget_work: value => { budgetWork = value; } });
    return { actual: executed.execution_receipt.actual!, budgetWork, invocations };
  };
  const baseline = execute(0), charged = execute(7);
  expect(baseline.budgetWork).toBeTypeOf("number");
  // The paid progress envelope and final membership are real, separately charged
  // codec invocations. A discarded prepared control is not free work.
  expect(charged.invocations).toBe(2);
  expect(charged.invocations).toBe(baseline.invocations);
  expect(charged.budgetWork).toBe(baseline.budgetWork! + 7 * charged.invocations);
  expect(charged.actual.phases.index.budget_work).toBe(baseline.actual.phases.index.budget_work! + 7 * charged.invocations);
  expect(charged.actual.charged_retained_bytes).toBe(baseline.actual.charged_retained_bytes + 13 * charged.invocations);
  expect(charged.actual).not.toHaveProperty("budget_work");
});

it.each([0, 1])("does not recreate a declared reserve after admission leaves %s work", work => {
  const encode = vi.fn(() => ({})), capture = vi.fn();
  expect(() => runConditionalFieldRecallWithReceipt({ ...request, encode_page: encode,
    budget: { ...request.budget, work_units: work, finalization_reserve: 100 }
  }, { issue: "defer", capture_budget_work: capture })).toThrow(expect.objectContaining({
    details: expect.objectContaining({ outcome: "resource_exhausted", resource: "framing_work" })
  }));
  expect(encode).not.toHaveBeenCalled();
  expect(capture).not.toHaveBeenCalled();
});

it("does not charge rejected exploration that was never executed", () => {
  let measured: number | undefined;
  const executed = runConditionalFieldRecallWithReceipt({ ...request, query_text: "x".repeat(5000),
    encode_page: () => ({ rejected: true })
  }, { issue: "defer", capture_budget_work: value => { measured = value; } });
  expect(executed.execution_receipt.actual?.phases.observe.budget_work).toBe(0);
  expect(measured).toBeGreaterThan(0);
  expect(measured).toBe(executed.execution_receipt.actual?.phases.index.budget_work);
  expect(measured).toBeLessThan(request.budget.finalization_reserve);
});

it.each(["work", "memory"] as const)("preserves a codec's %s refusal as an interrupted measurement", resource => {
  const meter = new SourceSemanticResourceLedger({ work_units: resource === "work" ? 3 : 1000,
    memory_bytes: resource === "memory" ? 0 : 1000 });
  const observe = vi.fn();
  const fit = fitProjectedRecallPage({ index, previews: new Map(), metadata: {}, meter,
    request_digest: "frame", request: { ...request, observe_page_fit: observe,
      encode_page: (_index, _previews, _metadata, owner) => {
        expect(owner.work).toBe(meter.work);
        owner.charge(resource === "work" ? 4 : 0, resource === "memory" ? 1 : 0, "surface metadata");
        return { ok: true };
      } } });
  expect(fit).toMatchObject({ fits: false, interruption: "codec", bytes: 0 });
  expect(observe).toHaveBeenLastCalledWith(expect.objectContaining({ interruption: "codec", codec_invocations: 1 }));
  expect(meter.spentWork).toBe(2);
});

it("measures JSON escaping and UTF-8 exactly without allocating an enclosing JSON string", () => {
  const envelope = { text: '\"\\\b\f\n\r\t\u0000\ud800\udc00\ud800\udc00汉🙂',
    omitted: undefined, values: [undefined, null, true, false, -0, 1e30, NaN, Infinity] };
  const expected = Buffer.byteLength(JSON.stringify(envelope));
  const measured = frame(envelope);
  expect(measured.fit.bytes).toBe(expected);
  expect(measured.fit.fits).toBe(true);
  expect(measured.fit.observation).toMatchObject({ measurement: "complete", byte_overflow: false,
    expected_result_count: 0, encoding: { result_count: 0, metadata_block: null }, measured_bytes: expected });
  expect(measured.encode).toHaveBeenCalledTimes(1);
  expect(measured.meter.spentWork).toBeGreaterThan(2);
  expect(measured.meter.spentBytes).toBe(0);
});

it("stops a large empty envelope at the work boundary instead of clipping its receipt", () => {
  const envelope = { large: "x".repeat(100_000) };
  const limited = frame(envelope, 2);
  expect(limited.encode).toHaveBeenCalledTimes(1);
  expect(limited.fit).toMatchObject({ fits: false, interruption: "work" });
  expect(limited.meter.spentWork).toBe(2);
  expect(framingInterruption(limited.fit.interruption!, limited.fit.observation).details).toMatchObject({
    resource: "framing_work", reason: "framing_interrupted", page_fit: {
      measurement: "interrupted", byte_overflow: null, spent_work: 2, codec_invocations: 1
    }
  });
  const complete = frame(envelope, 100);
  expect(complete.fit.fits).toBe(true);
  expect(complete.fit.bytes).toBe(Buffer.byteLength(JSON.stringify(envelope)));
  expect(complete.meter.spentWork).toBe(100);
});

it("bounds traversal even when every property is omitted from JSON", () => {
  const envelope = Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [String(i), undefined]));
  const measured = frame(envelope, 3);
  expect(measured.fit).toMatchObject({ fits: false, interruption: "work" });
  expect(measured.meter.spentWork).toBe(3);
});

it("records an oversized empty envelope as measured size refusal, not valid-empty success", () => {
  const measured = frame({ large: "x".repeat(100_000) }, 1000, 64);
  expect(measured.fit.fits).toBe(false);
  expect(measured.fit.interruption).toBeUndefined();
  expect(measured.fit.bytes).toBe(100_012);
  expect(pageResourceRefusal({ message: "refused", fit: measured.fit.observation }).details).toMatchObject({
    resource: "encoded_page", reason: "encoded_byte_overflow", available_bytes: 64, required_bytes: 100_012,
    page_fit: { measurement: "complete", byte_overflow: true, expected_result_count: 0,
      encoding: { result_count: 0, metadata_block: null } }
  });
  expect(measured.meter.spentWork).toBe(100);
});

it("refuses before invoking a codec when even its entry cannot be paid", () => {
  const measured = frame({}, 1);
  expect(measured.encode).not.toHaveBeenCalled();
  expect(measured.fit.interruption).toBe("work");
  expect(measured.meter.spentWork).toBe(0);
  expect(measured.fit.observation).toMatchObject({ measurement: "interrupted", encoding: null,
    codec_invocations: 0, byte_overflow: null, spent_work: 0 });
});

it("charges codec entry before a thrown callback and preserves its cause", () => {
  const meter = new SourceSemanticResourceLedger({ work_units: 1000, memory_bytes: 1_000_000 });
  const cause = new Error("authored codec failure"), encode = vi.fn(() => { throw cause; });
  expect(() => fitProjectedRecallPage({ index, previews: new Map(), metadata: {}, meter,
    request_digest: "throw", request: { ...request, encode_page: encode } }))
    .toThrow(expect.objectContaining({ cause, details: { outcome: "codec_failed", resource: "public_envelope" } }));
  expect(encode).toHaveBeenCalledTimes(1);
  expect(meter.spentWork).toBe(2);
});

it("does not relabel a codec's separate ledger refusal as Core framing exhaustion", () => {
  const meter = new SourceSemanticResourceLedger({ work_units: 1000, memory_bytes: 1_000_000 });
  const foreign = new SourceSemanticResourceLedger({ work_units: 100, memory_bytes: 0 });
  expect(() => fitProjectedRecallPage({ index, previews: new Map(), metadata: {}, meter,
    request_digest: "foreign-ledger", request: { ...request, encode_page: () => {
      foreign.charge(40, 0); foreign.charge(0, 1); return {};
    } } })).toThrow(expect.objectContaining({ details: { outcome: "codec_failed", resource: "public_envelope" } }));
  expect(meter.spentWork).toBe(2);
  expect(foreign.spentWork).toBe(40);
});

it("never invokes a hidden serializer or accessor while sizing codec output", () => {
  const serializer = vi.fn(() => "hidden"), getter = vi.fn(() => "hidden");
  expect(() => frame({ toJSON: serializer })).toThrow("serializer");
  expect(serializer).not.toHaveBeenCalled();
  const callable = Object.assign(() => undefined, { toJSON: serializer });
  expect(() => frame({ nested: callable })).toThrow("non-JSON");
  expect(serializer).not.toHaveBeenCalled();
  expect(() => frame(Object.defineProperty({}, "payload", { get: getter, enumerable: true }))).toThrow("accessor");
  expect(getter).not.toHaveBeenCalled();
});
