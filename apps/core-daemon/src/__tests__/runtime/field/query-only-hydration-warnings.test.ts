import { describe, expect, it } from "vitest";
import type { ConditionalFieldRecallPortResult } from "@do-soul/alaya-core";
import { conditionalRecallPayload, createQueryOnlyHydrationHarness, dispatchQueryOnly,
  persistConditionalSource } from "./query-only-hydration-fixture.js";

const hydration = createQueryOnlyHydrationHarness();

describe("query-only conditional resource outcomes", () => {
  it("refuses unretainable delivery without exposing source content or inventing complete-empty hydration", async () => {
    const fixture = hydration.openQueryOnlyPair();
    const objectId = "88888888-8888-4888-8888-888888888888";
    await persistConditionalSource(fixture.writer, objectId, "nebulapivot published source");
    const payload = conditionalRecallPayload("nebulapivot");
    const full = await dispatchQueryOnly(fixture.queryOnlyRuntime, "conditionalField.recall", payload) as ConditionalFieldRecallPortResult;
    expect(full.index.entries.map((entry) => entry.object_id)).toContain(objectId);
    const limited = dispatchQueryOnly(fixture.queryOnlyRuntime, "conditionalField.recall", {
      ...payload, budget: { ...payload.budget, memory_bytes: 1 }
    });
    await expect(limited).rejects.toMatchObject({ code: "CONFLICT", details: {
      outcome: "resource_exhausted", resource: "delivery_retention"
    } });
    const failure = await limited.catch((error: unknown) => error);
    expect(JSON.stringify(failure)).not.toContain(objectId);
    expect(JSON.stringify(failure)).not.toContain("nebulapivot published source");
    expect(fixture.queryOnly.connection.pragma("query_only", { simple: true })).toBe(1);
  });
});
