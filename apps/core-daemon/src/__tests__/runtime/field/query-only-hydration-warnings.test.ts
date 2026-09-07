import { describe, expect, it } from "vitest";
import type { ConditionalFieldRecallPortResult } from "@do-soul/alaya-core";
import { conditionalRecallPayload, createQueryOnlyHydrationHarness, dispatchQueryOnly,
  persistConditionalSource } from "./query-only-hydration-fixture.js";

const hydration = createQueryOnlyHydrationHarness();

describe("query-only conditional resource outcomes", () => {
  it("reports a bounded open outcome instead of inventing complete-empty hydration", async () => {
    const fixture = hydration.openQueryOnlyPair();
    const objectId = "88888888-8888-4888-8888-888888888888";
    await persistConditionalSource(fixture.writer, objectId, "nebulapivot published source");
    const payload = conditionalRecallPayload("nebulapivot");
    const full = await dispatchQueryOnly(fixture.queryOnlyRuntime, "conditionalField.recall", payload) as ConditionalFieldRecallPortResult;
    expect(full.index.entries.map((entry) => entry.object_id)).toContain(objectId);
    const limited = await dispatchQueryOnly(fixture.queryOnlyRuntime, "conditionalField.recall", {
      ...payload, budget: { ...payload.budget, memory_bytes: 1 }
    }) as ConditionalFieldRecallPortResult;
    expect(limited.index.completeness.logical_index).not.toBe("complete");
    expect(limited.index.completeness.observed_coverage).not.toBe("exhausted_empty");
    expect(fixture.queryOnly.connection.pragma("query_only", { simple: true })).toBe(1);
  });
});
