import { expect, it } from "vitest";
import { SourceSemanticResourceExhausted, SourceSemanticResourceLedger } from "../../garden/source-semantic-resources.js";

const ample = { work_units: 10_000, memory_bytes: 1_000_000 };

it("measures the existing incremental retain traversal for repeated references and escaped values", () => {
  const shared = { note: '雪"\\', optional: undefined };
  const value = { first: shared, again: shared, list: [null, true, 1e308] };
  const actual = new SourceSemanticResourceLedger(ample);
  actual.retain(value);
  const planner = new SourceSemanticResourceLedger(ample);
  expect(SourceSemanticResourceLedger.measureRetain(value, ample, planner)).toEqual({
    work_units: actual.spentWork, memory_bytes: actual.spentBytes });
  expect(planner.spentWork).toBe(actual.spentWork);
  expect(planner.spentBytes).toBe(actual.spentBytes);
  const exact = new SourceSemanticResourceLedger({ work_units: actual.spentWork, memory_bytes: actual.spentBytes });
  exact.retain(value);
  expect(exact.remaining()).toEqual({ work_units: 0, memory_bytes: 0 });
  expect(() => SourceSemanticResourceLedger.measureRetain(value, { work_units: actual.spentWork - 1,
    memory_bytes: actual.spentBytes })).toThrow(SourceSemanticResourceExhausted);
});

it("keeps partial debit and bounds cyclic graphs before copying their children", () => {
  const value: { next?: unknown } = {};
  value.next = value;
  const actual = new SourceSemanticResourceLedger({ work_units: 3, memory_bytes: 1_000 });
  expect(() => actual.retain(value)).toThrow(SourceSemanticResourceExhausted);
  expect(actual.spentWork).toBeGreaterThan(0);
  expect(actual.spentWork).toBeLessThanOrEqual(3);
  const planner = new SourceSemanticResourceLedger({ work_units: 3, memory_bytes: 1_000 });
  expect(() => SourceSemanticResourceLedger.measureRetain(value, planner.remaining(), planner)).toThrow(SourceSemanticResourceExhausted);
  expect(planner.spentWork).toBe(actual.spentWork);
  expect(planner.spentBytes).toBe(actual.spentBytes);
});
