import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); });
afterAll(() => { isolation.restore(); });
import { SourceSemanticResourceExhausted } from "@do-soul/alaya-protocol";
import { selectSourceSemanticLibraryPage } from "@do-soul/alaya-core";
import { selectSourceSemanticLibraryPageWithEvidenceSetCoverage, selectSourceSemanticLibraryPageWithReturnedTupleNovelty }
  from "../../../../../../packages/core/src/recall/runtime/source-semantic-library-selection.js";
import { alternativeSelectionFixture, coverageSelectionFixture, rawSourceTwin, selectionExecutionBudget,
  type SelectionTaskFixture } from "../../../../../../packages/core/src/__tests__/recall/runtime/source-semantic-selection-fixture.js";
import { measureNativeSubset, nativeSubsetContext, roomyDeliveryBytes, type NativeSubsetContext }
  from "./source-semantic-library-subset-packing.test-support.js";
import { exhaustiveReference, measureSelectionGap, type ObjectiveVector } from "./source-semantic-library-selection-gap.test-support.js";

const MARGIN = 200;
const selectors = { default: selectSourceSemanticLibraryPage, evidenceSet: selectSourceSemanticLibraryPageWithEvidenceSetCoverage,
  returnedTuple: selectSourceSemanticLibraryPageWithReturnedTupleNovelty } as const;
type Name = keyof typeof selectors;
const names = Object.keys(selectors) as Name[];
const pageBytes = (context: NativeSubsetContext, sources: readonly string[]) => measureNativeSubset(context, roomyDeliveryBytes,
  sources.map(name => context.fixture.sources.find(source => source.id === name)!.package)).reserved_bytes!;
const candidatesOf = (fixture: SelectionTaskFixture) => fixture.pool.flatMap(row => [rawSourceTwin(row), row]);
async function withContext(fixture: SelectionTaskFixture, run: (context: NativeSubsetContext) => void | Promise<void>) {
  const context = await nativeSubsetContext(fixture);
  try { await run(context); } finally { await context.close(); }
}

type Pick = Readonly<{ label: string; objective: ObjectiveVector; complete: boolean }>;
type Case = Readonly<{ name: string; fixture: "alternatives" | "coverage"; sources: readonly string[]; margin: number;
  optimum: ObjectiveVector; bestComplete: boolean } & Record<Name, Pick>>;
const same = (label: string, objective: ObjectiveVector, complete: boolean): Pick => ({ label, objective, complete });
const cases: readonly Case[] = [
  { name: "raw-only page below the smallest proof", fixture: "alternatives", sources: ["backup"], margin: -MARGIN,
    optimum: [0, 0, 0], bestComplete: true, default: same("checks-left:raw + checks-right:raw", [0, 0, 0], false),
    evidenceSet: same("checks-left:raw + checks-right:raw", [0, 0, 0], false), returnedTuple: same("checks-left:raw + checks-right:raw", [0, 0, 0], false) },
  { name: "required AND bundle fits but the default splits it", fixture: "alternatives", sources: ["permission", "backup"], margin: MARGIN,
    optimum: [0, 2, 2], bestComplete: true, default: same("checks-left:proof", [0, 2, 1], false),
    evidenceSet: same("backup-compatible:proof + permission:proof", [0, 2, 2], true), returnedTuple: same("checks-left:proof", [0, 2, 1], false) },
  { name: "short complete alternative loses to a longer incomplete alternative in O1", fixture: "alternatives",
    sources: ["checks-left", "checks-right"], margin: MARGIN, optimum: [0, 4, 2], bestComplete: true,
    default: same("checks-left:proof + checks-right:proof", [0, 4, 2], false),
    evidenceSet: same("backup-compatible:proof + permission:proof", [0, 2, 2], true),
    returnedTuple: same("checks-left:proof + checks-right:proof", [0, 4, 2], false) },
  { name: "extra qualified witness at equal coverage", fixture: "alternatives", sources: ["permission", "backup", "checks-left"],
    margin: MARGIN, optimum: [0, 4, 3], bestComplete: true, default: same("checks-left:proof + checks-right:proof", [0, 4, 2], false),
    evidenceSet: same("backup-compatible:proof + permission:proof", [0, 2, 2], true),
    returnedTuple: same("checks-left:proof + checks-right:proof", [0, 4, 2], false) },
  { name: "equal-value ties inside the optimal class", fixture: "alternatives",
    sources: ["permission", "backup", "checks-left", "checks-right"], margin: MARGIN, optimum: [0, 6, 4], bestComplete: true,
    default: same("backup-compatible:proof + checks-left:proof + checks-right:proof + permission:proof", [0, 6, 4], true),
    evidenceSet: same("backup-compatible:proof + checks-left:proof + checks-right:proof + permission:proof", [0, 6, 4], true),
    returnedTuple: same("backup-compatible:proof + checks-left:proof + checks-right:proof + permission:proof", [0, 6, 4], true) },
  { name: "complementary obligations split across roots", fixture: "coverage", sources: ["c-left", "d-right"], margin: MARGIN,
    optimum: [0, 12, 2], bestComplete: true, default: same("a-trap:proof + b-trap:proof", [0, 11, 2], false),
    evidenceSet: same("c-left:proof + d-right:proof", [0, 12, 2], false), returnedTuple: same("a-trap:proof + b-trap:proof", [0, 11, 2], false) },
  { name: "third root that fits after two overlapping roots", fixture: "coverage", sources: ["b-trap", "c-left", "d-right"], margin: MARGIN,
    optimum: [0, 12, 3], bestComplete: true, default: same("a-trap:proof + b-trap:proof", [0, 11, 2], false),
    evidenceSet: same("c-left:proof + d-right:proof", [0, 12, 2], false), returnedTuple: same("a-trap:proof + b-trap:proof", [0, 11, 2], false) },
  { name: "all complementary roots fit", fixture: "coverage", sources: ["a-trap", "c-left", "d-right"], margin: MARGIN,
    optimum: [0, 13, 3], bestComplete: true, default: same("a-trap:proof + c-left:proof + d-right:proof", [0, 13, 3], true),
    evidenceSet: same("a-trap:proof + c-left:proof + d-right:proof", [0, 13, 3], true),
    returnedTuple: same("a-trap:proof + c-left:proof + d-right:proof", [0, 13, 3], true) }
];
const fixtures = { alternatives: () => alternativeSelectionFixture(selectionExecutionBudget),
  coverage: () => coverageSelectionFixture(selectionExecutionBudget) };

for (const row of cases) {
  it(`pairs each selector with the exhaustive reference: ${row.name}`, async () => {
    await withContext(fixtures[row.fixture](), context => {
      const limit = pageBytes(context, row.sources) + row.margin, candidates = candidatesOf(context.fixture);
      const reference = exhaustiveReference(context, limit, candidates);
      expect(reference.optimum).toEqual(row.optimum);
      for (const name of names) {
        const gap = measureSelectionGap(context, limit, candidates, selectors[name], reference);
        expect(gap.selected_fits_in_pool_order).toBe(true);
        expect({ label: gap.selected.label, objective: gap.selected.objective, complete: gap.selected.complete })
          .toEqual(row[name]);
        expect(gap.best_complete).toBe(row.bestComplete);
        expect(gap.selected.any_at_k).toBe(true);
      }
    });
  }, 120_000);
}

/** Limits at the encoded size of every proof-only subset: each cluster of near-equal sizes, minus and plus a clear margin. */
function scanLimits(context: NativeSubsetContext): readonly number[] {
  const ids = context.fixture.sources.map(source => source.id), sizes: number[] = [];
  for (let mask = 1; mask < 1 << ids.length; mask++) sizes.push(pageBytes(context, ids.filter((_, index) => mask & 1 << index)));
  const clusters: [number, number][] = [];
  for (const size of sizes.sort((a, b) => a - b)) {
    const last = clusters[clusters.length - 1];
    if (last !== undefined && size - last[1] <= MARGIN) last[1] = size; else clusters.push([size, size]);
  }
  return clusters.flatMap(([low, high]) => [low - MARGIN, high + MARGIN]);
}

type Summary = Record<Name, { suboptimal: number; worseThanDefault: number; betterThanDefault: number; exhausted: number;
  complete: number; bestComplete: number; anyAtK: number; heavier: number; proofComplete: number; bestProofComplete: number }>;
function scan(context: NativeSubsetContext): { limits: number; summary: Summary } {
  const limits = scanLimits(context), candidates = candidatesOf(context.fixture);
  const summary = Object.fromEntries(names.map(name => [name, { suboptimal: 0, worseThanDefault: 0, betterThanDefault: 0,
    exhausted: 0, complete: 0, bestComplete: 0, anyAtK: 0, heavier: 0, proofComplete: 0, bestProofComplete: 0 }])) as Summary;
  for (const limit of limits) {
    const reference = exhaustiveReference(context, limit, candidates);
    const base = measureSelectionGap(context, limit, candidates, selectors.default, reference);
    for (const name of names) {
      const row = summary[name];
      let gap;
      try { gap = name === "default" ? base : measureSelectionGap(context, limit, candidates, selectors[name], reference); }
      catch (error) { if (!(error instanceof SourceSemanticResourceExhausted)) throw error; row.exhausted++; continue; }
      const delta = gap.selected.objective.map((value, index) => value - base.selected.objective[index]!).find(value => value !== 0) ?? 0;
      if (!gap.selector_is_optimal) row.suboptimal++;
      if (delta < 0) row.worseThanDefault++;
      if (delta > 0) row.betterThanDefault++;
      if (gap.selected.complete) row.complete++;
      if (gap.best_complete) row.bestComplete++;
      if (gap.selected.any_at_k) row.anyAtK++;
      if (gap.selected.proof_complete) row.proofComplete++;
      if (gap.best_proof_complete) row.bestProofComplete++;
      if (gap.selector_work.logical_work > base.selector_work.logical_work) row.heavier++;
    }
  }
  return { limits: limits.length, summary };
}

const scanSummary = (suboptimal: number, worseThanDefault: number, betterThanDefault: number, exhausted: number, complete: number,
  bestComplete: number, anyAtK: number, heavier: number, proofComplete: number, bestProofComplete: number) => ({ suboptimal,
  worseThanDefault, betterThanDefault, exhausted, complete, bestComplete, anyAtK, heavier, proofComplete, bestProofComplete });
const scans = [
  { name: "alternatives", limits: 22, expected: {
    default: scanSummary(4, 0, 0, 0, 3, 22, 22, 0, 3, 17), evidenceSet: scanSummary(12, 12, 2, 0, 17, 22, 22, 22, 17, 17),
    returnedTuple: scanSummary(4, 0, 0, 0, 3, 22, 22, 22, 3, 17) } },
  { name: "coverage", limits: 22, expected: {
    default: scanSummary(8, 0, 0, 0, 4, 22, 22, 0, 3, 3), evidenceSet: scanSummary(2, 0, 8, 2, 4, 20, 20, 20, 3, 3),
    returnedTuple: scanSummary(8, 0, 0, 0, 4, 22, 22, 22, 3, 3) } }
] as const;
// The full limit scans take about a minute each; they run only on request.
const scanEnabled = process.env["ALAYA_SELECTION_POLICY_SCAN"] === "1";
for (const row of scans) {
  it.skipIf(!scanEnabled)(`scans ${row.name} limits at every proof-subset size cluster for each selector`, async () => {
    await withContext(fixtures[row.name](), context => {
      const result = scan(context);
      expect(result.limits).toBe(row.limits);
      expect(result.summary).toEqual(row.expected);
    });
  }, 600_000);
}
