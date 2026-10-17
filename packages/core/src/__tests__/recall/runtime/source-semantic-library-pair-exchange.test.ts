import { expect, it } from "vitest";
import { SourceSemanticResourceLedger } from "@do-soul/alaya-protocol";
import { selectSourceSemanticLibraryPage, selectSourceSemanticLibraryPageWithPairExchange,
  type SourceSemanticLibraryPackage } from "../../../recall/runtime/source-semantic-library-selection.js";
import { coverageSelectionFixture, physicalRoot, selectionExecutionBudget } from "./source-semantic-selection-fixture.js";

const fixture = coverageSelectionFixture(selectionExecutionBudget);
const roots = (page: readonly SourceSemanticLibraryPackage[]) => page.map(physicalRoot).sort();
const pair = roots(fixture.pool.slice(2));
const isPair = (page: readonly SourceSemanticLibraryPackage[]) => JSON.stringify(roots(page)) === JSON.stringify(pair);
const fits = (page: readonly SourceSemanticLibraryPackage[]) => page.length <= 2;

it.each(["work", "bytes"] as const)("keeps the incumbent and restores held %s when pair encoding exhausts", resource => {
  const meter = new SourceSemanticResourceLedger(selectionExecutionBudget);
  const baselineMeter = new SourceSemanticResourceLedger(selectionExecutionBudget);
  const baseline = selectSourceSemanticLibraryPage({ candidates: fixture.pool, meter: baselineMeter, fits });
  let attempted = false;
  const selected = selectSourceSemanticLibraryPageWithPairExchange({ candidates: fixture.pool, meter, fits: page => {
    if (isPair(page)) {
      attempted = true;
      meter.charge(resource === "work" ? meter.work + 1 : 0, resource === "bytes" ? meter.bytes + 1 : 0, "pair encoder");
    }
    return fits(page);
  } });
  expect(attempted).toBe(true);
  expect(selected).toEqual(baseline);
  expect(meter.spentWork).toBeLessThanOrEqual(2 * baselineMeter.spentWork);
  expect(meter.work + meter.spentWork).toBe(selectionExecutionBudget.work_units);
  expect(meter.bytes + meter.spentBytes).toBe(selectionExecutionBudget.memory_bytes);
  expect(meter.work).toBeGreaterThan(0);
  expect(meter.bytes).toBeGreaterThan(0);
});

it("retains a strictly improved pair when later optional work exhausts", () => {
  const meter = new SourceSemanticResourceLedger(selectionExecutionBudget);
  let accepted = false;
  const selected = selectSourceSemanticLibraryPageWithPairExchange({ candidates: fixture.pool, meter, fits: page => {
    if (isPair(page)) { accepted = true; meter.charge(Math.max(0, meter.work - 1), 0, "pair encoding"); return true; }
    return fits(page);
  } });
  expect(accepted).toBe(true);
  expect(roots(selected)).toEqual(pair);
  expect(meter.work + meter.spentWork).toBe(selectionExecutionBudget.work_units);
});

it("restores the ledger but propagates an unexpected pair encoder failure", () => {
  const meter = new SourceSemanticResourceLedger(selectionExecutionBudget);
  const failure = new Error("encoder failure");
  expect(() => selectSourceSemanticLibraryPageWithPairExchange({ candidates: fixture.pool, meter, fits: page => {
    if (isPair(page)) throw failure;
    return fits(page);
  } })).toThrow(failure);
  expect(meter.work + meter.spentWork).toBe(selectionExecutionBudget.work_units);
  expect(meter.bytes + meter.spentBytes).toBe(selectionExecutionBudget.memory_bytes);
});
