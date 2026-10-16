import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => { isolation.restore(); });
import { SourceSemanticResourceExhausted, SourceSemanticResourceLedger } from "@do-soul/alaya-protocol";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { SourceSemanticUnionCompletion } from "../../../runtime/recall-read-worker/source-semantic-empty-population-budget.js";

const AMPLE = { work_units: 1_000_000, memory_bytes: 1_000_000 };

function phaseMetadata() {
  return {
    preparation: {
      status: "unavailable",
      reason: "preparation_scope_unavailable",
      navigation_digest: null,
      selected: null,
      method: "not_run",
      submitted_inputs: 0,
      token_count: null,
      external_api_attempts: 0,
      binding_work: "not_run",
      execution_work: "not_run",
      elapsed_ms: null,
      notes: "orchid irrigation channel notes. ".repeat(40),
      windows: [null, { start: 0, end: 4096, digest: `sha256:${"a".repeat(64)}` }],
      limitations: [null, "partial index coverage", ["nested", null, "x".repeat(256)], {
        detail: "x".repeat(128), extra: null, terms: ["unicode61", null, "trigram"]
      }]
    }
  };
}

function quote(completion: SourceSemanticUnionCompletion, value: object) {
  return completion.metadata(value as Parameters<SourceSemanticUnionCompletion["metadata"]>[0]);
}

function subject(allowance = AMPLE) {
  const parent = new SourceSemanticReadBudget(allowance);
  const child = new SourceSemanticReadBudget(allowance);
  return { parent, child, completion: new SourceSemanticUnionCompletion(parent, child, () => ({ work_units: 0, memory_bytes: 0 })) };
}

function held(budget: SourceSemanticReadBudget) {
  const outstanding = budget.outstandingAllowance();
  return { work_units: outstanding.work_units - budget.spentWork, memory_bytes: outstanding.memory_bytes - budget.spentBytes };
}

function fiveCopyHold(value: object) {
  return SourceSemanticResourceLedger.measureRetain([value, value, value, value, value], AMPLE);
}

function unfrozen(value: ReturnType<typeof phaseMetadata>) {
  expect(Object.isFrozen(value)).toBe(false);
  expect(Object.isFrozen(value.preparation)).toBe(false);
  expect(Object.isFrozen(value.preparation.windows)).toBe(false);
  expect(Object.isFrozen(value.preparation.limitations)).toBe(false);
}

function nativeIdle(parent: SourceSemanticReadBudget, child: SourceSemanticReadBudget) {
  expect([parent.nativeWork, parent.nativeBytes, parent.indexWork, child.nativeWork, child.nativeBytes, child.indexWork])
    .toEqual([0, 0, 0, 0, 0, 0]);
}

function markerVisits(calls: readonly unknown[][], marker: readonly unknown[], phases: readonly string[]) {
  return calls.filter(([work, bytes, phase]) => work === marker[0] && bytes === marker[1] && phases.includes(phase as string)).length;
}

it("holds a private five-copy quote from one capture while charging guard, copy and bookkeeping", () => {
  const value = phaseMetadata();
  const snapshot = JSON.parse(JSON.stringify(value));
  const independentHold = fiveCopyHold(value);
  const guard = SourceSemanticResourceLedger.measureRetain(value, AMPLE);
  const charge = vi.spyOn(SourceSemanticReadBudget.prototype, "charge");
  const fivePlanner = new SourceSemanticReadBudget(AMPLE);
  const fiveStart = charge.mock.calls.length;
  expect(SourceSemanticResourceLedger.measureRetain([value, value, value, value, value], fivePlanner.remaining(), fivePlanner))
    .toEqual(independentHold);
  const fiveCalls = charge.mock.calls.slice(fiveStart);
  const onePlanner = new SourceSemanticReadBudget(AMPLE);
  const oneStart = charge.mock.calls.length;
  SourceSemanticResourceLedger.measureRetain(value, onePlanner.remaining(), onePlanner);
  const oneWalk = charge.mock.calls.slice(oneStart);
  const marker = oneWalk.reduce((best, call) => (call[1] as number) > (best[1] as number) ? call : best);
  const { parent, child, completion } = subject();
  const quoteStart = charge.mock.calls.length;
  expect(quote(completion, value)).toBeUndefined();
  const quoteCalls = charge.mock.calls.slice(quoteStart);
  const phases = quoteCalls.map(call => call[2]);
  expect(held(parent)).toEqual(independentHold);
  expect(phases).toContain("source union metadata capture bound");
  expect(phases).toContain("source union immutable metadata capture");
  expect(phases).toContain("source union metadata quote bookkeeping");
  const capture = quoteCalls.find(call => call[2] === "source union immutable metadata capture")!;
  expect(capture.slice(0, 2)).toEqual([guard.work_units, guard.memory_bytes]);
  expect(markerVisits(fiveCalls, marker, ["retained value measurement work"])).toBe(5);
  expect(markerVisits(quoteCalls, marker, ["source union metadata capture bound", "retained value measurement work"])).toBe(2);
  expect(JSON.parse(JSON.stringify(value))).toEqual(snapshot);
  unfrozen(value);
  value.preparation.reason = "mutated after quote";
  value.preparation.limitations.push("post-quote");
  expect(held(parent)).toEqual(independentHold);
  nativeIdle(parent, child);
});

it("releases held completion allowance without refunding spent planning, and repeated release is harmless", () => {
  const value = phaseMetadata();
  const independentHold = fiveCopyHold(value);
  const { parent, child, completion } = subject();
  quote(completion, value);
  const spent = { work_units: parent.spentWork, memory_bytes: parent.spentBytes };
  const remaining = parent.remaining();
  expect(held(parent)).toEqual(independentHold);
  expect(spent.work_units).toBeGreaterThan(0);
  completion.release();
  expect(parent.spentWork).toBe(spent.work_units);
  expect(parent.spentBytes).toBe(spent.memory_bytes);
  expect(held(parent)).toEqual({ work_units: 0, memory_bytes: 0 });
  expect(parent.remaining()).toEqual({
    work_units: remaining.work_units + independentHold.work_units,
    memory_bytes: remaining.memory_bytes + independentHold.memory_bytes
  });
  completion.release();
  expect(parent.spentWork).toBe(spent.work_units);
  expect(parent.spentBytes).toBe(spent.memory_bytes);
  expect(held(parent)).toEqual({ work_units: 0, memory_bytes: 0 });
  expect(parent.remaining()).toEqual({
    work_units: remaining.work_units + independentHold.work_units,
    memory_bytes: remaining.memory_bytes + independentHold.memory_bytes
  });
  nativeIdle(parent, child);
});

it("fails before capture when guarded allowance is insufficient and charges partial planning without a leaked hold", () => {
  const value = phaseMetadata();
  const snapshot = JSON.parse(JSON.stringify(value));
  const guard = SourceSemanticResourceLedger.measureRetain(value, AMPLE);
  const charge = vi.spyOn(SourceSemanticReadBudget.prototype, "charge");
  const short = subject({ work_units: guard.work_units - 1, memory_bytes: AMPLE.memory_bytes });
  const beforeCapture = charge.mock.calls.length;
  expect(() => quote(short.completion, value)).toThrow(SourceSemanticResourceExhausted);
  expect(charge.mock.calls.slice(beforeCapture).some(call => call[2] === "source union immutable metadata capture")).toBe(false);
  expect(JSON.parse(JSON.stringify(value))).toEqual(snapshot);
  unfrozen(value);
  expect(held(short.parent)).toEqual({ work_units: 0, memory_bytes: 0 });
  expect(short.parent.spentWork).toBeGreaterThan(0);
  expect(short.parent.spentWork).toBeLessThanOrEqual(guard.work_units - 1);
  expect(short.parent.spentWork + short.parent.work).toBe(guard.work_units - 1);
  expect(short.parent.spentBytes + short.parent.bytes).toBe(AMPLE.memory_bytes);
  nativeIdle(short.parent, short.child);

  const mid = subject({ work_units: 2 * guard.work_units + 1, memory_bytes: AMPLE.memory_bytes });
  const afterCapture = charge.mock.calls.length;
  expect(() => quote(mid.completion, value)).toThrow(SourceSemanticResourceExhausted);
  expect(charge.mock.calls.slice(afterCapture).some(call => call[2] === "source union immutable metadata capture")).toBe(true);
  expect(JSON.parse(JSON.stringify(value))).toEqual(snapshot);
  unfrozen(value);
  expect(held(mid.parent)).toEqual({ work_units: 0, memory_bytes: 0 });
  expect(mid.parent.spentWork).toBeGreaterThan(0);
  expect(mid.parent.spentWork + mid.parent.work).toBe(2 * guard.work_units + 1);
  nativeIdle(mid.parent, mid.child);
});

it("keeps the observation child remainder outside the held completion allowance", () => {
  const value = phaseMetadata();
  const independentHold = fiveCopyHold(value);
  const { parent, child, completion } = subject();
  expect(child.remaining()).toEqual(AMPLE);
  quote(completion, value);
  expect(held(parent)).toEqual(independentHold);
  expect(child.remaining()).toEqual(parent.remaining());
  expect(child.work).toBeLessThan(AMPLE.work_units);
  expect(child.bytes).toBeLessThan(AMPLE.memory_bytes);
  expect(child.work).toBe(parent.work);
  expect(parent.spentWork + parent.work + independentHold.work_units).toBe(AMPLE.work_units);
  expect(parent.spentBytes + parent.bytes + independentHold.memory_bytes).toBe(AMPLE.memory_bytes);
  nativeIdle(parent, child);

  const bounded = new SourceSemanticReadBudget({ work_units: 12, memory_bytes: 12 });
  const wide = new SourceSemanticReadBudget(AMPLE);
  quote(new SourceSemanticUnionCompletion(wide, bounded, () => ({ work_units: 0, memory_bytes: 0 })), value);
  expect(bounded.remaining()).toEqual({ work_units: 12, memory_bytes: 12 });
  expect(held(wide).work_units).toBeGreaterThan(bounded.work);
  nativeIdle(wide, bounded);
});
