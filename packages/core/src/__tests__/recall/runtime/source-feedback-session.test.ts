import { expect, it } from "vitest";
import { captureSourceFeedbackTerminalCause, createSourceFeedbackSession, type SourceFeedbackSessionInput } from "../../../recall/runtime/source-feedback-session.js";

const child = { schema_version: 1 as const, work_units: 100_000, memory_bytes: 1_000_000,
  page_budget: 100, finalization_reserve: 1000, min_envelope: 10 };
const digest = `sha256:${"a".repeat(64)}`;
function input(): SourceFeedbackSessionInput {
  return { request_id: "request", parent_entitlement_id: "entitlement", workspace_id: "ws", scope_identity: "principal/project",
    original_query: "Which ticket does M7 use?", as_of: "2026-09-18T00:00:00.000Z", source_id: "M7",
    source_target: { kind: "source_evidence", workspace_id: "ws", root_kind: "source_record", root_id: "record",
      source_version: "1", content_digest: digest, evidence_object_id: null },
    seed: { kind: "reason", original_query: "Which ticket does M7 use?", source_interpretation_id: digest,
      accepts_unreviewed_conditional_results: true, budget: child, output_byte_limit: 1_000_000 },
    budget: { ...child, work_units: 400_000, memory_bytes: 4_000_000 }, action_budget: child };
}
const measured = { native_work: 75, index_work: 50, logical_work: 200, native_bytes: 100,
  logical_memory_bytes: 800, rss_bytes: 3000 };

it("captures the root, reserves before dispatch and never lets copied actions reset or rewrite allowance", () => {
  const root = input(), session = createSourceFeedbackSession(root);
  Object.assign(root, { parent_entitlement_id: "alias", original_query: "changed" });
  const next = session.next();
  if (next.status !== "action") throw new Error("action required");
  expect(next.action.parent_entitlement_id).toBe("entitlement");
  expect(session.finish().accounting).toMatchObject({ logical_work: 0, reserved_work: 100_000, reserved_memory_bytes: 1_000_000 });
  Object.assign(next.action.request.budget, { work_units: 1 });
  expect(session.next()).toEqual({ status: "in_flight" });
  expect(session.accept("alias", { status: "failed", work: measured })).toBe(false);
  expect(session.accept(next.action.action_id, { status: "failed", work: measured })).toBe(true);
  expect(session.finish().accounting).toEqual({ logical_work: 200, logical_memory_bytes: 800,
    reserved_work: 0, reserved_memory_bytes: 0, measurement: "logical_not_native_cpu" });
  expect(session.accept(next.action.action_id, { status: "failed", work: measured })).toBe(false);
  expect(session.next()).toEqual({ status: "stopped" });
  expect(session.finish().status).toBe("failed");
});

it.each(["waiting", "preparing", "dispatched", "unknown"] as const)("retains the full reservation after %s uncertainty and settles once", phase => {
  const session = createSourceFeedbackSession(input()), next = session.next();
  if (next.status !== "action") throw new Error("action required");
  session.accept(next.action.action_id, { status: "unknown", phase });
  expect(session.finish()).toMatchObject({ status: "unknown", accounting: { logical_work: 0, logical_memory_bytes: 0,
    reserved_work: child.work_units, reserved_memory_bytes: child.memory_bytes } });
  expect(session.accept(next.action.action_id, { status: "failed", work: measured })).toBe(false);
  expect(session.next()).toEqual({ status: "stopped" });
});

it("does not turn unmeasured domain failure or cancellation into free zero work", () => {
  for (const settlement of [{ status: "failed" }, { status: "cancelled" }] as const) {
    const session = createSourceFeedbackSession(input()), next = session.next();
    if (next.status !== "action") throw new Error("action required");
    session.accept(next.action.action_id, settlement);
    expect(session.finish().accounting.reserved_work).toBe(child.work_units);
    expect(session.finish().status).toBe(settlement.status === "failed" ? "unknown" : "cancelled");
  }
});

it("stops without dispatch when the parent cannot fund a bounded child and cannot be reopened through next", () => {
  const root = input(), session = createSourceFeedbackSession({ ...root, budget: { ...root.budget, work_units: child.work_units - 1 } });
  expect(session.next()).toEqual({ status: "stopped" });
  expect(session.next()).toEqual({ status: "stopped" });
  expect(session.finish()).toMatchObject({ status: "budget_exhausted", accounting: { reserved_work: 0 }, exposures: [] });
});

it("cancels before reservation without inventing an attempt", () => {
  const session = createSourceFeedbackSession(input());
  session.stop("cancelled");
  expect(session.next()).toEqual({ status: "stopped" });
  expect(session.finish()).toMatchObject({ status: "cancelled", exposures: [], settlements: [], accounting: { reserved_work: 0 } });
});

it("keeps terminal cause separate from unknown execution and prevents late settlement from overwriting it", () => {
  const session = createSourceFeedbackSession(input()), next = session.next();
  if (next.status !== "action") throw new Error("action required");
  const cause = { kind: "caller_abort" as const, name: "Error", message: "caller revoked request", code: "ABORT_ERR",
    reason: { cancellation_id: "cancelled-request" } };
  session.accept(next.action.action_id, { status: "unknown", phase: "dispatched", terminal_cause: cause });
  Object.assign(cause.reason, { cancellation_id: "mutated-outside-session" });
  expect(session.finish()).toMatchObject({ status: "unknown", terminal_cause: { kind: "caller_abort", code: "ABORT_ERR",
    reason: { cancellation_id: "cancelled-request" } }, accounting: { reserved_work: child.work_units } });
  expect(session.accept(next.action.action_id, { status: "failed", work: measured,
    terminal_cause: { kind: "execution_error", reason: "late failure" } })).toBe(false);
  session.stop("cancelled", { kind: "caller_abort", reason: "later alias" });
  expect(session.finish().terminal_cause?.reason).toEqual({ cancellation_id: "cancelled-request" });
});

it("does not let uncloneable abort reasons throw away unknown occupancy or cancellation", () => {
  const reserved = createSourceFeedbackSession(input()), next = reserved.next();
  if (next.status !== "action") throw new Error("action required");
  const token = { id: "abort", mark: Symbol("secret"), run() { return this.id; } };
  const cause = captureSourceFeedbackTerminalCause(token, "caller_abort");
  token.id = "mutated";
  expect(reserved.accept(next.action.action_id, { status: "unknown", phase: "dispatched", terminal_cause: cause })).toBe(true);
  expect(reserved.finish()).toMatchObject({ status: "unknown",
    terminal_cause: { kind: "caller_abort", diagnostic: { status: "unavailable" }, reason: { status: "unavailable" } },
    accounting: { reserved_work: child.work_units, reserved_memory_bytes: child.memory_bytes } });
  const idle = createSourceFeedbackSession(input());
  idle.stop("cancelled", captureSourceFeedbackTerminalCause(() => "secret", "caller_abort"));
  expect(idle.finish()).toMatchObject({ status: "cancelled",
    terminal_cause: { kind: "caller_abort", diagnostic: { status: "unavailable" }, reason: { status: "unavailable" } },
    accounting: { reserved_work: 0 } });
  const nested = createSourceFeedbackSession(input()), action = nested.next();
  if (action.status !== "action") throw new Error("action required");
  const failure = new Error("native closed");
  Object.assign(failure, { code: "CONFLICT", subCode: "PORT_UNAVAILABLE", cause: { hidden() { return "no"; } } });
  expect(nested.accept(action.action.action_id, { status: "unknown", phase: "unknown",
    terminal_cause: captureSourceFeedbackTerminalCause(failure, "execution_error") })).toBe(true);
  expect(nested.finish()).toMatchObject({ status: "unknown", terminal_cause: {
    kind: "execution_error", name: "Error", message: "native closed", code: "CONFLICT", subCode: "PORT_UNAVAILABLE",
    diagnostic: { status: "partial" }, reason: { name: "Error", message: "native closed", code: "CONFLICT",
      subCode: "PORT_UNAVAILABLE", cause: { status: "unavailable" } } },
    accounting: { reserved_work: child.work_units } });
});

it("does not let throwing abort-reason accessors escape capture or unknown occupancy", () => {
  const reserved = createSourceFeedbackSession(input()), next = reserved.next();
  if (next.status !== "action") throw new Error("action required");
  const reason = new Error("caller revoked request");
  Object.assign(reason, { code: "ABORT_ERR", subCode: "CONCURRENT_MODIFICATION" });
  Object.defineProperty(reason, "cause", { configurable: true, get() { throw new Error("cause accessor"); } });
  Object.defineProperty(reason, "stack", { configurable: true, get() { throw new Error("stack accessor"); } });
  let cause!: ReturnType<typeof captureSourceFeedbackTerminalCause>;
  expect(() => { cause = captureSourceFeedbackTerminalCause(reason, "caller_abort"); }).not.toThrow();
  expect(() => structuredClone(cause)).not.toThrow();
  expect(cause).toMatchObject({ kind: "caller_abort", name: "Error", message: "caller revoked request",
    code: "ABORT_ERR", subCode: "CONCURRENT_MODIFICATION", diagnostic: { status: "partial" } });
  expect(reserved.accept(next.action.action_id, { status: "unknown", phase: "dispatched", terminal_cause: cause })).toBe(true);
  expect(reserved.finish()).toMatchObject({ status: "unknown",
    terminal_cause: { kind: "caller_abort", message: "caller revoked request", code: "ABORT_ERR", diagnostic: { status: "partial" } },
    accounting: { reserved_work: child.work_units, reserved_memory_bytes: child.memory_bytes } });
});

it("reads enumerable code and cause once so a throwing reread cannot drop captured diagnostics", () => {
  let codeReads = 0, causeReads = 0, nestedCodeReads = 0;
  const inner = new Error("engine closed");
  Object.defineProperty(inner, "code", {
    configurable: true, enumerable: true,
    get() { nestedCodeReads += 1; if (nestedCodeReads > 1) throw new Error("nested code reread"); return "NOT_FOUND"; }
  });
  const outer = new Error("caller revoked request");
  Object.assign(outer, { extra: { id: "abort" } });
  Object.defineProperty(outer, "code", {
    configurable: true, enumerable: true,
    get() { codeReads += 1; if (codeReads > 1) throw new Error("code reread"); return "ABORT_ERR"; }
  });
  Object.defineProperty(outer, "cause", {
    configurable: true, enumerable: true,
    get() { causeReads += 1; if (causeReads > 1) throw new Error("cause reread"); return inner; }
  });
  const cause = captureSourceFeedbackTerminalCause(outer, "caller_abort");
  expect(codeReads).toBe(1);
  expect(causeReads).toBe(1);
  expect(nestedCodeReads).toBe(1);
  expect(() => structuredClone(cause)).not.toThrow();
  expect(cause).toMatchObject({ kind: "caller_abort", name: "Error", message: "caller revoked request", code: "ABORT_ERR",
    reason: { name: "Error", message: "caller revoked request", code: "ABORT_ERR", extra: { id: "abort" },
      cause: { name: "Error", message: "engine closed", code: "NOT_FOUND" } } });
  expect(cause).not.toHaveProperty("diagnostic");
});

it("isolates cloneable nested error causes from later caller mutation", () => {
  const session = createSourceFeedbackSession(input()), next = session.next();
  if (next.status !== "action") throw new Error("action required");
  const inner = new Error("engine closed");
  Object.assign(inner, { code: "NOT_FOUND", subCode: "PORT_UNAVAILABLE" });
  const outer = new Error("caller revoked request", { cause: inner });
  Object.assign(outer, { code: "ABORT_ERR", subCode: "CONCURRENT_MODIFICATION" });
  const cause = captureSourceFeedbackTerminalCause(outer, "caller_abort");
  inner.message = "mutated-inner";
  outer.message = "mutated-outer";
  Object.assign(outer, { code: "MUTATED" });
  expect(cause).toMatchObject({ kind: "caller_abort", name: "Error", message: "caller revoked request", code: "ABORT_ERR",
    subCode: "CONCURRENT_MODIFICATION", reason: { name: "Error", message: "caller revoked request", code: "ABORT_ERR",
      cause: { name: "Error", message: "engine closed", code: "NOT_FOUND", subCode: "PORT_UNAVAILABLE" } } });
  expect(cause).not.toHaveProperty("diagnostic");
  expect(session.accept(next.action.action_id, { status: "unknown", phase: "dispatched", terminal_cause: cause })).toBe(true);
  expect(session.finish()).toMatchObject({ status: "unknown", terminal_cause: { kind: "caller_abort", code: "ABORT_ERR",
    reason: { message: "caller revoked request", cause: { message: "engine closed", code: "NOT_FOUND" } } },
    accounting: { reserved_work: child.work_units } });
  expect(session.finish().terminal_cause).not.toHaveProperty("diagnostic");
});
