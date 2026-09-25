// @ts-nocheck
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCachingSignalExtractor,
  type BenchSignalExtractor
} from "../../../../../runs/compile-seed.js";
import { openExtractionAttemptLedger, readExtractionAttemptLedger } from
  "../../../../../runs/extraction/authority/attempt-ledger.js";
import { cacheFilePath, inspectCachedRawExtraction } from
  "../../../../../runs/compile-seed/cache/cache-shard.js";
import { computeExtractionFillAttemptCeiling } from
  "../../../../../runs/extraction/authority/receipt-limits.js";
import {
  TEST_EXTRACTION_PROVIDER_URL,
  writeExtractionCacheTestManifest
} from "../../extraction-cache-test-fixture.js";
import {
  assertionBatchCorpus,
  assertionBatchPrompt,
  cacheInterpretationResponse,
  createHttpExtractor,
  extractionConfig,
  MODEL,
  REQUEST_PROFILE,
  SYSTEM_PROMPT,
  truncatedSseResponse
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
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(truncatedSseResponse())
      .mockResolvedValueOnce(await responseWithUsage(1, 10, 6))
      .mockResolvedValueOnce(await responseWithUsage(2, 10, 6));
    const ledger = openExtractionAttemptLedger({
      cacheRoot,
      lineageDigest: "5".repeat(64),
      cacheIdentity: { model: MODEL, requestProfile: REQUEST_PROFILE },
      startingMissing: 1,
      maximumAttempts: 4,
      successfulShardCeiling: 1
    });
    const extractor = createCachingSignalExtractor({
      delegate: createHttpExtractor(fetchMock),
      config: extractionConfig(),
      cacheRoot,
      onTransportAttempt: ledger.reserveAttemptOrdinal,
      providerAttemptLineageDigest: "5".repeat(64),
      onLiveExtractionOutcome: ledger.recordTransportOutcome,
      onLiveProviderExtractionSucceeded: ledger.commitSuccessfulShard,
      onLiveExtractionFailed: ledger.abandonPendingShard
    });

    await extractor.extract({
      systemPrompt: SYSTEM_PROMPT,
      sourceCorpus: assertionBatchCorpus([1, 2]), userPrompt: assertionBatchPrompt([1, 2]),
      maxOutputTokens: 32_768, outputTokenField: "max_tokens"
    });

    expect(ledger.snapshot()).toMatchObject({
      attempts: 3,
      successfulShards: 1,
      unresolvedAttempts: [],
      transportFailures: [
        expect.objectContaining({ attemptOrdinal: 1 })
      ],
      settledAttempts: [1, 2, 3].map((attemptOrdinal) =>
        expect.objectContaining({ attemptOrdinal, usageSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) })),
      telemetry: {
        inputTokens: 20,
        outputTokens: 12,
        totalTokens: 32,
        usageUnavailableRequests: 1
      }
    });
    const cacheKey = ledger.snapshot().successfulKeys[0]!;
    const shardPath = cacheFilePath(cacheRoot, cacheKey);
    const shardBytes = await readFile(shardPath, "utf8");
    const shard = JSON.parse(shardBytes);
    const changedChild = JSON.parse(JSON.stringify(shard));
    changedChild.provider_responses[0].witness.userPrompt = assertionBatchPrompt([1, 3]);
    changedChild.provider_responses[0].witness.requestSha256 = createHash("sha256")
      .update(changedChild.provider_responses[0].witness.userPrompt).digest("hex");
    await writeFile(shardPath, JSON.stringify(changedChild), "utf8");
    const childStatus = inspectCachedRawExtraction(cacheRoot, cacheKey, MODEL, REQUEST_PROFILE).status;
    const changedAggregate = JSON.parse(shardBytes);
    changedAggregate.response_metadata.usage.input_tokens += 1;
    await writeFile(shardPath, JSON.stringify(changedAggregate), "utf8");
    const aggregateStatus = inspectCachedRawExtraction(cacheRoot, cacheKey, MODEL, REQUEST_PROFILE).status;
    expect([childStatus, aggregateStatus]).toEqual(["quarantined", "invalid"]);
    shard.provider_responses[1].witness.httpResponse.bodyBase64 = "AA==";
    await writeFile(shardPath, JSON.stringify(shard), "utf8");
    expect(inspectCachedRawExtraction(cacheRoot, cacheKey, MODEL, REQUEST_PROFILE).status).toBe("quarantined");
    await writeFile(shardPath, shardBytes, "utf8");
    const ledgerPath = join(cacheRoot, `extraction-attempt-ledger.${"5".repeat(64)}.json`);
    const persisted = JSON.parse(await readFile(ledgerPath, "utf8"));
    delete persisted.settled_attempts[2].response_sha256;
    await writeFile(ledgerPath, JSON.stringify(persisted), "utf8");
    expect(() => readExtractionAttemptLedger({ cacheRoot, lineageDigest: "5".repeat(64),
      cacheIdentity: { model: MODEL, requestProfile: REQUEST_PROFILE } }))
      .toThrow(/successful shard closure drifted/u);
  });

  it("settles a real recursive HTTP partition that exceeds four requests", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(truncatedSseResponse())
      .mockResolvedValueOnce(truncatedSseResponse())
      .mockResolvedValueOnce(cacheInterpretationResponse(1))
      .mockResolvedValueOnce(cacheInterpretationResponse(2))
      .mockResolvedValueOnce(cacheInterpretationResponse(3));
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
      onTransportAttempt: ledger.reserveAttemptOrdinal,
      providerAttemptLineageDigest: "6".repeat(64),
      onLiveExtractionOutcome: ledger.recordTransportOutcome,
      onLiveProviderExtractionSucceeded: ledger.commitSuccessfulShard,
      onLiveExtractionFailed: ledger.abandonPendingShard
    });

    await extractor.extract({
      systemPrompt: SYSTEM_PROMPT,
      sourceCorpus: assertionBatchCorpus([1, 2, 3]), userPrompt: assertionBatchPrompt([1, 2, 3]),
      maxOutputTokens: 32_768,
      outputTokenField: "max_tokens"
    });

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(ledger.snapshot()).toMatchObject({
      attempts: 5,
      successfulShards: 1,
      pendingKeys: [],
      unresolvedAttempts: [],
      settledAttempts: [1, 2, 3, 4, 5].map((attemptOrdinal) =>
        expect.objectContaining({ attemptOrdinal, usageSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) }))
    });
  });

  it("settles completed partition requests when final composition validation fails", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(truncatedSseResponse())
      .mockResolvedValueOnce(cacheInterpretationResponse(1))
      .mockResolvedValueOnce(cacheInterpretationResponse(2));
    const live = createHttpExtractor(fetchMock);
    const delegate: BenchSignalExtractor = {
      extract: (input) => live.extract({
        ...input,
        validateRawJson: (rawJson) => {
          input.validateRawJson?.(rawJson);
          const parsed = JSON.parse(rawJson) as { readonly interpretations: readonly unknown[] };
          if (parsed.interpretations.length > 1) throw new Error("merged envelope rejected");
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
      onTransportAttempt: ledger.reserveAttemptOrdinal,
      providerAttemptLineageDigest: "b".repeat(64),
      onLiveExtractionOutcome: ledger.recordTransportOutcome,
      onLiveProviderExtractionSucceeded: ledger.commitSuccessfulShard,
      onLiveExtractionFailed: ledger.abandonPendingShard
    });

    await expect(extractor.extract({
      systemPrompt: SYSTEM_PROMPT,
      sourceCorpus: assertionBatchCorpus([1, 2]), userPrompt: assertionBatchPrompt([1, 2]),
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

async function responseWithUsage(assertionId: number, inputTokens: number, outputTokens: number): Promise<Response> {
  const body = await cacheInterpretationResponse(assertionId).text();
  const usage = JSON.stringify({ usage: { prompt_tokens: inputTokens,
    completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens } });
  return new Response(body.replace("data: [DONE]", `data: ${usage}\n\ndata: [DONE]`),
    { status: 200, headers: { "content-type": "text/event-stream" } });
}
