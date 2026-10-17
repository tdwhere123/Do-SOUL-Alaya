import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); });
afterAll(() => { isolation.restore(); });
import { alternativeSelectionFixture, coverageSelectionFixture, executedInputNumbers, selectionExecutionBudget,
  type SelectionTaskFixture } from "../../../../../../packages/core/src/__tests__/recall/runtime/source-semantic-selection-fixture.js";
import { measureNativeSubset, nativeSubsetContext, roomyDeliveryBytes, type NativeSubsetContext }
  from "./source-semantic-library-subset-packing.test-support.js";
import { measureSelectionGap, type ObjectiveVector } from "./source-semantic-library-selection-gap.test-support.js";

/** Clear of the few label bytes that page order changes, so a gap is not a boundary artifact. */
const MARGIN = 200;
const pageBytes = (context: NativeSubsetContext, names: readonly string[]) => measureNativeSubset(context, roomyDeliveryBytes,
  names.map(name => context.fixture.sources.find(source => source.id === name)!.package)).reserved_bytes!;

type Case = Readonly<{ name: string; fixture: "alternatives" | "coverage"; sources: readonly string[]; margin: number;
  selected: string; objective: ObjectiveVector; optimum: ObjectiveVector; optimal: boolean;
  selectedComplete: boolean; bestComplete: boolean }>;
const ALT = "alternatives", COV = "coverage";
const cases: readonly Case[] = [
  { name: "raw-only page ignores obligations when no proof fits below the smallest proof", fixture: ALT, sources: ["backup"],
    margin: -MARGIN, selected: "checks-left:raw + checks-right:raw", objective: [0, 0, 0], optimum: [0, 0, 0], optimal: true,
    selectedComplete: false, bestComplete: true },
  { name: "required AND bundle fits but selector splits it across a larger single", fixture: ALT, sources: ["permission", "backup"],
    margin: MARGIN, selected: "checks-left:proof", objective: [0, 2, 1], optimum: [0, 2, 2], optimal: false,
    selectedComplete: false, bestComplete: true },
  { name: "short complete alternative loses to a longer incomplete alternative", fixture: ALT, sources: ["checks-left", "checks-right"],
    margin: MARGIN, selected: "checks-left:proof + checks-right:proof", objective: [0, 4, 2], optimum: [0, 4, 2], optimal: true,
    selectedComplete: false, bestComplete: true },
  { name: "greedy marginal coverage forgoes an extra qualified witness at the same coverage", fixture: ALT,
    sources: ["permission", "backup", "checks-left"], margin: MARGIN, selected: "checks-left:proof + checks-right:proof",
    objective: [0, 4, 2], optimum: [0, 4, 3], optimal: false, selectedComplete: false, bestComplete: true },
  { name: "equal-value roots tie and the selector lands inside the optimal tie class", fixture: ALT,
    sources: ["permission", "backup", "checks-left", "checks-right"], margin: MARGIN,
    selected: "backup-compatible:proof + checks-left:proof + checks-right:proof + permission:proof",
    objective: [0, 6, 4], optimum: [0, 6, 4], optimal: true, selectedComplete: true, bestComplete: true },
  { name: "complementary obligations split across roots lose to two overlapping high-count roots", fixture: COV,
    sources: ["c-left", "d-right"], margin: MARGIN, selected: "a-trap:proof + b-trap:proof",
    objective: [0, 11, 2], optimum: [0, 12, 2], optimal: false, selectedComplete: false, bestComplete: true },
  { name: "a third root that fits is not found after two overlapping roots are chosen", fixture: COV,
    sources: ["b-trap", "c-left", "d-right"], margin: MARGIN, selected: "a-trap:proof + b-trap:proof",
    objective: [0, 11, 2], optimum: [0, 12, 3], optimal: false, selectedComplete: false, bestComplete: true },
  { name: "complementary pair is found once all three roots fit", fixture: COV,
    sources: ["a-trap", "c-left", "d-right"], margin: MARGIN, selected: "a-trap:proof + c-left:proof + d-right:proof",
    objective: [0, 13, 3], optimum: [0, 13, 3], optimal: true, selectedComplete: true, bestComplete: true }
];

const fixtures: Record<Case["fixture"], () => SelectionTaskFixture> = {
  alternatives: () => alternativeSelectionFixture(selectionExecutionBudget), coverage: () => coverageSelectionFixture(selectionExecutionBudget)
};
async function withContext(fixture: SelectionTaskFixture, run: (context: NativeSubsetContext) => void | Promise<void>) {
  const context = await nativeSubsetContext(fixture);
  try { await run(context); } finally { await context.close(); }
}

for (const row of cases) {
  it(`${row.name}`, async () => {
    await withContext(fixtures[row.fixture](), context => {
      const limit = pageBytes(context, row.sources) + row.margin;
      const gap = measureSelectionGap(context, limit);
      expect(gap.selected_fits_in_pool_order).toBe(true);
      expect(gap.selected.label).toBe(row.selected);
      expect(gap.selected.objective).toEqual(row.objective);
      expect(gap.optimum).toEqual(row.optimum);
      expect(gap.selector_is_optimal).toBe(row.optimal);
      expect(gap.selected.complete).toBe(row.selectedComplete);
      expect(gap.best_complete).toBe(row.bestComplete);
      expect(gap.selected.any_at_k).toBe(true);
    });
  }, 120_000);
}

it("keeps the objective vector aligned with executed proof inputs and the authored statements", async () => {
  for (const make of Object.values(fixtures)) {
    const fixture = make();
    for (const source of fixture.sources) expect(executedInputNumbers(source.package)).toEqual([...source.inputs]);
  }
});

it("charges less than the sum of single roots, so an additive cost bound would reject a page that fits", async () => {
  await withContext(alternativeSelectionFixture(selectionExecutionBudget), context => {
    const pair = pageBytes(context, ["permission", "backup"]);
    const singles = pageBytes(context, ["permission"]) + pageBytes(context, ["backup"]);
    expect(singles).toBeGreaterThan(pair + 3_000);
    const gap = measureSelectionGap(context, pair + MARGIN);
    expect(pair + MARGIN).toBeLessThan(singles);
    expect(gap.optimal_pages).toContain("backup:proof + permission:proof");
  });
}, 120_000);

it("counts a second package of the same root once and never places both on a page", async () => {
  await withContext(alternativeSelectionFixture(selectionExecutionBudget), context => {
    const pool = context.fixture.pool;
    const duplicated = [...pool, ...pool.filter(row => row !== pool[0]).map(row => ({ ...row, access_position: 7 }))];
    const gap = measureSelectionGap(context, roomyDeliveryBytes, duplicated);
    expect(gap.selected.objective).toEqual([0, 6, 5]);
    expect(gap.selector_is_optimal).toBe(true);
    expect(gap.selected.label.split(" + ")).toHaveLength(5);
  });
}, 120_000);
