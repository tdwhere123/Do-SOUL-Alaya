// @ts-nocheck
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SOURCE_STATEMENTS_PROMPT } from "@do-soul/alaya-soul";
import { expect, it, vi } from "vitest";
import {
  type BenchSignalExtractor
} from "../../../runs/compile-seed.js";
import {
  EXTRACTION_FILL_PROVIDER_WALL_CLOCK_BUDGET_MS,
  runExtractionPool
} from "../../../runs/extraction/fill/fill-pool.js";
import { listExtractionAttemptLedgerRecords } from "../../../runs/extraction/authority/attempt-ledger.js";
import { newFillStats } from "../../../runs/extraction/fill/fill-stats.js";
import {
  TEST_EXTRACTION_PROVIDER_URL,
  writeExtractionCacheTestManifest
} from "./extraction-cache-test-fixture.js";
import { authorizedHttpExtractor } from "../extraction-fill/authority-runtime/fixture.js";
import {
  cachingExtractor,
  emptyStatementResponse,
  deferred,
  extractionTurns,
  flushMicrotasks,
  groundedTurns,
  retryResult,
  waitFor
} from "./fill-pool/fixture.js";

it("preserves captured roles and unknown time in the session request", async () => {
  const extract = vi.fn<BenchSignalExtractor["extract"]>(async input => ({
    rawJson: emptyStatementResponse(input.userPrompt)
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

  expect(extract).toHaveBeenCalledOnce();
  expect(extract.mock.calls[0]![0]).toMatchObject({ systemPrompt: SOURCE_STATEMENTS_PROMPT, retryMode: "disabled" });
  expect(JSON.parse(extract.mock.calls[0]![0].userPrompt)).toMatchObject({
    contract: "source-statements-v1", context: [], messages: [
      { message_id: "q1-m0", role: "user", recorded_at: null, text: "I moved to Berlin." },
      { message_id: "q1-m1", role: "assistant", recorded_at: null, text: "That sounds exciting." }
    ]
  });
});

it("keeps complete preceding context in bounded session requests", async () => {
  const requests: { targets: string[]; context: string[] }[] = [];
  const extract = vi.fn<BenchSignalExtractor["extract"]>(async input => {
    const request = JSON.parse(input.userPrompt);
    requests.push({ targets: request.messages.map(message => message.message_id),
      context: request.context.map(message => message.message_id) });
    return { rawJson: emptyStatementResponse(input.userPrompt) };
  });
  const messages = [{ message_id: "first", role: "user", content: "a".repeat(15_000) },
    { message_id: "second", role: "assistant", content: "b".repeat(20_000) }];

  await runExtractionPool({
    extractor: { extract },
    turns: [{ turnContent: messages.map(message => message.content).join("\n"), turnMessages: messages }],
    concurrency: 1,
    requestedTurns: 1,
    stats: newFillStats(),
    log: () => undefined
  });

  expect(requests).toEqual([
    { targets: ["first"], context: [] },
    { targets: ["second"], context: ["first"] }
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
        readonly messages: readonly { readonly text: string }[];
      };
      if (turn.messages.some(({ text }) => text.includes("clean"))) {
        cleanStarted.resolve();
        await releaseClean.promise;
        return {
          rawJson: emptyStatementResponse(input.userPrompt),
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
        rawJson: emptyStatementResponse(input.userPrompt),
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
      extract: vi.fn(async input => retryResult(calls++ === 0 ? 1 : 0, input))
    },
    turns: extractionTurns(4),
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

it("accepts a completed empty statement result without retry or pressure",  async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "fill-pool-empty-recheck-"));
  const stats = newFillStats();
  try {
    writeExtractionCacheTestManifest({
      cacheRoot,
      model: "test-model",
      providerUrl: TEST_EXTRACTION_PROVIDER_URL,
      requestProfile: "provider-default-v1",
      systemPrompt: SOURCE_STATEMENTS_PROMPT
    });
    const delegate = authorizedHttpExtractor({
      response: emptyStatementResponse
    }).factory({ model: "test-model", modelFamily: "test-model",
      providerUrl: TEST_EXTRACTION_PROVIDER_URL, requestProfile: "provider-default-v1", apiKey: "fixture-key" });
    await runExtractionPool({
      extractor: cachingExtractor(cacheRoot, delegate, stats),
      turns: groundedTurns(),
      concurrency: 1,
      requestedTurns: 1,
      stats,
      log: () => undefined
    });

    expect(delegate.extract).toHaveBeenCalledTimes(1);
    expect(delegate.extract.mock.calls[0]![0].retryMode).toBe("disabled");
    expect(stats).toMatchObject({ llmCalls: 1,
      rateLimitRetries: 0, adaptiveConcurrencyBackoffs: 0, adaptiveConcurrencyBackoffMs: 0
    });
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

it("refuses a physical 429 without redispatching the session request",  async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "fill-pool-recovered-rate-limit-"));
  const stats = newFillStats();
  try {
    writeExtractionCacheTestManifest({
      cacheRoot,
      model: "test-model",
      providerUrl: TEST_EXTRACTION_PROVIDER_URL,
      requestProfile: "provider-default-v1",
      systemPrompt: SOURCE_STATEMENTS_PROMPT
    });
    const delegate = authorizedHttpExtractor({ rateLimitRetries: 1 }).factory({
      model: "test-model", modelFamily: "test-model", providerUrl: TEST_EXTRACTION_PROVIDER_URL,
      requestProfile: "provider-default-v1", apiKey: "fixture-key"
    });
    const extractor = cachingExtractor(cacheRoot, delegate, stats);

    await expect(runExtractionPool({
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
    })).rejects.toThrow("terminal task failure");

    expect(delegate.extract).toHaveBeenCalledOnce();
    expect(delegate.extract.mock.calls[0]![0].retryMode).toBe("disabled");
    // The legacy pressure counter includes the terminal 429; physical attempts are ledger-owned.
    expect(stats).toMatchObject({ llmCalls: 0, rateLimitRetries: 1 });
    expect(listExtractionAttemptLedgerRecords(cacheRoot)).toEqual([
      expect.objectContaining({ attempts: 1, successful_shards: [] })
    ]);
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

it("starts at the explicit initial concurrency before recovering toward the maximum", async () => {
  const firstWave = deferred<void>();
  const secondWave = deferred<void>();
  let started = 0;
  const extractor: BenchSignalExtractor = {
    extract: vi.fn(async input => {
      started += 1;
      if (started <= 8) await firstWave.promise;
      else if (started <= 17) await secondWave.promise;
      return { rawJson: emptyStatementResponse(input.userPrompt) };
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
      extract: vi.fn(async input => {
        started += 1;
        if (started <= 8) {
          await firstWave.promise;
          return retryResult(1, input);
        }
        if (started <= 16) await secondWave.promise;
        return retryResult(0, input);
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

it("refuses interactive fill when a request exceeds the receipt input-token bound", async () => {
  const extract = vi.fn<BenchSignalExtractor["extract"]>(async () => ({
    rawJson: '{"interpretations":[]}'
  }));
  await expect(runExtractionPool({
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
    log: () => undefined,
    transport: {
      retryMode: "disabled",
      maxOutputTokens: 512,
      outputTokenField: "max_tokens",
      maximumInputTokensPerAttempt: 1
    }
  })).rejects.toThrow(/authority input-token bound/u);
  expect(extract).not.toHaveBeenCalled();
});
