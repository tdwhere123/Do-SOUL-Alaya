import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
// Source-only adapter controls: do not require a newly emitted Core barrel or Worker artifact.
vi.mock("@do-soul/alaya-core", async original => ({
  ...await original<typeof import("@do-soul/alaya-core")>(),
  ...await import("../../../../../../packages/core/src/recall/runtime/source-feedback-session.js")
}));
afterEach(() => { expect(isolation.violations).toEqual([]); vi.useRealTimers(); vi.restoreAllMocks(); });
afterAll(() => { isolation.restore(); });
import { CoreError, fieldContractSha256 } from "@do-soul/alaya-core";
import { buildSourceReferenceCatalog, canonicalJson, encodeSourceDisclosure, SourceSemanticWorkerResultSchema,
  UNKNOWN_UTTERANCE_ATTRIBUTION, type SourceSemanticWorkerResult } from "@do-soul/alaya-protocol";
import type { SourceFeedbackSessionInput } from "../../../../../../packages/core/src/recall/runtime/source-feedback-session.js";
import { RecallReadWorkerDeadline } from "../../../runtime/recall/recall-read-worker-deadline.js";
import { executeSourceFeedback } from "../../../runtime/recall/source-feedback-execution.js";
import type { SourceSemanticsExecutionPort } from "../../../runtime/recall/recall-read-worker-client.js";

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
