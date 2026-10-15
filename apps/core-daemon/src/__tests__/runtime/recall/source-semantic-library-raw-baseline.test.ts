import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); });
afterAll(() => { isolation.restore(); });
import { indexEntryCacheKey } from "@do-soul/alaya-protocol";
import type { SourceSemanticLibraryPackage } from "@do-soul/alaya-core";
import { alternativeSelectionFixture, physicalRoot, rawSourceTwin, selectionExecutionBudget }
  from "../../../../../../packages/core/src/__tests__/recall/runtime/source-semantic-selection-fixture.js";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { prepareLibraryPackages } from "../../../runtime/recall-read-worker/source-semantic-library-packages.js";
import { deliverAllPages, measureNativeSubset, nativeSubsetContext, roomyDeliveryBytes,
  type NativeMeasurement, type NativeSubsetContext } from "./source-semantic-library-subset-packing.test-support.js";

/** Raw-only page B0 shares the pool, slots, encoder byte limit and access order with the semantic library page. */
async function withContext(run: (context: NativeSubsetContext, name: (row: SourceSemanticLibraryPackage) => string) => void | Promise<void>) {
  const fixture = alternativeSelectionFixture(selectionExecutionBudget);
  const context = await nativeSubsetContext(fixture);
  const name = (row: SourceSemanticLibraryPackage) =>
    fixture.sources.find(source => physicalRoot(source.package) === physicalRoot(row))!.id;
  try { await run(context, name); } finally { await context.close(); }
}

const twins = (context: NativeSubsetContext) => context.fixture.pool.map(rawSourceTwin);
const withProofs = (context: NativeSubsetContext) => context.fixture.pool.flatMap(row => [rawSourceTwin(row), row]);

/** Every delivered slot across the frozen continuation chain, as the consumer receives it. */
function chain(context: NativeSubsetContext, measurement: NativeMeasurement,
  name: (row: SourceSemanticLibraryPackage) => string) {
  return deliverAllPages(context, measurement).flatMap((page, index) => measurement.plan.pages[index]!.map((row, slot) => ({
    page: index, root: name(row), preview: page.previews?.[indexEntryCacheKey(row.entry)],
    payload_support: page.slot_qualifiers[slot]!.payload_support, proof_use: page.source_disclosures[indexEntryCacheKey(row.entry)]!.proof_use.kind,
    proof_count: row.proofs.length
  })));
}
const firstPage = (rows: ReturnType<typeof chain>) => rows.filter(row => row.page === 0).map(row => row.root).sort();
const byRoot = (rows: ReturnType<typeof chain>) => Object.fromEntries(rows.map(row => [row.root, row]));
const ALL_ROOTS = ["backup", "backup-compatible", "checks-left", "checks-right", "permission"];

it("keeps raw packages and the delivered page unchanged when every executed proof is unavailable", async () => {
  await withContext(async (context, name) => {
    const sources = context.fixture.pool.map(row => rawSourceTwin(row).entry);
    const prepare = (failing: boolean) => prepareLibraryPackages(context.runtime,
      { workspace_id: "ws", as_of: "2026-09-18T00:00:00.000Z", authorized_scopes: { mode: "named", scopes: ["project"] } } as never,
      ["project"], new SourceSemanticReadBudget(selectionExecutionBudget), sources,
      failing ? context.fixture.sources.map(source => ({ proof: source.package.proofs[0]!, group: source.package,
        source: source.body, dependencies: [] })) : []);
    const baseline = prepare(false), failed = prepare(true);
    expect(baseline.incomplete).toBe(false); expect(failed.incomplete).toBe(false);
    expect(baseline.packages).toHaveLength(5); expect(failed.packages).toHaveLength(5);
    for (const [index, row] of failed.packages.entries()) {
      expect(row.proofs).toHaveLength(0);
      expect(row.payload_support).toBe("no_dependencies");
      expect(baseline.packages[index]!.payload_support).toBe("not_applicable");
      expect({ ...row, payload_support: undefined }).toEqual({ ...baseline.packages[index]!, payload_support: undefined });
    }
    for (const limit of [20_000, roomyDeliveryBytes]) {
      const b0 = chain(context, measureNativeSubset(context, limit, undefined, baseline.packages), name);
      const actual = chain(context, measureNativeSubset(context, limit, undefined, failed.packages), name);
      expect(actual.map(row => [row.page, row.root, row.preview, row.proof_use]))
        .toEqual(b0.map(row => [row.page, row.root, row.preview, row.proof_use]));
      expect(actual.every(row => row.proof_use === "source_only" && row.payload_support === "no_dependencies")).toBe(true);
    }
    expect(baseline.packages.map(row => Buffer.byteLength(row.preview))).toEqual(
      context.fixture.sources.map(source => Buffer.byteLength(source.body)));
  });
});

it("delivers the raw-only page with visible proof omission when no proof fits the byte limit", async () => {
  await withContext(async (context, name) => {
    const single = (row: SourceSemanticLibraryPackage) => measureNativeSubset(context, roomyDeliveryBytes, undefined, [row]).encoded_bytes;
    const smallestProof = Math.min(...context.fixture.pool.map(single));
    const b0Bytes = measureNativeSubset(context, roomyDeliveryBytes, undefined, twins(context)).encoded_bytes;
    const limit = Math.floor((b0Bytes + smallestProof) / 2);
    expect(b0Bytes).toBeLessThan(limit); expect(limit).toBeLessThan(smallestProof);
    const b0 = measureNativeSubset(context, limit, undefined, twins(context));
    const mixed = measureNativeSubset(context, limit, undefined, withProofs(context));
    expect(b0.plan.pages).toHaveLength(1);
    const expected = chain(context, b0, name), actual = chain(context, mixed, name);
    expect(firstPage(expected)).toEqual(ALL_ROOTS);
    expect(firstPage(actual)).toEqual(ALL_ROOTS);
    expect(actual.map(row => [row.root, row.preview])).toEqual(expected.map(row => [row.root, row.preview]));
    expect(mixed.native.proofs).toBeUndefined();
    for (const row of actual) {
      expect(row.proof_count).toBe(0); expect(row.proof_use).toBe("source_only");
      expect(row.payload_support).toBe("envelope_budget");
    }
  });
});

it("moves other raw roots to continuation pages when a proof fits alone but not beside them", async () => {
  await withContext(async (context, name) => {
    const proofBytes = context.fixture.pool.map(row => measureNativeSubset(context, roomyDeliveryBytes, undefined, [row]).encoded_bytes);
    const limit = Math.min(...proofBytes) + 1_000;
    expect(limit).toBeLessThan(Math.max(...proofBytes));
    const b0 = measureNativeSubset(context, limit, undefined, twins(context));
    const mixed = measureNativeSubset(context, limit, undefined, withProofs(context));
    const expected = chain(context, b0, name), actual = chain(context, mixed, name);
    expect(b0.plan.pages).toHaveLength(1);
    expect(mixed.plan.pages.length).toBeGreaterThan(1);
    // A standalone-fitting proof replaces its raw twin and takes first-page bytes ahead of other roots' raw packages.
    expect(firstPage(actual)).toEqual(["permission"]);
    expect(firstPage(expected)).toEqual(ALL_ROOTS);
    expect(actual.map(row => row.root).sort()).toEqual(ALL_ROOTS);
    for (const row of actual) {
      expect(row.preview).toBe(byRoot(expected)[row.root]!.preview);
      if (row.proof_count === 0) { expect(row.proof_use).toBe("source_only"); expect(row.payload_support).toBe("envelope_budget"); }
      else expect(row.proof_use).toBe("conditional_support");
    }
    expect(actual.some(row => row.proof_count > 0)).toBe(true);
  });
});

it("attaches every proof to the raw-only first-page membership when all proofs fit", async () => {
  await withContext(async (context, name) => {
    const b0 = chain(context, measureNativeSubset(context, roomyDeliveryBytes, undefined, twins(context)), name);
    const actual = chain(context, measureNativeSubset(context, roomyDeliveryBytes, undefined, withProofs(context)), name);
    expect(firstPage(actual)).toEqual(firstPage(b0));
    expect(actual.every(row => row.page === 0 && row.proof_count > 0 && row.proof_use === "conditional_support")).toBe(true);
    expect(actual.map(row => [row.root, row.preview]).sort()).toEqual(b0.map(row => [row.root, row.preview]).sort());
  });
});
