// @ts-nocheck
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCachingSignalExtractor,
  type BenchSignalExtractor
} from "../../../../../runs/compile-seed.js";
import { openExtractionAttemptLedger } from
  "../../../../../runs/extraction/authority/attempt-ledger.js";
import { computeExtractionFillAttemptCeiling } from
  "../../../../../runs/extraction/authority/receipt-limits.js";
import {
  TEST_EXTRACTION_PROVIDER_URL,
  writeExtractionCacheTestManifest
} from "../../extraction-cache-test-fixture.js";
import {
  providerBackedResult,
  signalsEnvelope
} from "../../../compile-seed/compile-seed-fixture.js";
import {
  assertionBatchPrompt,
  cacheSignalResponse,
  createHttpExtractor,
  extractionConfig,
  failure,
  MODEL,
  REQUEST_PROFILE,
  SYSTEM_PROMPT,
  truncatedSseResponse,
  userPromptWithAssertions
} from "./fixture.js";

describe("extraction live delegate partition accounting", () => {
  let cacheRoot: string;

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "cache-live-delegate-partition-"));
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
            ...providerBackedResult(""),
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

});
