import { expect, it, vi } from "vitest";
import type { BenchSignalExtractor } from "../../../longmemeval/compile-seed/compile-seed-types.js";
import { runExtractionPool } from "../../../longmemeval/extraction/fill/fill-pool.js";
import { newFillStats } from "../../../longmemeval/extraction/fill/fill-stats.js";

it("attributes a concurrent 429 backoff to its own task instead of shared run stats", async () => {
  const stats = newFillStats();
  const cleanStarted = deferred<void>();
  const limitedCompleted = deferred<void>();
  const releaseClean = deferred<void>();
  const extractor: BenchSignalExtractor = {
    extract: vi.fn(async (input) => {
      const turn = JSON.parse(input.userPrompt) as { readonly turn_content: string };
      if (turn.turn_content === "clean") {
        cleanStarted.resolve();
        await releaseClean.promise;
        return {
          rawJson: '{"signals":[]}',
          extractorMeta: {
            recoveryKind: "none",
            retryCount: 0,
            retryClassification: "success_first_try",
            rateLimitRetries: 0
          } as const
        };
      }
      stats.rateLimitRetries = 1;
      limitedCompleted.resolve();
      return {
        rawJson: '{"signals":[]}',
        extractorMeta: {
          recoveryKind: "none",
          retryCount: 1,
          retryClassification: "success_after_retry",
          rateLimitRetries: 1
        } as const
      };
    })
  };

  const running = runExtractionPool({
    extractor,
    distinctTurns: ["clean", "limited"],
    concurrency: 2,
    requestedTurns: 2,
    stats,
    log: () => undefined
  });
  await Promise.all([cleanStarted.promise, limitedCompleted.promise]);
  releaseClean.resolve();
  await running;

  expect(stats).toMatchObject({
    rateLimitRetries: 1,
    adaptiveConcurrencyBackoffs: 1,
    adaptiveConcurrencyBackoffMs: 250
  });
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
