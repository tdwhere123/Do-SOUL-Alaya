import { existsSync, readFileSync } from "node:fs";
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
  createGardenHttpExtractor,
  type BenchSignalExtractor
} from "../../../../bench/compile-seed.js";
import { cacheFilePath, computeSourceTurnCacheKey } from
  "../../../../bench/compile-seed/compile-seed-cache.js";
import { extractLiveDelegate } from
  "../../../../bench/extraction/cache/cache-live-delegate.js";
import { openExtractionAttemptLedger } from
  "../../../../bench/extraction/authority/attempt-ledger.js";
import { computeExtractionFillAttemptCeiling } from
  "../../../../bench/extraction/authority/receipt-limits.js";
import {
  TEST_EXTRACTION_PROVIDER_URL,
  writeExtractionCacheTestManifest
} from "../extraction-cache-test-fixture.js";
import {
  signalsEnvelope,
  withOpenSemanticFactorGraph
} from "../../compile-seed/compile-seed-fixture.js";

const MODEL = "test-model";
const SYSTEM_PROMPT = "test-system-prompt";
const REQUEST_PROFILE = "provider-default-v1" as const;

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
          return { rawJson: '{"signals":[]}' };
        })
        .mockImplementationOnce(async (input) => {
          await input.onTransportAttempt?.(input.abortSignal);
          return { rawJson: terminalRaw };
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
          return { rawJson: '{"signals":[]}' };
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

  it("settles a partitioned response against every physical provider request", async () => {
    const ledger = openExtractionAttemptLedger({
      cacheRoot,
      lineageDigest: "5".repeat(64),
      cacheIdentity: { model: MODEL, requestProfile: REQUEST_PROFILE },
      startingMissing: 1,
      maximumAttempts: 4,
      successfulShardCeiling: 1
    });
    const extractor = createCachingSignalExtractor({
      delegate: {
        extract: vi.fn(async (input) => {
          for (let index = 0; index < 4; index += 1) {
            await input.onTransportAttempt?.(input.abortSignal);
          }
          return {
            rawJson: signalsEnvelope([{
              distilled: "I completed the review today.",
              matched: "I completed the review today."
            }]),
            extractorMeta: {
              recoveryKind: "none",
              retryCount: 2,
              retryClassification: "success_after_retry",
              rateLimitRetries: 0,
              successfulRequestCount: 2,
              usageRequestCount: 2,
              transportFailures: [
                failure(1, "1"),
                failure(3, "3")
              ]
            },
            usage: { inputTokens: 40, outputTokens: 12, totalTokens: 52 }
          };
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

    expect(ledger.snapshot()).toMatchObject({
      attempts: 4,
      successfulShards: 1,
      unresolvedAttempts: [],
      transportFailures: [
        expect.objectContaining({ attemptOrdinal: 1 }),
        expect.objectContaining({ attemptOrdinal: 3 })
      ],
      telemetry: {
        inputTokens: 40,
        outputTokens: 12,
        totalTokens: 52,
        usageUnavailableRequests: 2
      }
    });
  });

  it("settles a real recursive HTTP partition that exceeds four requests", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(truncatedSseResponse())
      .mockResolvedValueOnce(truncatedSseResponse())
      .mockResolvedValueOnce(cacheSignalResponse(1))
      .mockResolvedValueOnce(cacheSignalResponse(2))
      .mockResolvedValueOnce(cacheSignalResponse(3));
    const ledger = openExtractionAttemptLedger({
      cacheRoot,
      lineageDigest: "6".repeat(64),
      cacheIdentity: { model: MODEL, requestProfile: REQUEST_PROFILE },
      startingMissing: 1,
      maximumAttempts: computeExtractionFillAttemptCeiling(1),
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

    await extractor.extract({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: assertionBatchPrompt([1, 2, 3]),
      maxOutputTokens: 32_768,
      outputTokenField: "max_tokens"
    });

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(ledger.snapshot()).toMatchObject({
      attempts: 5,
      successfulShards: 1,
      pendingKeys: [],
      unresolvedAttempts: []
    });
  });

  it("settles completed partition requests when final composition validation fails", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(truncatedSseResponse())
      .mockResolvedValueOnce(cacheSignalResponse(1))
      .mockResolvedValueOnce(cacheSignalResponse(2));
    const live = createHttpExtractor(fetchMock);
    const delegate: BenchSignalExtractor = {
      extract: (input) => live.extract({
        ...input,
        validateRawJson: (rawJson) => {
          input.validateRawJson?.(rawJson);
          const parsed = JSON.parse(rawJson) as { readonly signals: readonly unknown[] };
          if (parsed.signals.length > 1) throw new Error("merged envelope rejected");
        }
      })
    };
    const ledger = openExtractionAttemptLedger({
      cacheRoot,
      lineageDigest: "b".repeat(64),
      cacheIdentity: { model: MODEL, requestProfile: REQUEST_PROFILE },
      startingMissing: 1,
      maximumAttempts: computeExtractionFillAttemptCeiling(1),
      successfulShardCeiling: 1
    });
    const extractor = createCachingSignalExtractor({
      delegate,
      config: extractionConfig(),
      cacheRoot,
      onTransportAttempt: ledger.reserveAttempt,
      onLiveExtractionOutcome: ledger.recordTransportOutcome,
      onLiveProviderExtractionSucceeded: ledger.commitSuccessfulShard,
      onLiveExtractionFailed: ledger.abandonPendingShard
    });

    await expect(extractor.extract({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: assertionBatchPrompt([1, 2]),
      maxOutputTokens: 32_768,
      outputTokenField: "max_tokens"
    })).rejects.toThrow(/merged envelope rejected/u);

    expect(ledger.snapshot()).toMatchObject({
      attempts: 3,
      successfulShards: 0,
      pendingKeys: [],
      unresolvedAttempts: [],
      transportFailures: [expect.objectContaining({ attemptOrdinal: 1 })],
      telemetry: { retrySuccesses: 0, usageUnavailableRequests: 3 }
    });
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
          rawJson: '{"signals":[]}',
          usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 }
        })
        .mockResolvedValueOnce({
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
        return { rawJson: '{"signals":[]}' };
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
          return { rawJson: '{"signals":[]}' };
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
      extract: vi.fn(async () => ({ rawJson: '{"signals":[]}' }))
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

function extractionConfig() {
  return {
    model: MODEL,
    modelFamily: MODEL,
    providerUrl: TEST_EXTRACTION_PROVIDER_URL,
    requestProfile: REQUEST_PROFILE
  } as const;
}

function failure(attempt: number, digit: string) {
  return {
    kind: "http_error" as const,
    phase: "response_status" as const,
    httpStatus: 503,
    fingerprint: digit.repeat(64),
    attempt
  };
}

function shardPath(cacheRoot: string): string {
  return cacheFilePath(cacheRoot, computeSourceTurnCacheKey(
    MODEL,
    REQUEST_PROFILE,
    SYSTEM_PROMPT,
    { turnContent: "I completed the review today." }
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
  readonly transport_provenance?: {
    readonly provider_url_sha256: string;
    readonly model: string;
  };
} {
  expect(existsSync(shardPath(cacheRoot))).toBe(true);
  return JSON.parse(readFileSync(shardPath(cacheRoot), "utf8"));
}

function userPromptWithAssertions(): string {
  return stringifyOfficialApiExtractionRequest(
    buildOfficialApiExtractionRequest("I completed the review today.", [])
  );
}

function createHttpExtractor(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>) {
  return createGardenHttpExtractor({
    ...extractionConfig(),
    apiKey: "sk-test"
  }, {
    fetch: fetchMock,
    sleep: vi.fn(async () => undefined),
    random: () => 0
  });
}

function assertionBatchPrompt(assertionIds: readonly number[]): string {
  return JSON.stringify({
    schema_version: 2,
    source_locator_contract_version: 2,
    batch_contract_version: 1,
    source_corpus_identity: "a".repeat(64),
    batch_index: 0,
    batch_count: 1,
    source_assertions: assertionIds.map((assertion_id) => ({
      assertion_id,
      text: `User: assertion ${assertion_id}`
    }))
  });
}

function cacheSignalResponse(assertionId: number): Response {
  const matchedText = `User: assertion ${assertionId}`;
  const signal = withOpenSemanticFactorGraph({
    signal_kind: "potential_claim",
    object_kind: "open_semantic_observation",
    confidence: 0.9,
    matched_text: matchedText,
    distilled_fact: `assertion ${assertionId}`,
    source_locator: {
      contract_version: 2,
      kind: "assertion_catalog",
      assertion_id: assertionId
    }
  });
  return sseResponse(JSON.stringify({ signals: [signal] }), "stop");
}

function truncatedSseResponse(): Response {
  return sseResponse('{"signals":[]}', "length");
}

function sseResponse(content: string, finishReason: string): Response {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n` +
      "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
}
