import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => isolation.restore());
import { RecallService, capableRecallConsumerDeclaration } from "@do-soul/alaya-core";
import { prepareIndexedRecallProjection } from "@do-soul/alaya-storage";
import { createDependencies, createTaskSurface } from "../../../../../../packages/core/src/__tests__/recall/recall-service-test-fixtures.js";
import { CLOCK, WS, withIndexedSources, QUERY_BUDGET } from "./source-semantic-index-acquisition.test-support.js";

it("ordinary Core entry prepares the original query before its compiled worker snapshot and delivers native source text", async () => {
  await withIndexedSources([
    { id: "unrelated", text: "Cobalt paints dry overnight.", vector: [0, 1, 0] },
    { id: "harbor", text: "Harbor opening was delayed by the storm.", vector: [1, 0, 0] }
  ], async fixture => {
    prepareIndexedRecallProjection(fixture.database);
    const client = await fixture.openClient();
    const service = new RecallService({ ...createDependencies(), now: () => CLOCK,
      readSnapshot: client.readSnapshot, conditionalFieldPort: client.conditionalFieldPort,
      activeConstraintsPort: client.activeConstraintsPort });
    const result = await service.recall({ workspaceId: WS, taskSurface: createTaskSurface(), strategy: "chat",
      queryText: "Harbor", budget: { ...QUERY_BUDGET, page_budget: 2 },
      ...capableRecallConsumerDeclaration(), result_kind_view: "mixed" });
    expect(fixture.queryBinding.embedInputs).toHaveBeenCalledTimes(1);
    expect(fixture.queryBinding.embedInputs.mock.calls[0]?.[0]?.[0]?.text).toBe("Harbor");
    expect(result.index.result_version).toBe("ordinary-native-field.v2");
    expect(result.index.entries[0]).toMatchObject({ target: { kind: "source_evidence" },
      navigation: { operator: "source_lexical" }, claim: "unknown" });
    expect(result.candidates[0]?.content_preview).toContain("Harbor opening");
    expect(result.index.entries.every(entry => entry.target.kind !== "source_evidence" || entry.object_id === undefined)).toBe(true);
  });
});
