import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
const entry = vi.hoisted(() => ({ observe: vi.fn(), phases: vi.fn(), library: vi.fn() }));
vi.mock("../../../runtime/recall-read-worker/source-semantic-library-recall.js", () => ({
  runSourceSemanticLibraryRecall: (...args: unknown[]) => entry.library(...args)
}));
// Inspect the split and phase ingress, before any native reader or worker runs.
vi.mock("../../../runtime/recall-read-worker/source-semantic-empty-population-budget.js", () => ({
  SourceSemanticUnionCompletion: class {
    constructor(parent: unknown, child: unknown) { entry.observe(parent, child); }
    metadata(value: unknown) { entry.phases(value); }
    preparationBase(value: unknown) { entry.phases(value); }
    release() {}
  }
}));
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); entry.observe.mockReset(); entry.phases.mockReset(); entry.library.mockReset(); });
afterAll(() => { isolation.restore(); });
import * as protocol from "@do-soul/alaya-protocol";
import { createSourceSemanticAccessPolicy } from "@do-soul/alaya-core";
import { sourcePhaseFixture } from "../../../../../../packages/protocol/src/__tests__/garden/source-semantic-canonical.test-support.js";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { runSourceSemanticWorker, type SourceSemanticRequestExecution } from "../../../runtime/recall-read-worker/source-semantic-reasoning.js";
import { observeSourceSemanticAccess } from "../../../runtime/recall-read-worker/source-semantic-candidate-access.js";
import type { RecallReadWorkerRuntime } from "../../../runtime/recall-read-worker/runtime.js";

const BUDGET = { schema_version: 1 as const, work_units: 200000, memory_bytes: 300000,
  page_budget: 100000, finalization_reserve: 10000, min_envelope: 10 };
const ORIGINAL = "Why delayed", HINT = "x".repeat(1024), STOP = new Error("observation child inspected");
function fixture() {
  const phase = sourcePhaseFixture().preparation, { supplemental, ...receipt } = phase;
  const prepared = { receipt, vector: { status: "unavailable" as const, reason: "unit_test_no_model" },
    supplemental: { receipt: supplemental[0]!, vector: { status: "unavailable" as const, reason: "unit_test_no_model" } } };
  const runtime = { database: { connection: { inTransaction: true,
    pragma: () => 1, prepare: () => ({ get: () => ({ n: 1 }) }) } } } as unknown as RecallReadWorkerRuntime;
  const payload = { workspace_id: "workspace-1", as_of: "2026-09-18T00:00:00.000Z",
    authorized_scopes: { mode: "named" as const, scopes: ["project"] },
    prepared_query: prepared, request: { kind: "prepare_query" as const, original_query: ORIGINAL, access_hint: HINT, budget: BUDGET } };
  return { phase, runtime, payload };
}

it("charges catalog position ownership before the child split and captures execution once", () => {
  const { phase, runtime, payload } = fixture();
  // The unchanged public owners establish the old prefix, including its real
  // ownership entry, one execution tuple, buffer references and query features.
  const expected = new SourceSemanticReadBudget(BUDGET);
  expected.preparation = protocol.packSourceSemanticQueryPreparation(protocol.captureSourceSemanticQueryPreparation(phase, expected), expected);
  protocol.sourceSemanticExecution(expected.preparation, undefined, expected);
  expected.charge(1, 80, "worker query vector buffer references");
  expected.retain(undefined, "query semantics admission");
  expected.charge(1, 64, "source catalog position map");
  createSourceSemanticAccessPolicy(ORIGINAL, undefined, "query-conditioned-v1", expected, HINT);
  const ingress = vi.spyOn(protocol, "capturePackSourceSemanticPreparationForRequest");
  const charges = vi.spyOn(protocol.SourceSemanticResourceLedger.prototype, "charge");
  let executionOf: SourceSemanticRequestExecution | undefined, capture: protocol.SourceSemanticQueryPreparation | undefined;
  entry.observe.mockImplementation((parent: SourceSemanticReadBudget, child: SourceSemanticReadBudget) => {
    expect(parent.spentBytes).toBe(expected.spentBytes); expect(parent.spentWork).toBe(expected.spentWork);
    expect(child.remaining()).toEqual({ work_units: Math.floor(expected.work / 2), memory_bytes: Math.floor(expected.bytes / 2) });
    expect(charges.mock.calls.filter(([, , phase]) => phase === "source phase execution tuple allocation")).toEqual([[1, 24, "source phase execution tuple allocation"]]);
    expect(charges.mock.calls.filter(([, , phase]) => phase === "source phase capture ownership")).toEqual([]);
    expect(charges.mock.calls.filter(([, , phase]) => phase === "source phase request ownership bridge"))
      .toEqual([[1, 16, "source phase request ownership bridge"]]);
    executionOf = ingress.mock.calls[0]![2] as SourceSemanticRequestExecution;
    capture = executionOf(parent.preparation!);
    expect(capture).toEqual(phase); expect(capture).not.toBe(phase); expect(Object.isFrozen(capture)).toBe(true);
    const before = parent.spentBytes, execution = executionOf();
    expect(executionOf()).toBe(execution); expect(parent.spentBytes).toBe(before);
  });
  entry.phases.mockImplementation(() => {
    expect(charges.mock.calls.filter(([, , phase]) => phase === "source phase request ownership bridge"))
      .toEqual([[1, 16, "source phase request ownership bridge"]]);
    expect(charges.mock.calls.filter(([, , phase]) => phase === "source phase capture ownership")).toEqual([]);
    throw STOP;
  });
  expect(() => runSourceSemanticWorker(runtime, payload)).toThrow(STOP);
  expect(entry.observe).toHaveBeenCalledTimes(1);
  expect(executionOf!(ingress.mock.results[0]!.value)).toBeUndefined();
  expect(Object.isFrozen(phase)).toBe(false);
});

it.each(["ordinary preparation", "direct observation"] as const)
("preserves the nonfused split after catalog ownership and pays capture ownership only after it for %s", path => {
  const { runtime, payload: preparedPayload } = fixture();
  const payload = { ...preparedPayload, prepared_query: undefined,
    request: { kind: "prepare_query" as const, original_query: ORIGINAL, budget: BUDGET } };
  const expected = new SourceSemanticReadBudget(BUDGET);
  if (path !== "direct observation") expected.retain(undefined, "query semantics admission");
  expected.charge(1, 64, "source catalog position map");
  createSourceSemanticAccessPolicy(ORIGINAL, undefined, "query-conditioned-v1", expected);
  const split = { work_units: Math.floor(expected.work / 2), memory_bytes: Math.floor(expected.bytes / 2) };
  const prefix = { work: expected.spentWork, bytes: expected.spentBytes };
  protocol.packSourceSemanticQueryPreparation(protocol.captureSourceSemanticQueryPreparation(
    protocol.unavailableSourceQueryPreparation("preparation_scope_unavailable", "unavailable"), expected), expected);
  protocol.packSourceSemanticAcquisition(protocol.sourceSemanticAcquisitionNotRun("observation_allowance"), expected);
  const charges = vi.spyOn(protocol.SourceSemanticResourceLedger.prototype, "charge");
  let observedParent: SourceSemanticReadBudget, observedChild: SourceSemanticReadBudget;
  entry.observe.mockImplementation((parent: SourceSemanticReadBudget, child: SourceSemanticReadBudget) => {
    observedParent = parent; observedChild = child;
    expect(parent.spentWork).toBe(prefix.work); expect(parent.spentBytes).toBe(prefix.bytes);
    expect(child.remaining()).toEqual(split);
    expect(charges.mock.calls.filter(([, , phase]) => phase === "source phase capture ownership")).toEqual([]);
  });
  entry.phases.mockImplementation(() => {
    expect(observedParent.spentWork).toBe(expected.spentWork); expect(observedParent.spentBytes).toBe(expected.spentBytes);
    expect(observedChild.remaining()).toEqual(split);
    expect(charges.mock.calls.filter(([, , phase]) => phase === "source phase capture ownership"))
      .toEqual([[1, 16, "source phase capture ownership"]]);
    expect(charges.mock.calls.filter(([, , phase]) => phase === "source phase request ownership bridge")).toEqual([]);
    throw STOP;
  });
  const run = () => {
    if (path === "ordinary preparation") return runSourceSemanticWorker(runtime, payload);
    return observeSourceSemanticAccess(runtime, payload, ["project"], new SourceSemanticReadBudget(BUDGET),
      ORIGINAL, undefined, "query-conditioned-v1", BUDGET);
  };
  expect(run).toThrow(STOP);
  expect(entry.observe).toHaveBeenCalledTimes(1); expect(entry.phases).toHaveBeenCalledTimes(1);
});

it("routes library recall to its field owner without a preparation-observer split", () => {
  const { runtime, payload } = fixture();
  const request = { kind: "recall" as const, original_query: ORIGINAL, budget: BUDGET,
    accepts_unreviewed_conditional_results: true as const, output_byte_limit: 10000 };
  const sent = { ...payload, prepared_query: undefined, request };
  entry.library.mockImplementation((receivedRuntime, receivedPayload, authorized, meter: SourceSemanticReadBudget) => {
    expect(receivedRuntime).toBe(runtime);
    expect(receivedPayload).toBe(sent);
    expect(authorized).toEqual(["project"]);
    expect(meter.remaining()).toEqual({ work_units: BUDGET.work_units, memory_bytes: BUDGET.memory_bytes });
    expect(meter.preparation).toBeUndefined();
    expect(meter.acquisition).toBeUndefined();
    throw STOP;
  });
  expect(() => runSourceSemanticWorker(runtime, sent)).toThrow(STOP);
  expect(entry.library).toHaveBeenCalledOnce();
  expect(entry.observe).not.toHaveBeenCalled();
  expect(entry.phases).not.toHaveBeenCalled();
});

it("does not transfer ownership for a publicly captured compact preparation even with a request execution owner", () => {
  const { phase, runtime, payload } = fixture(), expected = new SourceSemanticReadBudget(BUDGET);
  expected.preparation = protocol.packSourceSemanticQueryPreparation(protocol.captureSourceSemanticQueryPreparation(phase, expected), expected);
  protocol.sourceSemanticExecution(expected.preparation, undefined, expected);
  expected.charge(1, 80, "worker query vector buffer references");
  expected.retain(undefined, "query semantics admission");
  expected.charge(1, 64, "source catalog position map");
  createSourceSemanticAccessPolicy(ORIGINAL, undefined, "query-conditioned-v1", expected, HINT);
  // Substitute the real public ingress, which pays CAPTURED ownership but never
  // hands an omitted-charge capture to the transaction's actual execution owner.
  vi.spyOn(protocol, "capturePackSourceSemanticPreparationForRequest").mockImplementation((value, meter) =>
    protocol.packSourceSemanticQueryPreparation(protocol.captureSourceSemanticQueryPreparation(value, meter), meter));
  const charges = vi.spyOn(protocol.SourceSemanticResourceLedger.prototype, "charge");
  entry.observe.mockImplementation((parent: SourceSemanticReadBudget, child: SourceSemanticReadBudget) => {
    expect(parent.preparation).toEqual(expected.preparation);
    expect(parent.spentWork).toBe(expected.spentWork); expect(parent.spentBytes).toBe(expected.spentBytes);
    expect(child.remaining()).toEqual({ work_units: Math.floor(expected.work / 2), memory_bytes: Math.floor(expected.bytes / 2) });
  });
  entry.phases.mockImplementation(() => {
    expect(charges.mock.calls.filter(([, , phase]) => phase === "source phase capture ownership"))
      .toEqual([[1, 16, "source phase capture ownership"]]);
    expect(charges.mock.calls.filter(([, , phase]) => phase === "source phase request ownership bridge")).toEqual([]);
    throw STOP;
  });
  expect(() => runSourceSemanticWorker(runtime, payload)).toThrow(STOP);
  expect(entry.observe).toHaveBeenCalledTimes(1); expect(entry.phases).toHaveBeenCalledTimes(1);
});

it("keeps compact failure evidence without reconstructing an execution tuple after exhaustion", () => {
  const { runtime, payload } = fixture(), ingress = vi.spyOn(protocol, "capturePackSourceSemanticPreparationForRequest");
  const charges = vi.spyOn(protocol.SourceSemanticResourceLedger.prototype, "charge");
  let execution: protocol.SourceSemanticExecution | undefined;
  entry.observe.mockImplementation((parent: SourceSemanticReadBudget) => {
    const executionOf = ingress.mock.calls[0]![2] as SourceSemanticRequestExecution;
    execution = executionOf();
    parent.charge(parent.work, parent.bytes, "later observation refusal");
    throw new protocol.SourceSemanticResourceExhausted("observation");
  });
  const result = runSourceSemanticWorker(runtime, payload);
  expect(result.kind).toBe("prepare_query");
  if (result.kind !== "prepare_query") throw new Error("query result expected");
  expect(result.outcome).toEqual({ status: "resource_exhausted" });
  expect(result.execution).toEqual(execution);
  expect(Array.isArray(result.execution)).toBe(true);
  expect(result.work.logical_memory_bytes).toBe(300000);
  expect(charges.mock.calls.filter(([, , phase]) => phase === "source phase execution tuple allocation")).toHaveLength(1);
  const executionOf = ingress.mock.calls[0]![2] as SourceSemanticRequestExecution;
  expect(executionOf(ingress.mock.results[0]!.value)).toBeUndefined();
});

it("discards a capture when the concrete preparation reference changes", () => {
  const { runtime, payload } = fixture(), ingress = vi.spyOn(protocol, "capturePackSourceSemanticPreparationForRequest");
  entry.observe.mockImplementation((parent: SourceSemanticReadBudget) => {
    const executionOf = ingress.mock.calls[0]![2] as SourceSemanticRequestExecution, before = parent.preparation!;
    expect(executionOf(before)).toBeDefined();
    parent.preparation = structuredClone(before);
    expect(executionOf(parent.preparation)).toBeUndefined();
    const execution = executionOf();
    expect(execution).not.toBe("native_reasoning_only");
    expect(executionOf(before)).toBeUndefined();
    expect(executionOf(parent.preparation)).toBeUndefined();
    throw STOP;
  });
  expect(() => runSourceSemanticWorker(runtime, payload)).toThrow(STOP);
});
