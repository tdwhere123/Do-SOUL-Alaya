import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); });
afterAll(() => { isolation.restore(); });
import { selectSourceSemanticLibraryPage, selectSourceSemanticLibraryPageWithPairExchange }
  from "../../../../../../packages/core/src/recall/runtime/source-semantic-library-selection.js";
import { alternativeSelectionFixture, coverageSelectionFixture, rawSourceTwin, selectionExecutionBudget }
  from "../../../../../../packages/core/src/__tests__/recall/runtime/source-semantic-selection-fixture.js";
import { nativeSubsetContext, persistArtifact } from "./source-semantic-library-subset-packing.test-support.js";
import { exhaustiveReference, measureSelectionGap, selectionGapLimits } from "./source-semantic-library-selection-gap.test-support.js";
import { freezeTextGold, measureTextRecall, textRecallPolicies } from "./source-semantic-library-text-recall.test-support.js";

it.each([238405, 238982, 277716])("keeps complete default delivery where private pair work truncates later pages at %i bytes", async limit => {
  const context = await nativeSubsetContext(coverageSelectionFixture(selectionExecutionBudget));
  try {
    const candidates = context.fixture.pool.flatMap(row => [rawSourceTwin(row), row]), gold = freezeTextGold(context.fixture);
    const baseline = measureTextRecall(context, candidates, limit, textRecallPolicies.original_default, gold);
    const trial = measureTextRecall(context, candidates, limit, textRecallPolicies.anytime_pairs, gold);
    expect(baseline.pages_for_all_gold).not.toBeNull();
    expect(baseline.delivery_truncated).toBe(false);
    expect(trial.pages_for_all_gold).toBeNull();
    expect(trial.delivery_truncated).toBe(true);
    expect(trial.budget_rejections.length).toBeGreaterThan(0);
    expect(trial.recall_at_5).toBe(baseline.recall_at_5);
    expect(trial.exhausted).toBe(false);
  } finally { await context.close(); }
}, 120_000);

// Frozen before running: optional work <= min(200k, incumbent work, half remaining);
// optional memory <= min(16M, half remaining). Encoder callbacks share that ledger.
const enabled = process.env["ALAYA_SELECTION_POLICY_SCAN"] === "1";
for (const [name, make] of Object.entries({ alternatives: alternativeSelectionFixture, coverage: coverageSelectionFixture })) {
  it.skipIf(!enabled)(`bounds anytime exchange against the original selector and exact ${name} optimum`, async () => {
    const context = await nativeSubsetContext(make(selectionExecutionBudget));
    try {
      const candidates = context.fixture.pool.flatMap(row => [rawSourceTwin(row), row]);
      const rows = selectionGapLimits(context).map(limit => {
        const reference = exhaustiveReference(context, limit, candidates);
        const baseline = measureSelectionGap(context, limit, candidates, selectSourceSemanticLibraryPage, reference);
        const candidate = measureSelectionGap(context, limit, candidates, selectSourceSemanticLibraryPageWithPairExchange, reference);
        const delta = candidate.selected.objective.map((value, index) => value - baseline.selected.objective[index]!)
          .find(value => value !== 0) ?? 0;
        expect(delta).toBeGreaterThanOrEqual(0);
        expect(candidate.selected_fits_in_pool_order).toBe(true);
        expect(candidate.selector_work.logical_work).toBeLessThanOrEqual(2 * baseline.selector_work.logical_work);
        expect(candidate.selected.label).not.toBe("");
        return { limit, baseline, candidate, work_ratio: candidate.selector_work.logical_work / baseline.selector_work.logical_work };
      });
      expect(rows).toHaveLength(22);
      const ratios = rows.map(row => row.work_ratio).sort((a, b) => a - b);
      const result = { cap: { optional_work: 200_000, optional_bytes: 16_000_000, max_work_ratio: 2 },
        optimal: rows.filter(row => row.candidate.selector_is_optimal).length,
        better: rows.filter(row => JSON.stringify(row.candidate.selected.objective) !== JSON.stringify(row.baseline.selected.objective)).length,
        median_work_ratio: (ratios[10]! + ratios[11]!) / 2, maximum_work_ratio: ratios.at(-1), rows };
      await persistArtifact("anytime-selection", `${name}.json`, result);
      console.log(JSON.stringify({ pool: name, ...result, rows: undefined }));
    } finally { await context.close(); }
  }, 600_000);
}
