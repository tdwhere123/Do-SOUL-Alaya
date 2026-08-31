import { describe, expect, it } from "vitest";
import {
  resolveExtractionFillProviderTimeBudget
} from "../../../runs/extraction/fill/policy/provider-time-budget.js";
import { EXTRACTION_REQUEST_TIMEOUT_MS } from
  "../../../runs/compile-seed/compile-seed-http.js";
import { EXTRACTION_FILL_TRANSPORT_ATTEMPTS_PER_MISSING_SHARD } from
  "../../../runs/extraction/authority/receipt-limits.js";

describe("extraction provider time budget", () => {
  it("keeps the default budget for one output-token quantum", () => {
    const defaultBudget = resolveExtractionFillProviderTimeBudget();
    expect(defaultBudget).toEqual(resolveExtractionFillProviderTimeBudget(2_048));
    expect(defaultBudget.requestTimeoutMs).toBe(EXTRACTION_REQUEST_TIMEOUT_MS);
    expect(defaultBudget.providerWallClockBudgetMs).toBeGreaterThan(
      defaultBudget.requestTimeoutMs * EXTRACTION_FILL_TRANSPORT_ATTEMPTS_PER_MISSING_SHARD
    );
  });

  it("scales from the authority-bound output ceiling without wall-clock waiting", () => {
    const base = resolveExtractionFillProviderTimeBudget(2_048);
    const overhead = base.providerWallClockBudgetMs -
      base.requestTimeoutMs * EXTRACTION_FILL_TRANSPORT_ATTEMPTS_PER_MISSING_SHARD;
    for (const multiplier of [4, 8]) {
      const budget = resolveExtractionFillProviderTimeBudget(2_048 * multiplier);
      expect(budget.requestTimeoutMs).toBe(EXTRACTION_REQUEST_TIMEOUT_MS * multiplier);
      expect(budget.providerWallClockBudgetMs).toBe(
        budget.requestTimeoutMs * EXTRACTION_FILL_TRANSPORT_ATTEMPTS_PER_MISSING_SHARD + overhead
      );
    }
  });
});
