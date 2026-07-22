import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import { expect, it, vi } from "vitest";
import {
  createCachingSignalExtractor,
  type BenchSignalExtractor
} from "../../../longmemeval/compile-seed.js";
import {
  EXTRACTION_FILL_PROVIDER_WALL_CLOCK_BUDGET_MS,
  runExtractionPool
} from "../../../longmemeval/extraction/fill/fill-pool.js";
import { newFillStats } from "../../../longmemeval/extraction/fill/fill-stats.js";
import {
  TEST_EXTRACTION_PROVIDER_URL,
  writeExtractionCacheTestManifest
} from "./extraction-cache-test-fixture.js";

it("uses the production request envelope with trusted round roles", async () => {
  const extract = vi.fn<BenchSignalExtractor["extract"]>(async () => ({
    rawJson: '{"signals":[]}'
  }));

  await runExtractionPool({
    extractor: { extract },
    turns: [{
      turnContent: "User: I moved to Berlin.\nAssistant: That sounds exciting.",
      turnMessages: [
        { message_id: "q1-m0", role: "user", content: "I moved to Berlin." },
        { message_id: "q1-m1", role: "assistant", content: "That sounds exciting." }
      ]
    }],
    concurrency: 1,
    requestedTurns: 1,
    stats: newFillStats(),
    log: () => undefined
  });

  const request = JSON.parse(extract.mock.calls[0]![0].userPrompt) as {
    readonly source_locator_contract_version?: number;
    readonly source_assertions?: readonly { readonly text: string }[];
    readonly source_spans?: readonly { readonly role: string; readonly text: string }[];
  };
  expect(request.source_locator_contract_version).toBe(2);
  expect(request.source_assertions).toEqual([
    { assertion_id: 1, text: "User: I moved to Berlin." }
  ]);
  expect(request.source_spans).toEqual([
    { span_id: 1, role: "user", text: "User: I moved to Berlin." },
    { span_id: 2, role: "assistant", text: "Assistant: That sounds exciting." }
  ]);
});

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
    turns: [
      {
        turnContent: "clean",
        turnMessages: [{ message_id: "clean", role: "user", content: "clean" }]
      },
      {
        turnContent: "limited",
        turnMessages: [{ message_id: "limited", role: "user", content: "limited" }]
      }
    ],
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

it("reports a first-pass 429 through a strict-empty cache recheck to adaptive concurrency", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "fill-pool-empty-recheck-"));
  const stats = newFillStats();
  try {
    writeExtractionCacheTestManifest({
      cacheRoot,
      model: "test-model",
      providerUrl: TEST_EXTRACTION_PROVIDER_URL,
      requestProfile: "provider-default-v1",
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
    });
    const delegate: BenchSignalExtractor = {
      extract: vi
        .fn<BenchSignalExtractor["extract"]>()
        .mockResolvedValueOnce({
          rawJson: '{"signals":[]}',
          extractorMeta: {
            recoveryKind: "none",
            retryCount: 1,
            retryClassification: "success_after_retry",
            rateLimitRetries: 1
          }
        })
        .mockResolvedValueOnce({
          rawJson: '{"signals":[]}',
          extractorMeta: {
            recoveryKind: "none",
            retryCount: 0,
            retryClassification: "success_first_try",
            rateLimitRetries: 0
          }
        })
    };
    const extractor = createCachingSignalExtractor({
      delegate,
      config: {
        model: "test-model",
        modelFamily: "test-model",
        providerUrl: TEST_EXTRACTION_PROVIDER_URL,
        requestProfile: "provider-default-v1"
      },
      cacheRoot,
      stats
    });

    await runExtractionPool({
      extractor,
      turns: [{
        turnContent: "User: I completed the review today.",
        turnMessages: [{
          message_id: "q1-m0",
          role: "user",
          content: "I completed the review today."
        }]
      }],
      concurrency: 1,
      requestedTurns: 1,
      stats,
      log: () => undefined
    });

    expect(delegate.extract).toHaveBeenCalledTimes(2);
    expect(stats).toMatchObject({
      rateLimitRetries: 1,
      adaptiveConcurrencyBackoffs: 1,
      adaptiveConcurrencyBackoffMs: 250
    });
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

it("reports a first-pass 429 when the strict-empty recheck fails", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "fill-pool-empty-recheck-failure-"));
  const stats = newFillStats();
  try {
    writeExtractionCacheTestManifest({
      cacheRoot,
      model: "test-model",
      providerUrl: TEST_EXTRACTION_PROVIDER_URL,
      requestProfile: "provider-default-v1",
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
    });
    const terminalFailure = Object.assign(new Error("provider rejected recheck"), {
      benchRetry: {
        retryCount: 0,
        rateLimitRetries: 0,
        retryClassification: "failure_non_retryable_4xx" as const,
        transportFailures: []
      }
    });
    const delegate: BenchSignalExtractor = {
      extract: vi
        .fn<BenchSignalExtractor["extract"]>()
        .mockResolvedValueOnce({
          rawJson: '{"signals":[]}',
          extractorMeta: {
            recoveryKind: "none",
            retryCount: 1,
            retryClassification: "success_after_retry",
            rateLimitRetries: 1
          }
        })
        .mockRejectedValueOnce(terminalFailure)
    };
    const extractor = createCachingSignalExtractor({
      delegate,
      config: {
        model: "test-model",
        modelFamily: "test-model",
        providerUrl: TEST_EXTRACTION_PROVIDER_URL,
        requestProfile: "provider-default-v1"
      },
      cacheRoot,
      stats
    });

    await runExtractionPool({
      extractor,
      turns: [{
        turnContent: "User: I completed the review today.",
        turnMessages: [{
          message_id: "q1-m0",
          role: "user",
          content: "I completed the review today."
        }]
      }],
      concurrency: 1,
      requestedTurns: 1,
      stats,
      log: () => undefined,
      tolerateProviderTaskFailures: true
    });

    expect(delegate.extract).toHaveBeenCalledTimes(2);
    expect(stats).toMatchObject({
      rateLimitRetries: 1,
      adaptiveConcurrencyBackoffs: 1,
      adaptiveConcurrencyBackoffMs: 250
    });
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

it("starts at the explicit initial concurrency before recovering toward the maximum", async () => {
  const firstWave = deferred<void>();
  const secondWave = deferred<void>();
  let started = 0;
  const extractor: BenchSignalExtractor = {
    extract: vi.fn(async () => {
      started += 1;
      if (started <= 8) await firstWave.promise;
      else if (started <= 17) await secondWave.promise;
      return { rawJson: '{"signals":[]}' };
    })
  };
  const turns = Array.from({ length: 32 }, (_, index) => ({
    turnContent: `turn-${index}`,
    turnMessages: [{ message_id: `m-${index}`, role: "user" as const, content: `turn-${index}` }]
  }));

  const running = runExtractionPool({
    extractor,
    turns,
    concurrency: 32,
    initialConcurrency: 8,
    requestedTurns: turns.length,
    stats: newFillStats(),
    log: () => undefined
  });
  await waitFor(() => started === 8);
  expect(started).toBe(8);

  firstWave.resolve();
  await waitFor(() => started === 17);
  expect(started).toBe(17);
  secondWave.resolve();
  await running;
});

it("keeps the 100Q extraction pool at its initial-eight floor after a 429", async () => {
  vi.useFakeTimers();
  try {
    const firstWave = deferred<void>();
    const secondWave = deferred<void>();
    let started = 0;
    const extractor: BenchSignalExtractor = {
      extract: vi.fn(async () => {
        started += 1;
        if (started <= 8) {
          await firstWave.promise;
          return retryResult(1);
        }
        if (started <= 16) await secondWave.promise;
        return retryResult(0);
      })
    };
    const turns = extractionTurns(16);
    const running = runExtractionPool({
      extractor,
      turns,
      concurrency: 32,
      initialConcurrency: 8,
      requestedTurns: turns.length,
      stats: newFillStats(),
      log: () => undefined
    });
    await flushMicrotasks();
    expect(started).toBe(8);

    firstWave.resolve();
    await flushMicrotasks();
    expect(started).toBe(8);
    await vi.advanceTimersByTimeAsync(250);
    await flushMicrotasks();
    expect(started).toBe(16);

    secondWave.resolve();
    await running;
  } finally {
    vi.useRealTimers();
  }
});

it("gives one shard enough wall-clock budget for all five authorized attempts", async () => {
  expect(EXTRACTION_FILL_PROVIDER_WALL_CLOCK_BUDGET_MS).toBe(333_000);
  vi.useFakeTimers();
  try {
    const extractor: BenchSignalExtractor = {
      extract: vi.fn(async () => await new Promise(() => undefined))
    };
    let settled = false;
    const running = runExtractionPool({
      extractor,
      turns: extractionTurns(1),
      concurrency: 1,
      requestedTurns: 1,
      stats: newFillStats(),
      log: () => undefined
    }).finally(() => {
      settled = true;
    });
    const rejection = expect(running).rejects.toThrow(/terminal task failure/i);
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(EXTRACTION_FILL_PROVIDER_WALL_CLOCK_BUDGET_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
  } finally {
    vi.useRealTimers();
  }
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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not met");
}

function extractionTurns(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    turnContent: `turn-${index}`,
    turnMessages: [{
      message_id: `m-${index}`,
      role: "user" as const,
      content: `turn-${index}`
    }]
  }));
}

function retryResult(rateLimitRetries: number) {
  return {
    rawJson: '{"signals":[]}',
    extractorMeta: {
      recoveryKind: "none" as const,
      retryCount: rateLimitRetries,
      retryClassification: rateLimitRetries === 0
        ? "success_first_try" as const
        : "success_after_retry" as const,
      rateLimitRetries
    }
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}
