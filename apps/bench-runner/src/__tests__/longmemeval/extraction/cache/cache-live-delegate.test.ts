import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCachingSignalExtractor,
  type BenchSignalExtractor
} from "../../../../longmemeval/compile-seed.js";
import { cacheFilePath, computeCacheKey } from
  "../../../../longmemeval/compile-seed/compile-seed-cache.js";
import { extractLiveDelegate } from
  "../../../../longmemeval/extraction/cache/cache-live-delegate.js";
import { openExtractionAttemptLedger } from
  "../../../../longmemeval/extraction/authority/attempt-ledger.js";
import {
  TEST_EXTRACTION_PROVIDER_URL,
  writeExtractionCacheTestManifest
} from "../extraction-cache-test-fixture.js";

const MODEL = "test-model";
const SYSTEM_PROMPT = "test-system-prompt";
const REQUEST_PROFILE = "provider-default-v1" as const;

describe("extraction live delegate empty-result recheck", () => {
  let cacheRoot: string;

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "cache-live-delegate-"));
    writeExtractionCacheTestManifest({
      cacheRoot,
      model: MODEL,
      providerUrl: TEST_EXTRACTION_PROVIDER_URL,
      requestProfile: REQUEST_PROFILE,
      systemPrompt: SYSTEM_PROMPT
    });
  });

  afterEach(async () => {
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("rechecks one strict empty result once and persists only the terminal raw response", async () => {
    const terminalRaw = JSON.stringify({
      signals: [{
        signal_kind: "potential_claim",
        object_kind: "activity",
        confidence: 0.9,
        matched_text: "I completed the review today.",
        distilled_fact: "I completed the review today.",
        source_locator: {
          contract_version: 2,
          kind: "assertion_catalog",
          assertion_id: 1
        }
      }]
    });
    const delegate: BenchSignalExtractor = {
      extract: vi
        .fn<BenchSignalExtractor["extract"]>()
        .mockImplementationOnce(async (input) => {
          await input.onTransportAttempt?.(input.abortSignal);
          return { rawJson: '{"signals":[]}' };
        })
        .mockImplementationOnce(async (input) => {
          await input.onTransportAttempt?.(input.abortSignal);
          return { rawJson: terminalRaw };
        })
    };
    const onTransportAttempt = vi.fn(async () => undefined);
    const extractor = createCachingSignalExtractor({
      delegate,
      config: {
        model: MODEL,
        modelFamily: MODEL,
        providerUrl: TEST_EXTRACTION_PROVIDER_URL,
        requestProfile: REQUEST_PROFILE
      },
      cacheRoot,
      onTransportAttempt
    });

    const result = await extractor.extract({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: userPromptWithAssertions()
    });

    expect(delegate.extract).toHaveBeenCalledTimes(2);
    expect(delegate.extract).toHaveBeenNthCalledWith(2, expect.objectContaining({
      retryMode: "disabled"
    }));
    expect(onTransportAttempt).toHaveBeenCalledTimes(2);
    expect(result.rawJson).toBe(terminalRaw);

    const cacheKey = computeCacheKey(
      MODEL,
      REQUEST_PROFILE,
      SYSTEM_PROMPT,
      "I completed the review today."
    );
    const shardPath = cacheFilePath(cacheRoot, cacheKey);
    expect(existsSync(shardPath)).toBe(true);
    const shard = JSON.parse(readFileSync(shardPath, "utf8")) as {
      readonly raw_json: string;
    };
    expect(shard.raw_json).toBe(terminalRaw);
  });

  it("accepts a second strict empty result without a third request", async () => {
    const terminalRaw = '{ "signals": [] }\n';
    const delegate: BenchSignalExtractor = {
      extract: vi
        .fn<BenchSignalExtractor["extract"]>()
        .mockResolvedValueOnce({
          rawJson: '{"signals":[]}',
          usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 }
        })
        .mockResolvedValueOnce({
          rawJson: terminalRaw,
          extractorMeta: {
            recoveryKind: "none",
            retryCount: 0,
            retryClassification: "success_first_try",
            rateLimitRetries: 0
          },
          usage: { inputTokens: 20, outputTokens: 2, totalTokens: 22 },
          responseMetadata: { finishReason: "stop", maxOutputTokens: 256 }
        })
    };
    const onLiveExtractionOutcome = vi.fn();
    const extractor = createCachingSignalExtractor({
      delegate,
      config: extractionConfig(),
      cacheRoot,
      onLiveExtractionOutcome
    });

    const result = await extractor.extract({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: userPromptWithAssertions()
    });

    expect(delegate.extract).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      rawJson: terminalRaw,
      usage: { inputTokens: 20, outputTokens: 2, totalTokens: 22 },
      responseMetadata: { finishReason: "stop", maxOutputTokens: 256 }
    });
    expect(onLiveExtractionOutcome).toHaveBeenCalledTimes(2);
    expect(onLiveExtractionOutcome).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      {
        retryCount: 0,
        rateLimitRetries: 0,
        transportFailures: [],
        usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 }
      }
    );
    expect(onLiveExtractionOutcome).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      {
        retryCount: 0,
        rateLimitRetries: 0,
        transportFailures: [],
        usage: { inputTokens: 20, outputTokens: 2, totalTokens: 22 }
      }
    );

    const shard = readShard(cacheRoot);
    expect(shard.raw_json).toBe(terminalRaw);
    expect(shard.response_metadata?.usage).toEqual({
      input_tokens: 20,
      output_tokens: 2,
      total_tokens: 22
    });
  });

  it("throws a failed recheck and leaves no cache shard", async () => {
    const terminalFailure = new Error("recheck transport failed");
    const delegate: BenchSignalExtractor = {
      extract: vi.fn<BenchSignalExtractor["extract"]>(async (input) => {
        await input.onTransportAttempt?.(input.abortSignal);
        if (input.retryMode === "disabled") throw terminalFailure;
        return { rawJson: '{"signals":[]}' };
      })
    };
    const onTransportAttempt = vi.fn(async () => undefined);
    const onLiveExtractionFailed = vi.fn();
    const extractor = createCachingSignalExtractor({
      delegate,
      config: extractionConfig(),
      cacheRoot,
      onTransportAttempt,
      onLiveExtractionFailed
    });

    await expect(extractor.extract({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: userPromptWithAssertions()
    })).rejects.toBe(terminalFailure);

    expect(delegate.extract).toHaveBeenCalledTimes(2);
    expect(onTransportAttempt).toHaveBeenCalledTimes(2);
    expect(onLiveExtractionFailed).toHaveBeenCalledOnce();
    expect(existsSync(shardPath(cacheRoot))).toBe(false);
  });

  it("settles both strict-empty transports exactly once across a ledger reload", async () => {
    const lineageDigest = "9".repeat(64);
    const ledgerInput = {
      cacheRoot,
      lineageDigest,
      cacheIdentity: { model: MODEL, requestProfile: REQUEST_PROFILE },
      startingMissing: 1,
      maximumAttempts: 2,
      successfulShardCeiling: 1
    } as const;
    const ledger = openExtractionAttemptLedger(ledgerInput);
    const delegate: BenchSignalExtractor = {
      extract: vi.fn(async (input) => {
        await input.onTransportAttempt?.(input.abortSignal);
        return { rawJson: '{"signals":[]}' };
      })
    };
    const extractor = createCachingSignalExtractor({
      delegate,
      config: extractionConfig(),
      cacheRoot,
      onTransportAttempt: ledger.reserveAttempt,
      onLiveExtractionOutcome: ledger.recordTransportOutcome,
      onLiveExtractionSucceeded: ledger.commitSuccessfulShard,
      onLiveExtractionFailed: ledger.abandonPendingShard
    });

    await extractor.extract({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: userPromptWithAssertions()
    });

    const expected = {
      attempts: 2,
      successfulShards: 1,
      pendingKeys: [],
      unresolvedAttempts: [],
      transportFailures: [],
      telemetry: {
        unresolvedTransportAttempts: 0,
        usageUnknownAttempts: 2
      }
    };
    expect(ledger.snapshot()).toMatchObject(expected);
    expect(openExtractionAttemptLedger(ledgerInput).snapshot()).toMatchObject(expected);
  });

  it("settles a typed terminal failure against its reserved global ordinal", async () => {
    const cacheKey = "8".repeat(64);
    const ledger = openExtractionAttemptLedger({
      cacheRoot,
      lineageDigest: "7".repeat(64),
      cacheIdentity: { model: MODEL, requestProfile: REQUEST_PROFILE },
      startingMissing: 1,
      maximumAttempts: 1,
      successfulShardCeiling: 1
    });
    const terminalFailure = Object.assign(new Error("redacted by ledger"), {
      benchRetry: {
        retryCount: 0,
        rateLimitRetries: 0,
        retryClassification: "failure_non_retryable_4xx" as const,
        transportFailures: [{
          kind: "http_error" as const,
          phase: "response_status" as const,
          httpStatus: 401,
          fingerprint: "6".repeat(64),
          attempt: 1
        }]
      }
    });
    const delegate: BenchSignalExtractor = {
      extract: vi.fn(async (input) => {
        await input.onTransportAttempt?.(input.abortSignal);
        throw terminalFailure;
      })
    };

    await expect(extractLiveDelegate({
      delegate,
      request: {
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: userPromptWithAssertions(),
        onTransportAttempt: () => ledger.reserveAttempt(cacheKey)
      },
      stats: undefined,
      onOutcome: (outcome) => ledger.recordTransportOutcome(cacheKey, outcome),
      onFailure: () => ledger.abandonPendingShard(cacheKey)
    })).rejects.toBe(terminalFailure);

    expect(ledger.snapshot()).toMatchObject({
      attempts: 1,
      pendingKeys: [],
      unresolvedAttempts: [],
      transportFailures: [{
        attemptOrdinal: 1,
        cacheKey,
        kind: "http_error",
        phase: "response_status",
        httpStatus: 401,
        fingerprint: "6".repeat(64)
      }],
      telemetry: {
        terminalRetryClassifications: { failure_non_retryable_4xx: 1 },
        unresolvedTransportAttempts: 0,
        usageUnknownAttempts: 1
      }
    });
  });

  it("preserves a pre-transport recheck rejection and closes its actual ledger shard", async () => {
    const ledger = openExtractionAttemptLedger({
      cacheRoot,
      lineageDigest: "a".repeat(64),
      cacheIdentity: { model: MODEL, requestProfile: REQUEST_PROFILE },
      startingMissing: 1,
      maximumAttempts: 1,
      successfulShardCeiling: 1
    });
    let rejectedByAuthority: unknown;
    let actualTransportStarts = 0;
    const onTransportAttempt = vi.fn(async (cacheKey: string) => {
      try {
        ledger.reserveAttempt(cacheKey);
      } catch (cause) {
        rejectedByAuthority = cause;
        throw cause;
      }
      actualTransportStarts += 1;
    });
    const onLiveExtractionFailed = vi.fn(ledger.abandonPendingShard);
    const onLiveExtractionOutcome = vi.fn(ledger.recordTransportOutcome);
    const delegate: BenchSignalExtractor = {
      extract: vi.fn(async (input) => {
        await input.onTransportAttempt?.(input.abortSignal);
        return { rawJson: '{"signals":[]}' };
      })
    };
    const extractor = createCachingSignalExtractor({
      delegate,
      config: extractionConfig(),
      cacheRoot,
      onTransportAttempt,
      onLiveExtractionFailed,
      onLiveExtractionOutcome
    });

    const rejection = await extractor.extract({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: userPromptWithAssertions()
    }).then(() => undefined, (cause: unknown) => cause);

    expect(rejection).toBe(rejectedByAuthority);
    expect(actualTransportStarts).toBe(1);
    expect(onTransportAttempt).toHaveBeenCalledTimes(2);
    expect(onLiveExtractionOutcome).toHaveBeenCalledOnce();
    expect(onLiveExtractionFailed).toHaveBeenCalledOnce();
    expect(ledger.snapshot()).toMatchObject({
      attempts: 1,
      successfulShards: 0,
      pendingKeys: [],
      telemetry: {
        unresolvedTransportAttempts: 0,
        terminalRetryClassifications: {
          failure_max_retries: 0,
          failure_non_retryable_4xx: 0,
          failure_timeout: 0,
          failure_aborted: 0
        }
      }
    });
    expect(existsSync(shardPath(cacheRoot))).toBe(false);
  });

  it("does not recheck a strict empty probe whose retry mode is disabled", async () => {
    const delegate: BenchSignalExtractor = {
      extract: vi.fn(async () => ({ rawJson: '{"signals":[]}' }))
    };

    const result = await extractLiveDelegate({
      delegate,
      request: {
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: userPromptWithAssertions(),
        retryMode: "disabled"
      },
      stats: undefined,
      onFailure: vi.fn()
    });

    expect(delegate.extract).toHaveBeenCalledOnce();
    expect(result.rawJson).toBe('{"signals":[]}');
  });

  it.each([
    {
      label: "unparseable prompt",
      userPrompt: "not-json",
      rawJson: '{"signals":[]}'
    },
    {
      label: "empty source assertion catalog",
      userPrompt: JSON.stringify({ source_assertions: [] }),
      rawJson: '{"signals":[]}'
    },
    {
      label: "non-empty first envelope",
      userPrompt: userPromptWithAssertions(),
      rawJson: JSON.stringify({ signals: [{
        signal_kind: "potential_claim",
        object_kind: "activity",
        confidence: 0.9,
        matched_text: "I completed the review today.",
        distilled_fact: "I completed the review today."
      }] })
    },
    {
      label: "malformed first envelope",
      userPrompt: userPromptWithAssertions(),
      rawJson: '{"signals":['
    },
    {
      label: "parseable envelope without signals",
      userPrompt: userPromptWithAssertions(),
      rawJson: '{}'
    },
    {
      label: "parseable array envelope",
      userPrompt: userPromptWithAssertions(),
      rawJson: '[]'
    },
    {
      label: "parseable envelope with non-array signals",
      userPrompt: userPromptWithAssertions(),
      rawJson: '{"signals":"invalid"}'
    }
  ])("does not recheck $label", async ({ userPrompt, rawJson }) => {
    const delegate: BenchSignalExtractor = {
      extract: vi.fn(async () => ({ rawJson }))
    };

    const result = await extractLiveDelegate({
      delegate,
      request: { systemPrompt: SYSTEM_PROMPT, userPrompt },
      stats: undefined,
      onFailure: vi.fn()
    });

    expect(delegate.extract).toHaveBeenCalledOnce();
    expect(result.rawJson).toBe(rawJson);
  });
});

function extractionConfig() {
  return {
    model: MODEL,
    modelFamily: MODEL,
    providerUrl: TEST_EXTRACTION_PROVIDER_URL,
    requestProfile: REQUEST_PROFILE
  } as const;
}

function shardPath(cacheRoot: string): string {
  return cacheFilePath(cacheRoot, computeCacheKey(
    MODEL,
    REQUEST_PROFILE,
    SYSTEM_PROMPT,
    "I completed the review today."
  ));
}

function readShard(cacheRoot: string): {
  readonly raw_json: string;
  readonly response_metadata?: {
    readonly usage?: {
      readonly input_tokens: number;
      readonly output_tokens: number;
      readonly total_tokens: number;
    };
  };
} {
  return JSON.parse(readFileSync(shardPath(cacheRoot), "utf8"));
}

function userPromptWithAssertions(): string {
  return JSON.stringify({
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    turn_content: "I completed the review today.",
    source_assertions: [{
      assertion_id: 1,
      text: "I completed the review today."
    }]
  });
}
