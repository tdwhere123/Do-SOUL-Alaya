// @ts-nocheck
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import { expect, it, vi } from "vitest";
import {
  createCachingSignalExtractor,
  type BenchSignalExtractor
} from "../../../bench/compile-seed.js";
import {
  EXTRACTION_FILL_PROVIDER_WALL_CLOCK_BUDGET_MS,
  runExtractionPool
} from "../../../bench/extraction/fill/fill-pool.js";
import { newFillStats } from "../../../bench/extraction/fill/fill-stats.js";
import {
  providerBackedExtractionResult,
  TEST_EXTRACTION_PROVIDER_URL,
  writeExtractionCacheTestManifest
} from "./extraction-cache-test-fixture.js";
import { buildGroundedSignalResponse } from "../extraction-fill/fixture.js";
import {
  cachingExtractor,
  deferred,
  extractionTurns,
  flushMicrotasks,
  groundedTurns,
  retryResult,
  waitFor
} from "./fill-pool/fixture.js";

it("uses the compact production extraction request", async () => {
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
    readonly schema_version?: number;
    readonly source_locator_contract_version?: number;
    readonly source_assertions?: readonly { readonly text: string }[];
  };
  expect(request.schema_version).toBe(2);
  expect(request.source_locator_contract_version).toBe(2);
  expect(request.source_assertions).toEqual([
    { assertion_id: 1, text: "User: I moved to Berlin." }
  ]);
  expect(JSON.stringify(request)).not.toContain("Assistant");
});

it("extracts every source assertion through bounded request batches", async () => {
  const requests: number[][] = [];
  const extract = vi.fn<BenchSignalExtractor["extract"]>(async (input) => {
    const request = JSON.parse(input.userPrompt) as {
      readonly source_assertions: readonly { readonly assertion_id: number }[];
    };
    requests.push(request.source_assertions.map(({ assertion_id }) => assertion_id));
    return { rawJson: '{"signals":[]}' };
  });
  const source = Array.from(
    { length: 9 },
    (_, index) => `I recorded durable detail number ${index + 1}.`
  ).join(" ");

  await runExtractionPool({
    extractor: { extract },
    turns: [{ turnContent: source, turnMessages: [] }],
    concurrency: 1,
    requestedTurns: 1,
    stats: newFillStats(),
    log: () => undefined
  });

  expect(requests).toEqual([
    [1, 2, 3, 4, 5, 6, 7, 8],
    [9]
  ]);
});

it("attributes a concurrent 429 backoff to its own task instead of shared run stats", async () => {
  const stats = newFillStats();
  const cleanStarted = deferred<void>();
  const limitedCompleted = deferred<void>();
  const releaseClean = deferred<void>();
  const extractor: BenchSignalExtractor = {
    extract: vi.fn(async (input) => {
      const turn = JSON.parse(input.userPrompt) as {
        readonly source_assertions: readonly { readonly text: string }[];
      };
      if (turn.source_assertions.some(({ text }) => text.includes("clean"))) {
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
        turnContent: "I am clean.",
        turnMessages: [{ message_id: "clean", role: "user", content: "I am clean." }]
      },
      {
        turnContent: "I am limited.",
        turnMessages: [{ message_id: "limited", role: "user", content: "I am limited." }]
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

it("backs a four-worker fill below its authority maximum after a 429", async () => {
  let calls = 0;
  const logs: string[] = [];
  await runExtractionPool({
    extractor: {
      extract: vi.fn(async () => retryResult(calls++ === 0 ? 1 : 0))
    },
    turns: Array.from({ length: 4 }, (_, index) => ({
      turnContent: `I saved durable detail ${index}.`,
      turnMessages: []
    })),
    concurrency: 4,
    requestedTurns: 4,
    stats: newFillStats(),
    log: (message) => logs.push(message)
  });

  expect(logs).toContain(
    "[extraction-fill] rate-limit backoff: concurrency=2/4 total_backoff_ms=250"
  );
});

it.each([
  ["semantic_factor_graph_missing", "semantic_factor_graph_missing"],
  ["semantic_factor_graph_required", "semantic_factor_graph_required"]
])("reports redacted %s without treating schema rejection as provider pressure", async (
  rejection,
  expectedReason
) => {
  const logs: string[] = [];
  const stats = newFillStats();
  const failure = Object.assign(
    new Error(
      "signals array contained no valid open semantic factor entries " +
        `(rejections=${rejection}:2)`
    ), {
    benchRetry: {
      retryCount: 4,
      rateLimitRetries: 0,
      retryClassification: "failure_max_retries" as const,
      transportFailures: [{
        kind: "response_schema_error" as const,
        phase: "response_schema" as const,
        httpStatus: null,
        fingerprint: "schema-fingerprint"
      }]
    }
  });

  await runExtractionPool({
    extractor: { extract: vi.fn(async () => await Promise.reject(failure)) },
    turns: extractionTurns(1),
    concurrency: 4,
    initialConcurrency: 1,
    requestedTurns: 1,
    stats,
    log: (message) => logs.push(message),
    tolerateProviderTaskFailures: true
  });

  expect(stats).toMatchObject({
    adaptiveConcurrencyBackoffs: 0,
    adaptiveConcurrencyBackoffMs: 0
  });
  expect(logs).toContain(
      "[extraction-fill] leaving provider failure for a later fill: " +
      "retry_classification=failure_max_retries " +
      `failure_reason=${expectedReason} processed_turns=1/1`
  );
  expect(logs.some((message) => message.includes("provider-pressure backoff"))).toBe(false);
});

it("reports a first-pass 429 through a strict-empty cache recheck", async () => {
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
      extract: vi.fn<BenchSignalExtractor["extract"]>()
        .mockResolvedValueOnce(retryResult(1))
        .mockResolvedValueOnce(retryResult(0))
    };
    await runExtractionPool({
      extractor: cachingExtractor(cacheRoot, delegate, stats),
      turns: groundedTurns(),
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
      extract: vi.fn<BenchSignalExtractor["extract"]>()
        .mockResolvedValueOnce(retryResult(1))
        .mockRejectedValueOnce(terminalFailure)
    };
    await runExtractionPool({
      extractor: cachingExtractor(cacheRoot, delegate, stats),
      turns: groundedTurns(),
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

it("reports a recovered 429 from the accepted response to adaptive concurrency", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "fill-pool-recovered-rate-limit-"));
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
        .mockImplementationOnce(async (input) => providerBackedExtractionResult(
          buildGroundedSignalResponse(input.userPrompt), {
          extractorMeta: {
            recoveryKind: "none",
            retryCount: 1,
            retryClassification: "success_after_retry",
            rateLimitRetries: 1
          }
        }))
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

    expect(delegate.extract).toHaveBeenCalledOnce();
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
    turnContent: `I remember turn-${index}.`,
    turnMessages: [{ message_id: `m-${index}`, role: "user" as const, content: `I remember turn-${index}.` }]
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

it("backs the 100Q extraction pool below its initial concurrency after a 429", async () => {
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
    expect(started).toBe(12);

    secondWave.resolve();
    await running;
  } finally {
    vi.useRealTimers();
  }
});

it("honors the derived provider wall-clock budget", async () => {
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
