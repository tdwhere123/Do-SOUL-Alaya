import { expect, it } from "vitest";
import { SourceSemanticResourceExhausted, SourceSemanticResourceLedger } from "../../garden/source-semantic-resources.js";

const ample = { work_units: 10_000, memory_bytes: 1_000_000 };
const quoteRetain = SourceSemanticResourceLedger.quoteRetain.bind(SourceSemanticResourceLedger);
const overlayRetainObjects = SourceSemanticResourceLedger.overlayRetainObjects.bind(SourceSemanticResourceLedger);
const measureRetain = SourceSemanticResourceLedger.measureRetain.bind(SourceSemanticResourceLedger);

function actualRetain(value: unknown, ownership?: "immutable") {
  const ledger = new SourceSemanticResourceLedger(ample);
  ledger.retain(value, "preparation", ownership);
  return ledger;
}

function actualSpent(value: unknown) {
  const ledger = actualRetain(value);
  return { work_units: ledger.spentWork, memory_bytes: ledger.spentBytes };
}

function fragment() {
  return {
    snow: "雪",
    escaped: '雪"\\',
    none: null,
    missing: undefined,
    list: [null, true, "你好"],
    nested: { deep: ["层"] }
  };
}

function fiveOf(item: unknown) {
  return { one: item, two: item, three: item, four: item, five: item };
}

it("quotes primitives at independent fixed retain prices and matches nested payload retain", () => {
  expect(actualSpent(null)).toEqual({ work_units: 1, memory_bytes: 64 });
  expect(actualSpent(true)).toEqual({ work_units: 1, memory_bytes: 64 });
  expect(actualSpent(undefined)).toEqual({ work_units: 1, memory_bytes: 64 });
  expect(actualSpent("雪")).toEqual({ work_units: 1, memory_bytes: 28 });
  expect(actualSpent('雪"\\')).toEqual({ work_units: 1, memory_bytes: 36 });
  expect(actualSpent([])).toEqual({ work_units: 1, memory_bytes: 64 });
  expect(actualSpent({})).toEqual({ work_units: 1, memory_bytes: 64 });
  expect(actualSpent({ work_units: 0, memory_bytes: 0 })).toEqual({ work_units: 3, memory_bytes: 328 });
  expect(quoteRetain(null, ample).work_units).toBe(1);
  expect(quoteRetain(null, ample).memory_bytes).toBe(64);
  expect(quoteRetain("雪", ample).memory_bytes).toBe(28);
  const value = fragment();
  const quoted = quoteRetain(value, ample);
  const actual = actualSpent(value);
  expect(quoted.work_units).toBe(actual.work_units);
  expect(quoted.memory_bytes).toBe(actual.memory_bytes);
  expect(measureRetain(value, ample)).toEqual(actual);
});

it("composes five quoted occurrences to the concrete repeated retain cost", () => {
  const inner = fragment();
  const concrete = fiveOf(inner);
  const actual = actualSpent(concrete);
  const quoted = quoteRetain(fiveOf(quoteRetain(inner, ample)), ample);
  expect(quoted.work_units).toBe(actual.work_units);
  expect(quoted.memory_bytes).toBe(actual.memory_bytes);
  expect(measureRetain(concrete, ample)).toEqual(actual);
});

it("overlays disjoint object quotes as the merged retain cost and only overquotes duplicate keys", () => {
  const left = { snow: "雪", none: null };
  const right = { list: [true, "你好"], nested: { deep: ["层"] } };
  const merged = { snow: "雪", none: null, list: [true, "你好"], nested: { deep: ["层"] } };
  const composed = overlayRetainObjects(quoteRetain(left, ample), quoteRetain(right, ample));
  const actual = actualSpent(merged);
  expect(composed.work_units).toBe(actual.work_units);
  expect(composed.memory_bytes).toBe(actual.memory_bytes);
  const duplicate = overlayRetainObjects(
    quoteRetain({ snow: "雪", extra: 1 }, ample),
    quoteRetain({ snow: "你好" }, ample));
  const assigned = actualSpent({ snow: "你好", extra: 1 });
  expect(duplicate.work_units).toBeGreaterThanOrEqual(assigned.work_units);
  expect(duplicate.memory_bytes).toBeGreaterThanOrEqual(assigned.memory_bytes);
});

it("does not let actual retain treat a numeric price witness as payload substitution", () => {
  const quoted = quoteRetain(fragment(), ample);
  expect(quoted.work_units).toBeGreaterThan(3);
  expect(actualSpent(quoted)).toEqual({ work_units: 3, memory_bytes: 328 });
  const planted = { witness: quoted, snow: "雪" };
  const twin = { witness: { work_units: quoted.work_units, memory_bytes: quoted.memory_bytes }, snow: "雪" };
  expect(actualSpent(planted)).toEqual(actualSpent(twin));
  expect(actualSpent(planted).work_units).not.toBe(quoted.work_units);
});

it("rejects forged plain and serialized budgets from quote admission", () => {
  const real = quoteRetain(fragment(), ample);
  const forged = { work_units: 0, memory_bytes: 0 };
  const serialized = JSON.parse(JSON.stringify(real)) as { work_units: number; memory_bytes: number };
  expect(() => overlayRetainObjects(forged, real)).toThrow(SourceSemanticResourceExhausted);
  expect(() => overlayRetainObjects(real, forged)).toThrow(SourceSemanticResourceExhausted);
  expect(() => overlayRetainObjects(serialized, real)).toThrow(SourceSemanticResourceExhausted);
  expect(quoteRetain(forged, ample).work_units).toBe(3);
  expect(quoteRetain(forged, ample).memory_bytes).toBe(328);
  expect(quoteRetain(serialized, ample).work_units).toBe(3);
  expect(quoteRetain(serialized, ample).memory_bytes).toBe(328);
  expect(quoteRetain({ item: forged }, ample).work_units).toBe(actualSpent({ item: forged }).work_units);
  expect(quoteRetain({ item: forged }, ample).memory_bytes).toBe(actualSpent({ item: forged }).memory_bytes);
});

it("rejects mixed object and array overlay", () => {
  const objectQuote = quoteRetain({ snow: "雪" }, ample);
  const arrayQuote = quoteRetain(["雪"], ample);
  const scalarQuote = quoteRetain(null, ample);
  expect(() => overlayRetainObjects(objectQuote, arrayQuote)).toThrow(SourceSemanticResourceExhausted);
  expect(() => overlayRetainObjects(arrayQuote, objectQuote)).toThrow(SourceSemanticResourceExhausted);
  expect(() => overlayRetainObjects(arrayQuote, arrayQuote)).toThrow(SourceSemanticResourceExhausted);
  expect(() => overlayRetainObjects(scalarQuote, objectQuote)).toThrow(SourceSemanticResourceExhausted);
});

it("refuses unsafe overflow when composing object prices", () => {
  const room = { work_units: Number.MAX_SAFE_INTEGER, memory_bytes: Number.MAX_SAFE_INTEGER };
  let price = quoteRetain({ mark: "雪" }, room);
  let refused = false;
  for (let step = 0; step < 64; step++) {
    try {
      price = quoteRetain({ left: price, right: price }, room);
    } catch (error) {
      expect(error).toBeInstanceOf(SourceSemanticResourceExhausted);
      refused = true;
      break;
    }
    try {
      overlayRetainObjects(price, price);
    } catch (error) {
      expect(error).toBeInstanceOf(SourceSemanticResourceExhausted);
      refused = true;
      break;
    }
  }
  expect(refused).toBe(true);
});

it("reuses an owned frozen subtree without repeating traversal while keeping future cost", () => {
  const owned = fragment();
  const cloneCost = actualSpent(fragment());
  actualRetain(owned, "immutable");
  expect(Object.isFrozen(owned)).toBe(true);
  expect(Object.isFrozen(owned.list)).toBe(true);
  expect(Object.isFrozen(owned.nested)).toBe(true);
  expect(Object.isFrozen(owned.nested.deep)).toBe(true);
  const ownedQuote = quoteRetain(owned, ample);
  expect(ownedQuote.work_units).toBe(cloneCost.work_units);
  expect(ownedQuote.memory_bytes).toBe(cloneCost.memory_bytes);
  const fiveCost = actualSpent(fiveOf(fragment()));
  expect(cloneCost.work_units + 32).toBeLessThan(fiveCost.work_units);
  expect(cloneCost.memory_bytes + 512).toBeLessThan(fiveCost.memory_bytes);
  const planner = new SourceSemanticResourceLedger({
    work_units: cloneCost.work_units + 32, memory_bytes: cloneCost.memory_bytes + 512 });
  const quotedFive = quoteRetain(fiveOf(owned), ample, planner);
  expect(quotedFive.work_units).toBe(fiveCost.work_units);
  expect(quotedFive.memory_bytes).toBe(fiveCost.memory_bytes);
  expect(planner.spentWork).toBeGreaterThan(0);
  expect(planner.spentWork).toBeLessThan(fiveCost.work_units);
  expect(planner.spentBytes).toBeLessThan(fiveCost.memory_bytes);
});

it("rejects getters, prototypes, and symbols when retaining owned immutable data", () => {
  let accessed = false;
  const getter = { get snow() { accessed = true; return "雪"; } };
  expect(() => actualRetain(getter, "immutable")).toThrow(SourceSemanticResourceExhausted);
  expect(accessed).toBe(false);
  expect(Object.isFrozen(getter)).toBe(false);
  const prototype = Object.create({ inherited: 1 });
  prototype.own = "雪";
  expect(() => actualRetain(prototype, "immutable")).toThrow(SourceSemanticResourceExhausted);
  const symbolic = { snow: "雪", [Symbol("hidden")]: 1 };
  expect(() => actualRetain(symbolic, "immutable")).toThrow(SourceSemanticResourceExhausted);
  expect(Object.isFrozen(symbolic)).toBe(false);
});

it("does not silently cache a mutable caller payload", () => {
  const row = { snow: "雪" };
  actualRetain(row);
  expect(Object.isFrozen(row)).toBe(false);
  row.snow = "雪".repeat(40);
  const mutated = actualSpent(row);
  expect(mutated).toEqual(actualSpent({ snow: "雪".repeat(40) }));
  expect(mutated.memory_bytes).not.toBe(actualSpent({ snow: "雪" }).memory_bytes);
  expect(quoteRetain(row, ample).work_units).toBe(mutated.work_units);
  expect(quoteRetain(row, ample).memory_bytes).toBe(mutated.memory_bytes);
});

it("charges only executed planner work on a failed quote and still charges a later retain", () => {
  const value = fragment();
  const tight = { work_units: 2, memory_bytes: ample.memory_bytes };
  const planner = new SourceSemanticResourceLedger(ample);
  expect(() => quoteRetain(value, tight, planner)).toThrow(SourceSemanticResourceExhausted);
  const measured = new SourceSemanticResourceLedger(ample);
  expect(() => measureRetain(value, tight, measured)).toThrow(SourceSemanticResourceExhausted);
  expect(planner.spentWork).toBe(measured.spentWork);
  expect(planner.spentBytes).toBe(measured.spentBytes);
  expect(planner.spentWork).toBeGreaterThan(0);
  expect(planner.spentWork).toBeLessThan(actualSpent(value).work_units);
  planner.retain(null);
  expect(planner.spentWork).toBe(measured.spentWork + 1);
  expect(planner.spentBytes).toBe(measured.spentBytes + 64);
});
