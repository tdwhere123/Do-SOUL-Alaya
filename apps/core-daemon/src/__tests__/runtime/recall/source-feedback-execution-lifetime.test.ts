import {
  afterAll,
  afterEach,
  describe,
  expect,
  it,
  vi
} from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../../scripts/test-support/provider-free/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
// Source-only adapter controls: do not require a newly emitted Core barrel or Worker artifact.
vi.mock("@do-soul/alaya-core", async original => ({
  ...await original<typeof import("@do-soul/alaya-core")>(),
  ...await import("../../../../../../packages/core/src/recall/runtime/source-feedback-session.js")
}));
afterEach(() => { expect(isolation.violations).toEqual([]); vi.useRealTimers(); vi.restoreAllMocks(); });
afterAll(() => { isolation.restore(); });

import {
  CoreError,
  fieldContractSha256,
  createSourceFeedbackSession,
  type SourceFeedbackSessionInput
} from "@do-soul/alaya-core";
import {
  buildSourceReferenceCatalog,
  canonicalJson,
  encodeSourceDisclosure,
  SourceSemanticWorkerResultSchema,
  UNKNOWN_UTTERANCE_ATTRIBUTION,
  type SourceSemanticWorkerResult
} from "@do-soul/alaya-protocol";
import { RecallReadWorkerDeadline } from "../../../runtime/recall/recall-read-worker-deadline.js";
import { executeSourceFeedback } from "../../../runtime/recall/source-feedback-execution.js";
import type { SourceSemanticsExecutionPort } from "../../../runtime/recall/recall-read-worker-client.js";
import {
  CHILD,
  CONTEXT,
  withFeedbackSource,
  ORIGINAL,
  query,
  type Reason
} from "./source-feedback.test-support.js";


describe("source-feedback execution lifetime", () => {
const CLOCK = "2026-09-18T00:00:00.000Z", BODY = "M7 uses AP-42.", digest = `sha256:${fieldContractSha256(BODY)}`;
const CHILD = { schema_version: 1 as const, work_units: 100_000, memory_bytes: 1_000_000,
  page_budget: 100, finalization_reserve: 1000, min_envelope: 10 };
const CONTEXT = { workspace_id: "ws", as_of: CLOCK, principal: "caller",
  authorized_scopes: { mode: "named" as const, scopes: ["project"] } };
function session(): SourceFeedbackSessionInput {
  return { request_id: "request", parent_entitlement_id: "parent", workspace_id: "ws", original_query: "Which ticket does M7 use?",
    as_of: CLOCK, scope_identity: canonicalJson([CONTEXT.principal, CONTEXT.authorized_scopes]), source_id: "M7",
    source_target: { kind: "source_evidence", workspace_id: "ws", root_kind: "source_record", root_id: "root",
      source_version: "1", content_digest: digest, evidence_object_id: null },
    seed: { kind: "reason", accepts_unreviewed_conditional_results: true, original_query: "Which ticket does M7 use?",
      source_interpretation_id: digest, budget: CHILD, output_byte_limit: 1_000_000 },
    action_budget: CHILD, budget: { ...CHILD, work_units: 400_000, memory_bytes: 4_000_000 } };
}
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) };
}
const measured = { native_work: 7, index_work: 4, logical_work: 11, native_bytes: 40, logical_memory_bytes: 80, rss_bytes: 1000 };
function prepared(): SourceSemanticWorkerResult {
  // Structurally admitted synthetic transport data, not source or accepting-binding proof.
  return SourceSemanticWorkerResultSchema.parse({ kind: "prepare_source", source_handle: "prepared", source_id: "M7",
    source_version: "1", content_digest: digest, attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION,
    catalog: buildSourceReferenceCatalog(fieldContractSha256(BODY), [{ assertion_id: 1, text: BODY }], fieldContractSha256),
    source_disclosure: encodeSourceDisclosure({ material_kind: "unknown", source_binding: "unbound", evaluated_as_of: CLOCK,
      validity: { kind: "unknown", reason: "unbound" }, temporal_state: "unknown",
      proof_use: { kind: "source_only", qualification: "not_current_proof" } }),
    coverage: { discovery: "complete", source_interpretation: "unexercised", query_semantics: "unexercised",
      semantic_correspondence: "unexercised", conditional_computation: "unexercised", payload: "complete" }, work: measured });
}
function port(execute: SourceSemanticsExecutionPort["execute"]): SourceSemanticsExecutionPort {
  return { execute, withPreparedExecution: async (input, work) => await work(() => execute(input)),
    withExecutionScope: async (input, work) => {
      // This tests adapter settlement only. Physical occupancy is tested with the real lifecycle/SQLite fixture.
      const deadline = new RecallReadWorkerDeadline("synthetic feedback scope", input.timeoutMs, input.signal);
      try { return await deadline.run(() => work(() => "dispatched")); }
      finally { deadline.dispose(); }
    } };
}
const drain = () => new Promise<void>(resolve => setImmediate(resolve));

it("preserves a preaborted caller's reason without reserving or dispatching an action", async () => {
  const controller = new AbortController(), reason = new Error("caller left before scope entry");
  controller.abort(reason);
  const execute = vi.fn<SourceSemanticsExecutionPort["execute"]>(async () => prepared());
  const trace = await executeSourceFeedback({ session: session(), context: CONTEXT, port: port(execute), signal: controller.signal, timeoutMs: 1000 });
  expect(trace).toMatchObject({ status: "cancelled", terminal_cause: { kind: "caller_abort", name: "Error", message: reason.message },
    exposures: [], settlements: [], accounting: { logical_work: 0, reserved_work: 0, reserved_memory_bytes: 0 } });
  expect(trace.terminal_cause?.reason).toMatchObject({ name: "Error", message: reason.message });
  expect(execute).not.toHaveBeenCalled();
});

it("retains uncertain work and caller cause while rejecting a late result and every follow-up action", async () => {
  const controller = new AbortController(), reason = new CoreError("CONFLICT", "caller revoked task", { subCode: "CONCURRENT_MODIFICATION" });
  const entered = deferred(), release = deferred<SourceSemanticWorkerResult>();
  const execute = vi.fn<SourceSemanticsExecutionPort["execute"]>(async () => { entered.resolve(); return await release.promise; });
  try {
    const running = executeSourceFeedback({ session: session(), context: CONTEXT, port: port(execute), signal: controller.signal, timeoutMs: 60_000 });
    await entered.promise;
    controller.abort(reason);
    const trace = await running;
    expect(trace).toMatchObject({ status: "unknown", terminal_cause: { kind: "caller_abort", name: "CoreError", message: reason.message,
      code: "CONFLICT", subCode: "CONCURRENT_MODIFICATION" }, exposures: [],
      accounting: { logical_work: 0, reserved_work: CHILD.work_units, reserved_memory_bytes: CHILD.memory_bytes } });
    expect(trace.settlements).toHaveLength(1);
    expect(trace.settlements[0]?.[1]).toMatchObject({ status: "unknown", phase: "dispatched", terminal_cause: { message: reason.message } });
    release.resolve(prepared()); await drain();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(trace.exposures).toEqual([]);
    expect(trace.joint_assessment.status).toBe("not_lowered");
  } finally { release.resolve(prepared()); }
});

it("holds reserved unknown occupancy when abort-reason accessors throw", async () => {
  const controller = new AbortController(), reason = new Error("caller revoked request");
  Object.assign(reason, { code: "ABORT_ERR" });
  Object.defineProperty(reason, "cause", { configurable: true, get() { throw new Error("cause accessor"); } });
  Object.defineProperty(reason, "stack", { configurable: true, get() { throw new Error("stack accessor"); } });
  const entered = deferred(), release = deferred<SourceSemanticWorkerResult>();
  const execute = vi.fn<SourceSemanticsExecutionPort["execute"]>(async () => { entered.resolve(); return await release.promise; });
  try {
    const running = executeSourceFeedback({ session: session(), context: CONTEXT, port: port(execute), signal: controller.signal, timeoutMs: 60_000 });
    await entered.promise;
    controller.abort(reason);
    const trace = await running;
    expect(trace).toMatchObject({ status: "unknown", terminal_cause: { kind: "caller_abort", name: "Error",
      message: reason.message, code: "ABORT_ERR" }, exposures: [],
      accounting: { logical_work: 0, reserved_work: CHILD.work_units, reserved_memory_bytes: CHILD.memory_bytes } });
    expect(() => structuredClone(trace.terminal_cause)).not.toThrow();
    expect(trace.settlements).toHaveLength(1);
    expect(trace.settlements[0]?.[1]).toMatchObject({ status: "unknown", phase: "dispatched" });
    release.resolve(prepared()); await drain();
    expect(execute).toHaveBeenCalledTimes(1);
  } finally { release.resolve(prepared()); }
});

it("uses the same uncancelled transport result to advance, independently checking the late-result control", async () => {
  const execute = vi.fn<SourceSemanticsExecutionPort["execute"]>();
  execute.mockResolvedValueOnce(prepared()).mockRejectedValueOnce(new Error("next source validation reached"));
  const trace = await executeSourceFeedback({ session: session(), context: CONTEXT, port: port(execute), timeoutMs: 1000 });
  expect(execute.mock.calls.map(([input]) => input.request.kind)).toEqual(["prepare_source", "validate_source"]);
  expect(trace.exposures.map(row => row.result.kind)).toEqual(["prepare_source"]);
});

it.each([true, false])("preserves domain error code/message independently of measured work availability (%s)", known => {
  const reason = new CoreError("CONFLICT", "source is no longer authorized", { subCode: "RETRYABLE_BACKPRESSURE",
    ...(known ? { details: { work: measured } } : {}) });
  const execute = vi.fn<SourceSemanticsExecutionPort["execute"]>(async () => { throw reason; });
  return executeSourceFeedback({ session: session(), context: CONTEXT, port: port(execute), timeoutMs: 1000 }).then(trace => {
    expect(trace).toMatchObject({ status: known ? "failed" : "unknown", terminal_cause: { kind: "execution_error", name: "CoreError",
      code: "CONFLICT", subCode: "RETRYABLE_BACKPRESSURE", message: reason.message }, exposures: [] });
    expect(trace.accounting.logical_work).toBe(known ? measured.logical_work : 0);
    expect(trace.accounting.reserved_work).toBe(known ? 0 : CHILD.work_units);
    expect(trace.terminal_cause?.reason).toMatchObject({ name: "CoreError", message: reason.message,
      code: "CONFLICT", subCode: "RETRYABLE_BACKPRESSURE", ...(known ? { details: { work: measured } } : {}) });
  });
});

it("retains the deadline cause without calling it caller cancellation or refunding unmeasured work", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const controller = new AbortController(), entered = deferred(), release = deferred<SourceSemanticWorkerResult>();
  const execute = vi.fn<SourceSemanticsExecutionPort["execute"]>(async () => { entered.resolve(); return await release.promise; });
  try {
    const running = executeSourceFeedback({ session: session(), context: CONTEXT, port: port(execute), signal: controller.signal, timeoutMs: 100 });
    await entered.promise; await vi.advanceTimersByTimeAsync(100);
    const trace = await running;
    expect(controller.signal.aborted).toBe(false);
    expect(trace).toMatchObject({ status: "unknown", terminal_cause: { kind: "execution_error", name: "Error",
      message: "recall read worker synthetic feedback scope timed out after 100ms" },
      accounting: { logical_work: 0, reserved_work: CHILD.work_units }, exposures: [] });
    release.resolve(prepared()); await drain();
    expect(execute).toHaveBeenCalledTimes(1);
  } finally { release.resolve(prepared()); }
});
});

describe("source-feedback late binding", () => {
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) };
}

it("does not accept a late genuine native binding or dispatch fresh discovery after caller abort", async () => {
  await withFeedbackSource("AP-42", async ({ client, session }) => {
    const nativePort = client.sourceSemanticsPort!, controller = new AbortController();
    const bindingReady = deferred<SourceSemanticWorkerResult>(), deliver = deferred(), completed = deferred();
    const reason = new Error("caller no longer authorizes feedback");
    const execute = vi.fn<SourceSemanticsExecutionPort["execute"]>(async input => {
      const result = await nativePort.execute(input);
      if (input.request.kind === "reason") {
        bindingReady.resolve(result);
        // Controlled transport delay deliberately ignores cancellation. Native work
        // already completed; this is a late-acceptance test, NOT physical-exit proof.
        await deliver.promise;
        completed.resolve();
      }
      return result;
    });
    const port: SourceSemanticsExecutionPort = { ...nativePort, execute };
    try {
      const running = executeSourceFeedback({ session, context: CONTEXT, port, signal: controller.signal, timeoutMs: 20_000 });
      const actual = await bindingReady.promise;
      if (actual.kind !== "reason") throw new Error("native accepting result required");
      expect(actual.result?.outcome.status).toBe("interpreted");
      expect(actual.result?.binding_results?.[0]?.returned.ticket).toMatchObject({ node_id: "rTicket" });
      expect(actual.interpretation?.mentions.find(row => row.id === "mTicket")).toMatchObject({ text: "AP-42", utf8_span: [8, 13] });
      controller.abort(reason);
      const trace = await running;
      expect(trace.status).toBe("unknown");
      expect(trace.terminal_cause).toMatchObject({ kind: "caller_abort", message: reason.message });
      expect(trace.exposures.map(row => row.result.kind)).toEqual(["prepare_source", "validate_source"]);
      expect(trace.accounting.reserved_work).toBe(CHILD.work_units);
      expect(trace.accounting.reserved_memory_bytes).toBe(CHILD.memory_bytes);
      deliver.resolve(); await completed.promise;
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(execute.mock.calls.map(([input]) => input.request.kind)).toEqual(["prepare_source", "validate_source", "reason"]);
      expect(trace.exposures.some(row => row.result.kind === "reason" || row.result.kind === "prepare_query")).toBe(false);
      expect(trace.joint_assessment.status).toBe("not_lowered");
    } finally { deliver.resolve(); }
  });
}, 60_000);
});

describe("source-feedback native", () => {
function replay(sessionInput: SourceFeedbackSessionInput, results: readonly SourceSemanticWorkerResult[]) {
  const session = createSourceFeedbackSession(sessionInput);
  for (const result of results) {
    const next = session.next();
    if (next.status !== "action") throw new Error("reserved native action required");
    session.accept(next.action.action_id, { status: "observed", result });
  }
  return session;
}

it.each(["AP-42", "AP-73"])("derives %s from an actual M7 accepting binding and discovers approval outside the original native pool", async ticket => {
  await withFeedbackSource(ticket, async ({ client, session, native }) => {
    const port = client.sourceSemanticsPort!;
    const plain = await port.execute({ ...CONTEXT, request: { kind: "prepare_query", original_query: ORIGINAL,
      query_semantics: query(), budget: CHILD } });
    if (plain.kind !== "prepare_query") throw new Error("native preparation required");
    expect(plain.access?.source_candidates.map(row => row.source_id)).not.toContain("z");
    expect(native.result?.binding_results?.[0]?.bindings.actor).toMatchObject({ node_id: "rM7" });
    expect(native.result?.binding_results?.[0]?.returned.ticket).toMatchObject({ node_id: "rTicket" });
    expect(native.interpretation?.mentions.find(row => row.id === "mTicket")).toMatchObject({ text: ticket,
      utf8_span: [8, 13], span_space: "source_utf8" });
    const trace = await executeSourceFeedback({ session, context: CONTEXT, port, timeoutMs: 20_000 });
    expect(trace.status).toBe("complete");
    expect(trace.exposures.map(row => row.result.kind)).toEqual(["prepare_source", "validate_source", "reason", "prepare_query"]);
    const reason = trace.exposures[2]!.result, discovery = trace.exposures[3]!.result;
    if (reason.kind !== "reason" || discovery.kind !== "prepare_query") throw new Error("binding and fresh discovery required");
    expect(reason.result?.conditional_computation_id).toBe(native.result?.conditional_computation_id);
    expect(discovery.access?.source_candidates.map(row => row.source_id)).toContain("z");
    expect(discovery.access?.pool_id).not.toBe(plain.access?.pool_id);
    expect(discovery.query_semantics_id).toBe(plain.query_semantics_id);
    expect(discovery.access?.source_candidates.find(row => row.source_id === "z")).toMatchObject({ complete: true });
    expect(trace.joint_assessment.status).toBe("not_lowered");
    const nativeWork = trace.exposures.reduce((sum, row) => sum + row.result.work.logical_work!, 0);
    expect(trace.accounting.logical_work).toBe(nativeWork);
    expect(trace.accounting.logical_memory_bytes).toBe(trace.exposures.reduce((sum, row) => sum + row.result.work.logical_memory_bytes, 0));
    expect(trace.accounting.reserved_work).toBe(0);

    const local = replay(session, trace.exposures.slice(0, 3).map(row => row.result));
    const next = local.next();
    if (next.status !== "action" || next.action.request.kind !== "prepare_query") throw new Error("fresh navigation required");
    expect(next.action.request.original_query).toBe(ORIGINAL);
    expect(next.action.request.access_hint).toBe(ticket);
    expect(next.action.request).not.toHaveProperty("source_handle");
    expect(next.action.request).not.toHaveProperty("continuation_handle");
    expect(next.action.parent_entitlement_id).toBe(session.parent_entitlement_id);

    const before = trace.exposures.slice(0, 2).map(row => row.result);
    const nonActionable = (changed: Reason) => {
      const control = replay(session, [...before, changed]);
      expect(control.next()).toEqual({ status: "stopped" });
      expect(control.finish().status).toBe("non_actionable");
    };
    const change = (mutate: (value: Reason) => void) => {
      const value = structuredClone(reason); mutate(value); nonActionable(value);
    };
    change(value => { Object.assign(value.context!, { lowering_version: "wrong-context" }); });
    change(value => { Object.assign(value.result!.source_target!, { source_version: "other-version" }); });
    change(value => { Object.assign(value.result!.source_target!, { root_id: "other-source" }); });
    change(value => { Object.assign(value.result!, { derivations: [] }); });
    change(value => { Object.assign(value.result!, { evidence_leaves: [] }); });
    change(value => { Object.assign(value.coverage, { payload: "truncated" }); });
    change(value => { Object.assign(value, { result: undefined,
      interpretation: undefined, query: undefined, semantic_correspondence: undefined, context: undefined,
      no_conclusion: [reason.result!.outcome, [reason.result!.source_interpretation_id!, reason.result!.query_semantics_id!,
        reason.result!.semantic_correspondence_id!, reason.result!.conditional_computation_id!]] }); });
    change(value => { Object.assign(value.result!.binding_results![0]!, { binding_id: "@binding:sha256:unresolved", bindings: {}, returned: {} }); });
    const rejected = await port.execute({ ...CONTEXT, request: { ...session.seed,
      query_semantics: { ...query(), producer_id: "unregistered-query-producer" } } });
    if (rejected.kind !== "reason") throw new Error("native reason expected");
    expect(rejected.result?.outcome.status).toBe("invalid");
    nonActionable(rejected);

    // Decoded accepting coordinates remain usable without optional attention or parsing the opaque binding ID.
    const absentAttention = structuredClone(reason);
    Object.assign(absentAttention.result!, { attention: undefined });
    expect(replay(session, [...before, absentAttention]).next().status).toBe("action");
    // Same semantic result under another opaque binding alias cannot manufacture more native work.
    const duplicate = structuredClone(reason), binding = duplicate.result!.binding_results![0]!;
    Object.assign(duplicate.result!, { binding_results: [binding, { ...binding, binding_id: "another-opaque-attempt" }] });
    const coalesced = replay(session, [...before, duplicate]);
    const pending = coalesced.next();
    if (pending.status !== "action") throw new Error("navigation required");
    expect(coalesced.next()).toEqual({ status: "in_flight" });
    expect(coalesced.accept(pending.action.action_id, { status: "observed", result: discovery })).toBe(true);
    expect(coalesced.accept(pending.action.action_id, { status: "observed", result: discovery })).toBe(false);
    expect(coalesced.next()).toEqual({ status: "stopped" });
    expect(coalesced.finish().exposures).toHaveLength(4);
    expect(coalesced.finish().accounting.logical_work).toBe(nativeWork);
  });
}, 60_000);
});

