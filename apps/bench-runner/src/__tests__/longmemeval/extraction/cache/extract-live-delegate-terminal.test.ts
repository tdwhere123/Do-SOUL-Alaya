import { describe, expect, it } from "vitest";
import { emptyBenchTerminalRetryClassifications } from
  "../../../../bench/compile-seed/compile-seed-types.js";
import { extractLiveDelegate } from
  "../../../../bench/extraction/cache/cache-live-delegate.js";
import { newFillStats } from "../../../../bench/extraction/fill/fill-stats.js";

describe("extractLiveDelegate terminal classification", () => {
  it("counts failure_non_retryable_response on the completed empty map", async () => {
    const stats = newFillStats();
    expect(stats.terminalRetryClassifications).toEqual(
      emptyBenchTerminalRetryClassifications()
    );
    const cause = Object.assign(new Error("parse"), {
      benchRetry: {
        retryCount: 0,
        rateLimitRetries: 0,
        retryClassification: "failure_non_retryable_response" as const,
        transportFailures: []
      }
    });
    await expect(extractLiveDelegate({
      delegate: { extract: async () => await Promise.reject(cause) },
      request: { systemPrompt: "s", userPrompt: "u" },
      stats,
      onFailure: () => undefined
    })).rejects.toBe(cause);
    expect(stats.terminalRetryClassifications).toEqual({
      ...emptyBenchTerminalRetryClassifications(),
      failure_non_retryable_response: 1
    });
  });
});
