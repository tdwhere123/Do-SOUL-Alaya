import { describe, expect, it, vi } from "vitest";
import {
  CLOCK,
  createPlantedRecall,
  readProjectionPinReleases,
  recallRequest
} from "./p217-planted-harness.js";
import { createQueryOnlyHydrationHarness } from "./query-only-hydration-fixture.js";

const hydration = createQueryOnlyHydrationHarness();

describe("query-only dispatch pin recovery", () => {
  it("releases the main-thread pin when query-only findByEvidenceRefs rejects", async () => {
    const fixture = await hydration.openHydrationFixture();
    vi.spyOn(fixture.queryOnlyRuntime.memoryEntryRepo, "findByEvidenceRefs")
      .mockRejectedValue(new Error("query-only evidence memory load failure"));

    await expect(createPlantedRecall({
      database: fixture.writer,
      field: fixture.field,
      memoryRepo: fixture.dispatchedMemoryPort
    }).recall(recallRequest("Ada"))).rejects.toThrow(/query-only evidence memory load failure/u);
    expect(readProjectionPinReleases(fixture.writer)).toEqual([CLOCK]);
  });
});
