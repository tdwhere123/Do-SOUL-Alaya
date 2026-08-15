import { describe, expect, it } from "vitest";
import {
  resolveExtractionFillProviderTimeBudget
} from "../../../longmemeval/extraction/fill/policy/provider-time-budget.js";

describe("extraction provider time budget", () => {
  it("keeps the default budget for one output-token quantum", () => {
    expect(resolveExtractionFillProviderTimeBudget()).toEqual({
      requestTimeoutMs: 60_000,
      providerWallClockBudgetMs: 333_000
    });
    expect(resolveExtractionFillProviderTimeBudget(2_048)).toEqual({
      requestTimeoutMs: 60_000,
      providerWallClockBudgetMs: 333_000
    });
  });

  it("scales from the authority-bound output ceiling without wall-clock waiting", () => {
    expect(resolveExtractionFillProviderTimeBudget(8_192)).toEqual({
      requestTimeoutMs: 240_000,
      providerWallClockBudgetMs: 1_233_000
    });
    expect(resolveExtractionFillProviderTimeBudget(16_384)).toEqual({
      requestTimeoutMs: 480_000,
      providerWallClockBudgetMs: 2_433_000
    });
  });
});
