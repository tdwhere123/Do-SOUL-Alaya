import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => { isolation.restore(); });
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { SourceSemanticObserver, readSourceSemanticObservation }
  from "../../../runtime/recall-read-worker/source-semantic-observation.js";

it("aggregates final sibling allowances after meter detail fills, including adjustments and held capacity", () => {
  const observer = new SourceSemanticObserver(7, { max_events: 0, max_bytes: 0 });
  const root = new SourceSemanticReadBudget({ work_units: 1000, memory_bytes: 10000 }, observer);
  for (let index = 0; index < 40; index++) {
    const child = root.child({ work_units: 10, memory_bytes: 100 }, "observation");
    const release = child.hold({ work_units: 2, memory_bytes: 20 });
    child.charge(1, 10, "actual work");
    if (index % 2 === 0) { release(); release(); }
    if (index === 39) {
      child.promoteAfterCensus({ work_units: 12, memory_bytes: 120 });
      const constraint = new SourceSemanticReadBudget({ work_units: 8, memory_bytes: 80 });
      child.constrainToParent(constraint);
    }
    root.absorb(child);
  }
  const row = observer.finish("success");
  expect(row.meters).toHaveLength(32);
  expect(row.meter_allowances).toEqual({ complete: true, scope: "parent_phase_siblings", state: "final",
    omitted_meters: 0, rows: [
      { parent: null, phase: "request", meters: 1, initial: { work_units: 1000, memory_bytes: 10000 },
        remaining: { work_units: 960, memory_bytes: 9600 }, spent: { work_units: 40, memory_bytes: 400 },
        held: { work_units: 0, memory_bytes: 0 }, capacity: { current: { work_units: 1000, memory_bytes: 10000 },
          adjustment: { work_units: 0, memory_bytes: 0 }, changes: 0 } },
      { parent: 1, phase: "observation", meters: 40, initial: { work_units: 400, memory_bytes: 4000 },
        remaining: { work_units: 318, memory_bytes: 3180 }, spent: { work_units: 40, memory_bytes: 400 },
        held: { work_units: 40, memory_bytes: 400 }, capacity: { current: { work_units: 398, memory_bytes: 3980 },
          adjustment: { work_units: -2, memory_bytes: -20 }, changes: 2 } }
    ] });
  expect(row.meter_totals).toMatchObject({ complete: true, roots: 1, children: 40,
    root_spent: { work_units: 40, memory_bytes: 400 }, child_spent: { work_units: 40, memory_bytes: 400 } });
  expect(row.totals).toEqual({ debit_work: 40, debit_bytes: 400, absorb_work: 40, absorb_bytes: 400 });
  expect(readSourceSemanticObservation(row, 7)).toEqual(row);
});

it("separates distinct sibling phases from overlapping ancestors and preserves failed absorption", () => {
  const observer = new SourceSemanticObserver(8, { max_events: 0, max_bytes: 0 });
  const root = new SourceSemanticReadBudget({ work_units: 100, memory_bytes: 1000 }, observer);
  for (let index = 0; index < 40; index++) root.child({ work_units: 1, memory_bytes: 10 }, `phase-${index}`);
  const exploration = root.child({ work_units: 80, memory_bytes: 800 }, "exploration");
  const observation = exploration.child({ work_units: 60, memory_bytes: 600 }, "observation");
  observation.charge(5, 50, "actual work");
  exploration.absorb(observation);
  root.absorb(exploration);
  const refused = root.child({ work_units: 200, memory_bytes: 2000 }, "observation");
  refused.charge(100, 1000, "unabsorbed work");
  expect(() => root.absorb(refused)).toThrow();
  const row = observer.finish("failure");
  expect(row.meter_allowances).toMatchObject({ complete: true, omitted_meters: 0 });
  expect(row.meter_allowances!.rows).toHaveLength(44);
  expect(row.meter_allowances!.rows.filter(value => value.phase === "observation")).toMatchObject([
    { parent: 42, meters: 1, spent: { work_units: 5, memory_bytes: 50 }, remaining: { work_units: 55, memory_bytes: 550 } },
    { parent: 1, meters: 1, spent: { work_units: 100, memory_bytes: 1000 }, remaining: { work_units: 100, memory_bytes: 1000 } }
  ]);
  expect(row.meter_totals!.root_spent).toEqual({ work_units: 5, memory_bytes: 50 });
  expect(row.totals).toEqual({ debit_work: 105, debit_bytes: 1050, absorb_work: 10, absorb_bytes: 100 });
  expect(readSourceSemanticObservation(row, 8)).toEqual(row);
});

it("uses final state after absorption rather than accumulating unused labels, and detaches the snapshot", () => {
  const observer = new SourceSemanticObserver(11, { max_events: 0, max_bytes: 0 });
  const root = new SourceSemanticReadBudget({ work_units: 1000, memory_bytes: 10000 }, observer);
  const child = root.child({ work_units: 100, memory_bytes: 1000 }, "observation");
  const release = child.hold({ work_units: 20, memory_bytes: 200 });
  child.charge(5, 50); root.absorb(child);
  release(); child.charge(3, 30);
  const row = observer.finish("success");
  expect(row.costs.find(cost => cost.operation === "unused")).toMatchObject({ work: 75, bytes: 750 });
  expect(row.meter_allowances!.rows[1]).toMatchObject({ meters: 1,
    remaining: { work_units: 92, memory_bytes: 920 }, held: { work_units: 0, memory_bytes: 0 },
    spent: { work_units: 8, memory_bytes: 80 } });
  const frozen = JSON.stringify(row.meter_allowances);
  child.charge(1, 10);
  expect(JSON.stringify(row.meter_allowances)).toBe(frozen);
  expect(observer.finish("success").meter_allowances!.rows[1]!.remaining).toEqual({ work_units: 91, memory_bytes: 910 });
});

it("reports allowance-group exhaustion and observer failure without inventing complete final state", () => {
  const observer = new SourceSemanticObserver(9, { max_events: 1, max_bytes: 1000 });
  const root = new SourceSemanticReadBudget({ work_units: 1000, memory_bytes: 10000 }, observer);
  for (let index = 0; index < 140; index++) {
    const child = root.child({ work_units: 2, memory_bytes: 20 }, `phase-${index}`);
    child.charge(1, 10); root.absorb(child);
  }
  const exhausted = observer.finish("success");
  expect(exhausted.meter_allowances).toMatchObject({ complete: false, omitted_meters: 13 });
  expect(exhausted.meter_allowances!.rows).toHaveLength(128);
  expect(exhausted.issues).toContain("meter_allowance_limit");
  expect(exhausted.meter_totals!.root_spent).toEqual({ work_units: 140, memory_bytes: 1400 });
  const broken = new SourceSemanticObserver(9, { max_events: 1, max_bytes: 1000 });
  new SourceSemanticReadBudget({ work_units: 10, memory_bytes: 100 }, broken);
  broken.event("broken", "test", () => { throw new Error("capture failure"); });
  const failed = broken.finish("success");
  expect(failed.status).toBe("failure");
  expect(failed.meter_allowances!.complete).toBe(false);
  expect(failed.meter_totals!.complete).toBe(false);
  expect(readSourceSemanticObservation(failed, 9)).toEqual(failed);
});

it("leaves historical missing allowance and capacity witnesses unknown", () => {
  const observer = new SourceSemanticObserver(10, { max_events: 0, max_bytes: 0 });
  new SourceSemanticReadBudget({ work_units: 10, memory_bytes: 100 }, observer);
  const historical = JSON.parse(JSON.stringify(observer.finish("success")));
  delete historical.meter_allowances;
  delete historical.meters[0].capacity;
  historical.facts.operation_totals = { complete: true, rows: [{ kind: "retain", count: 142,
    completed: 142, work: 284, bytes: 24424, same_object_count: 0, same_object_work: 0, same_object_bytes: 0,
    uncompared_object_count: 14, identity_capture: "partial" }] };
  const parsed = readSourceSemanticObservation(historical, 10);
  expect(parsed.status).toBe("observed");
  expect(parsed.meter_allowances).toBeUndefined();
  expect(parsed.meters[0]!.capacity).toBeUndefined();
  expect(parsed.facts!.operation_totals).toEqual(historical.facts.operation_totals);
  delete historical.facts.operation_totals;
  expect(readSourceSemanticObservation(historical, 10).facts!.operation_totals).toBeUndefined();
});
