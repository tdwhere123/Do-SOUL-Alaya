import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../../scripts/test-support/provider-free/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); });
afterAll(() => isolation.restore());
import { sourceSemanticAccessPhases } from "@do-soul/alaya-protocol";
import { ORIGINAL, QUERY_BUDGET, SIMULATED_CONFIGURATION, withIndexedSources, workerCall } from
  "./source-semantic-index-acquisition.test-support.js";

it("keeps vector ranking and scope denial through a real SQLite worker across 384 windows", async () => {
  const sources = [
    { id: "best", text: "aaaa".repeat(128), vector: [1, 0, 0] },
    { id: "middle", text: "bbbb".repeat(128), vector: [0, 1, 0] },
    { id: "secret", text: "cccc".repeat(128), vector: [-1, 0, 0], scope: "global_core" as const }
  ];
  await withIndexedSources(sources, async fixture => {
    const client = await fixture.openClient();
    const response = await workerCall(client, { kind: "prepare_query", original_query: ORIGINAL, budget: QUERY_BUDGET });
    const result = sourceSemanticAccessPhases(response.access!).acquisition.result!;
    expect(result.vector).toMatchObject({ completion: "complete", inspected_windows: 384, invalid_windows: 0 });
    expect(result.nominations.map(row => [row.source.source_id, row.vector?.rank, row.vector?.cosine]))
      .toEqual([["best", 1, 1], ["middle", 2, 0]]);
    expect(result.accounting).toMatchObject({ attempted: 3, admitted: 2, scope_denied: 1 });
    expect(result.resources.work).toBeLessThanOrEqual(QUERY_BUDGET.work_units);
    expect(result.resources.memory_bytes).toBeLessThanOrEqual(QUERY_BUDGET.memory_bytes);
    expect(response.access?.source_candidates.map(row => row.source_id)).toEqual(expect.arrayContaining(["best", "middle"]));
    expect(response.access?.source_candidates.some(row => row.source_id === "secret")).toBe(false);
  }, { ...SIMULATED_CONFIGURATION, profile: { ...SIMULATED_CONFIGURATION.profile, window_bytes: 4 } });
}, 120_000);
