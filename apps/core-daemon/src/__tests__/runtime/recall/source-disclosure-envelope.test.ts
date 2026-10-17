import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); });
afterAll(() => { isolation.restore(); });
import { alternativeSelectionFixture, selectionExecutionBudget }
  from "../../../../../../packages/core/src/__tests__/recall/runtime/source-semantic-selection-fixture.js";
import { assertNativeSupport, measureNativeSubset, nativeSubsetContext } from "./source-semantic-library-subset-packing.test-support.js";

it("retains both complementary check witnesses in the original complete-envelope cap", async () => {
  const authored = alternativeSelectionFixture(selectionExecutionBudget);
  const fixture = { ...authored, sources: authored.sources.slice(0, 4), pool: authored.pool.slice(0, 4) };
  const context = await nativeSubsetContext(fixture);
  try {
    const result = measureNativeSubset(context, 176_340);
    assertNativeSupport(fixture, result);
    expect(result.selected_sources).toEqual(["checks-left", "checks-right"]);
    expect(result.support).toMatchObject({ supported_inputs: [3, 4, 5, 6], complete_alternatives: 0 });
    expect(result.reserved_bytes).not.toBeNull();
    expect(result.reserved_bytes!).toBeLessThanOrEqual(176_340);
    expect(result.encoded_bytes).toBeLessThanOrEqual(176_340);
    expect(result.native.index.continuation).not.toBeNull();
  } finally { await context.close(); }
}, 60_000);
