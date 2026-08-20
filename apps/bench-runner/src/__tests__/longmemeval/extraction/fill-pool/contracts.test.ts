import { expect, it, vi } from "vitest";
import type { BenchSignalExtractor } from
  "../../../../bench/compile-seed.js";
import {
  ExtractionFillTaskError,
  runExtractionPool
} from "../../../../bench/extraction/fill/fill-pool.js";
import { newFillStats } from
  "../../../../bench/extraction/fill/fill-stats.js";

it("retains the originating task failure for terminal fill diagnostics", () => {
  const cause = new Error("semantic graph validation failed");
  const error = new ExtractionFillTaskError({
    retryClassification: "unknown",
    retrySuccesses: 0,
    rateLimitRetries: 0,
    processedTurns: 6,
    requestedTurns: 13_998,
    cause
  });

  expect(error.cause).toBe(cause);
});

it("does not require a semantic factor graph on the fill HTTP validator", async () => {
  const graphless = JSON.stringify({
    signals: [{
      object_kind: "fact",
      confidence: 0.8,
      matched_text: "The build is green."
    }]
  });
  const extract = vi.fn<BenchSignalExtractor["extract"]>(async (input) => {
    expect(() => input.validateRawJson?.(graphless)).not.toThrow();
    return { rawJson: graphless };
  });
  const logs: string[] = [];

  await runExtractionPool({
    extractor: { extract },
    turns: [{
      turnContent: "User: The build is green.\nAssistant: Noted.",
      turnMessages: [
        { message_id: "q1-m0", role: "user", content: "The build is green." },
        { message_id: "q1-m1", role: "assistant", content: "Noted." }
      ]
    }],
    concurrency: 1,
    requestedTurns: 1,
    stats: newFillStats(),
    log: (message) => logs.push(message),
    tolerateProviderTaskFailures: true
  });

  expect(extract).toHaveBeenCalledOnce();
  expect(logs.some((line) => line.includes("leaving provider failure"))).toBe(false);
});
