import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildOfficialApiExtractionRequest,
  stringifyOfficialApiExtractionRequest
} from "@do-soul/alaya-soul";
import {
  createCachingSignalExtractor,
  type BenchSignalExtractor
} from "../../../../bench/compile-seed.js";
import { extractLiveDelegate } from
  "../../../../bench/extraction/cache/cache-live-delegate.js";
import { openExtractionAttemptLedger } from
  "../../../../bench/extraction/authority/attempt-ledger.js";
import {
  TEST_EXTRACTION_PROVIDER_URL,
  writeExtractionCacheTestManifest
} from "../extraction-cache-test-fixture.js";
import {
  providerBackedResult,
  signalsEnvelope
} from "../../compile-seed/compile-seed-fixture.js";
import {
  createHttpExtractor,
  extractionConfig,
  failure,
  MODEL,
  readShard,
  REQUEST_PROFILE,
  SYSTEM_PROMPT,
  userPromptWithAssertions
} from "./cache-live-delegate/fixture.js";

describe("extraction live delegate atomic persistence", () => {
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

  it("rechecks one strict empty result once and persists only the terminal response", async () => {
    const terminalRaw = signalsEnvelope([{
      distilled: "I completed the review today.",
      matched: "I completed the review today."
    }]);
    const delegate: BenchSignalExtractor = {
      extract: vi
        .fn<BenchSignalExtractor["extract"]>()
        .mockImplementationOnce(async (input) => {
          await input.onTransportAttempt?.(input.abortSignal);
          return providerBackedResult('{"signals":[]}');
        })
        .mockImplementationOnce(async (input) => {
          await input.onTransportAttempt?.(input.abortSignal);
          return providerBackedResult(terminalRaw);
        })
    };
    const onTransportAttempt = vi.fn(async () => undefined);
    const onLiveExtractionOutcome = vi.fn();
    const extractor = createCachingSignalExtractor({
      delegate,
      config: extractionConfig(),
      cacheRoot,
      onTransportAttempt,
      onLiveExtractionOutcome
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
    expect(onLiveExtractionOutcome).toHaveBeenCalledTimes(2);
    expect(result.rawJson).toBe(terminalRaw);
    const shard = readShard(cacheRoot);
    expect(shard.raw_json).toBe(terminalRaw);
    expect(shard.transport_provenance).toEqual({
      provider_url_sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      model: MODEL
    });
  });

  it("settles both strict-empty transports exactly once across a ledger reload", async () => {
    const ledgerInput = {
      cacheRoot,
      lineageDigest: "9".repeat(64),
      cacheIdentity: { model: MODEL, requestProfile: REQUEST_PROFILE },
      startingMissing: 1,
      maximumAttempts: 2,
      successfulShardCeiling: 1
    } as const;
    const ledger = openExtractionAttemptLedger(ledgerInput);
    const extractor = createCachingSignalExtractor({
      delegate: {
        extract: vi.fn(async (input) => {
          await input.onTransportAttempt?.(input.abortSignal);
          return providerBackedResult('{"signals":[]}');
        })
      },
      config: extractionConfig(),
      cacheRoot,
      onTransportAttempt: ledger.reserveAttempt,
      onLiveExtractionOutcome: ledger.recordTransportOutcome,
      onLiveProviderExtractionSucceeded: ledger.commitSuccessfulShard,
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
      telemetry: { unresolvedTransportAttempts: 0, usageUnknownAttempts: 2 }
    };
    expect(ledger.snapshot()).toMatchObject(expected);
    expect(openExtractionAttemptLedger(ledgerInput).snapshot()).toMatchObject(expected);
  });

  it("does not count a deterministic empty request as a provider attempt", async () => {
    const ledger = openExtractionAttemptLedger({
      cacheRoot,
      lineageDigest: "4".repeat(64),
      cacheIdentity: { model: MODEL, requestProfile: REQUEST_PROFILE },
      startingMissing: 1,
      maximumAttempts: 1,
      successfulShardCeiling: 1
    });
    const delegate: BenchSignalExtractor = {
      extract: vi.fn(async () => {
        throw new Error("deterministic empty requests must not reach the provider");
      })
    };
    const extractor = createCachingSignalExtractor({
      delegate,
      config: extractionConfig(),
      cacheRoot,
      onLiveProviderExtractionSucceeded: ledger.commitSuccessfulShard,
      onDeterministicExtractionSucceeded: ledger.commitDeterministicShard
    });

    await expect(extractor.extract({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: stringifyOfficialApiExtractionRequest(
        buildOfficialApiExtractionRequest("", [])
      )
    })).resolves.toMatchObject({ rawJson: '{"signals":[]}' });

    expect(delegate.extract).not.toHaveBeenCalled();
    expect(ledger.snapshot()).toMatchObject({
      attempts: 0,
      successfulShards: 1,
      pendingKeys: []
    });
  });

  it("settles a typed terminal failure against its reserved ordinal", async () => {
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

    await expect(extractLiveDelegate({
      delegate: {
        extract: vi.fn(async (input) => {
          await input.onTransportAttempt?.(input.abortSignal);
          throw terminalFailure;
        })
      },
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
      }]
    });
  });

  it("settles a failed response when the next retry exceeds authority", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("limited", { status: 429 })
    );
    const ledger = openExtractionAttemptLedger({
      cacheRoot,
      lineageDigest: "e".repeat(64),
      cacheIdentity: { model: MODEL, requestProfile: REQUEST_PROFILE },
      startingMissing: 1,
      maximumAttempts: 1,
      successfulShardCeiling: 1
    });
    const extractor = createCachingSignalExtractor({
      delegate: createHttpExtractor(fetchMock),
      config: extractionConfig(),
      cacheRoot,
      onTransportAttempt: ledger.reserveAttempt,
      onLiveExtractionOutcome: ledger.recordTransportOutcome,
      onLiveProviderExtractionSucceeded: ledger.commitSuccessfulShard,
      onLiveExtractionFailed: ledger.abandonPendingShard
    });

    await expect(extractor.extract({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: userPromptWithAssertions()
    })).rejects.toThrow(/attempt ceiling exhausted/u);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(ledger.snapshot()).toMatchObject({
      attempts: 1,
      successfulShards: 0,
      pendingKeys: [],
      unresolvedAttempts: [],
      transportFailures: [{
        attemptOrdinal: 1,
        cacheKey: expect.any(String),
        kind: "http_error",
        phase: "response_status",
        httpStatus: 429,
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u)
      }],
      telemetry: { rateLimitRetries: 1 }
    });
  });

  it("accepts a second strict empty result without a third request", async () => {
    const terminalRaw = '{ "signals": [] }\n';
    const delegate: BenchSignalExtractor = {
      extract: vi
        .fn<BenchSignalExtractor["extract"]>()
        .mockResolvedValueOnce({
          ...providerBackedResult(""),
          rawJson: '{"signals":[]}',
          usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 }
        })
        .mockResolvedValueOnce({
          ...providerBackedResult(""),
          rawJson: terminalRaw,
          usage: { inputTokens: 20, outputTokens: 2, totalTokens: 22 }
        })
    };
    const onOutcome = vi.fn();

    const result = await extractLiveDelegate({
      delegate,
      request: { systemPrompt: SYSTEM_PROMPT, userPrompt: userPromptWithAssertions() },
      stats: undefined,
      onFailure: vi.fn(),
      onOutcome
    });

    expect(delegate.extract).toHaveBeenCalledTimes(2);
    expect(result.rawJson).toBe(terminalRaw);
    expect(onOutcome).toHaveBeenCalledTimes(2);
  });

  it("fails a strict-empty recheck without returning the first result", async () => {
    const terminalFailure = new Error("recheck transport failed");
    const delegate: BenchSignalExtractor = {
      extract: vi.fn<BenchSignalExtractor["extract"]>(async (input) => {
        if (input.retryMode === "disabled") throw terminalFailure;
        return providerBackedResult('{"signals":[]}');
      })
    };
    const onFailure = vi.fn();

    await expect(extractLiveDelegate({
      delegate,
      request: { systemPrompt: SYSTEM_PROMPT, userPrompt: userPromptWithAssertions() },
      stats: undefined,
      onFailure
    })).rejects.toBe(terminalFailure);

    expect(delegate.extract).toHaveBeenCalledTimes(2);
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it("closes the first reservation when authority rejects the empty-result recheck", async () => {
    const ledger = openExtractionAttemptLedger({
      cacheRoot,
      lineageDigest: "c".repeat(64),
      cacheIdentity: { model: MODEL, requestProfile: REQUEST_PROFILE },
      startingMissing: 1,
      maximumAttempts: 1,
      successfulShardCeiling: 1
    });
    const onTransportAttempt = vi.fn(async (cacheKey: string) => {
      ledger.reserveAttempt(cacheKey);
    });
    const extractor = createCachingSignalExtractor({
      delegate: {
        extract: vi.fn(async (input) => {
          await input.onTransportAttempt?.(input.abortSignal);
          return providerBackedResult('{"signals":[]}');
        })
      },
      config: extractionConfig(),
      cacheRoot,
      onTransportAttempt,
      onLiveExtractionOutcome: ledger.recordTransportOutcome,
      onLiveExtractionFailed: ledger.abandonPendingShard
    });

    await expect(extractor.extract({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: userPromptWithAssertions()
    })).rejects.toThrow(/attempt ceiling exhausted/u);

    expect(onTransportAttempt).toHaveBeenCalledTimes(2);
    expect(ledger.snapshot()).toMatchObject({
      attempts: 1,
      successfulShards: 0,
      pendingKeys: [],
      unresolvedAttempts: [],
      telemetry: { usageUnknownAttempts: 1 }
    });
  });

  it("does not recheck a strict empty request when retries are disabled", async () => {
    const delegate: BenchSignalExtractor = {
      extract: vi.fn(async () => providerBackedResult('{"signals":[]}'))
    };

    await extractLiveDelegate({
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
  });

  it.each([
    '{"signals":[',
    '{}'
  ])("returns one delegate result without a post-success request: %s", async (rawJson) => {
    const delegate: BenchSignalExtractor = {
      extract: vi.fn(async () => ({ rawJson }))
    };

    const result = await extractLiveDelegate({
      delegate,
      request: { systemPrompt: SYSTEM_PROMPT, userPrompt: userPromptWithAssertions() },
      stats: undefined,
      onFailure: vi.fn()
    });

    expect(delegate.extract).toHaveBeenCalledOnce();
    expect(result.rawJson).toBe(rawJson);
  });
});
