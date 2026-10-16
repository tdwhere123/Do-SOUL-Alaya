import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => { isolation.restore(); });
import { SourceSemanticResourceExhausted, SourceSemanticResourceLedger,
  captureSourceSemanticQueryPreparation, packSourceSemanticQueryPreparation,
  unavailableSourceQueryPreparation } from "@do-soul/alaya-protocol";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { SourceSemanticUnionCompletion } from "../../../runtime/recall-read-worker/source-semantic-empty-population-budget.js";

const AMPLE = { work_units: 1_000_000, memory_bytes: 1_000_000 };

function packedPreparation(meter?: SourceSemanticReadBudget) {
  return packSourceSemanticQueryPreparation(captureSourceSemanticQueryPreparation(
    unavailableSourceQueryPreparation("orchid irrigation channel notes. ".repeat(40), "unavailable")), meter);
}

function phaseMetadata() {
  return JSON.parse(JSON.stringify({ preparation: packedPreparation() })) as { preparation: ReturnType<typeof packedPreparation> };
}

function ownedPhaseMetadata() {
  return { preparation: packedPreparation(new SourceSemanticReadBudget(AMPLE)) };
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
  expect(Object.isFrozen(value.preparation[1])).toBe(false);
  expect(Object.isFrozen(value.preparation[2])).toBe(false);
}

function nativeIdle(parent: SourceSemanticReadBudget, child: SourceSemanticReadBudget) {
  expect([parent.nativeWork, parent.nativeBytes, parent.indexWork, child.nativeWork, child.nativeBytes, child.indexWork])
    .toEqual([0, 0, 0, 0, 0, 0]);
}

it("holds five future metadata occurrences from one quote without freezing mutable caller metadata", () => {
  const value = phaseMetadata();
  const snapshot = JSON.parse(JSON.stringify(value));
  const independentHold = fiveCopyHold(value);
  const { parent, child, completion } = subject();
  expect(quote(completion, value)).toBeUndefined();
  expect(held(parent)).toEqual(independentHold);
  expect(parent.spentWork).toBeGreaterThan(0);
  expect(parent.spentBytes).toBeGreaterThan(0);
  expect(parent.spentWork).toBeLessThan(independentHold.work_units);
  expect(parent.spentBytes).toBeLessThan(independentHold.memory_bytes);
  expect(JSON.parse(JSON.stringify(value))).toEqual(snapshot);
  unfrozen(value);
  (value.preparation[1] as string[]).push("mutated after quote");
  (value.preparation[2] as unknown as unknown[]).push("post-quote");
  expect(held(parent)).toEqual(independentHold);
  nativeIdle(parent, child);

  const owned = ownedPhaseMetadata();
  expect(Object.isFrozen(owned)).toBe(false);
  expect(Object.isFrozen(owned.preparation)).toBe(true);
  const frozenHold = fiveCopyHold(owned);
  const frozen = subject();
  quote(frozen.completion, owned);
  expect(held(frozen.parent)).toEqual(frozenHold);
  expect(frozen.parent.spentWork).toBeGreaterThan(0);
  expect(frozen.parent.spentWork).toBeLessThan(parent.spentWork);
  expect(Object.isFrozen(owned)).toBe(false);
  expect(Object.isFrozen(owned.preparation)).toBe(true);
  nativeIdle(frozen.parent, frozen.child);
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

it("keeps executed spend and leaks no hold when measurement or the final hold fails", () => {
  const value = phaseMetadata();
  const snapshot = JSON.parse(JSON.stringify(value));
  const guard = SourceSemanticResourceLedger.measureRetain(value, AMPLE);
  const short = subject({ work_units: guard.work_units - 1, memory_bytes: AMPLE.memory_bytes });
  expect(() => quote(short.completion, value)).toThrow(SourceSemanticResourceExhausted);
  expect(JSON.parse(JSON.stringify(value))).toEqual(snapshot);
  unfrozen(value);
  expect(held(short.parent)).toEqual({ work_units: 0, memory_bytes: 0 });
  expect(short.parent.spentWork).toBeGreaterThan(0);
  expect(short.parent.spentWork).toBeLessThanOrEqual(guard.work_units - 1);
  expect(short.parent.spentWork + short.parent.work).toBe(guard.work_units - 1);
  expect(short.parent.spentBytes + short.parent.bytes).toBe(AMPLE.memory_bytes);
  nativeIdle(short.parent, short.child);

  const mid = subject({ work_units: 2 * guard.work_units + 1, memory_bytes: AMPLE.memory_bytes });
  expect(() => quote(mid.completion, value)).toThrow(SourceSemanticResourceExhausted);
  expect(JSON.parse(JSON.stringify(value))).toEqual(snapshot);
  unfrozen(value);
  expect(held(mid.parent)).toEqual({ work_units: 0, memory_bytes: 0 });
  expect(mid.parent.spentWork).toBeGreaterThan(guard.work_units);
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
