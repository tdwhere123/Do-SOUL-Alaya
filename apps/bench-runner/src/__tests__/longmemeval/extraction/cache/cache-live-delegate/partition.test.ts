import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const boundary = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../../../../scripts/test-support/provider-free/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCachingSignalExtractor, type BenchSignalExtractor } from "../../../../../runs/compile-seed.js";
import { openExtractionAttemptLedger, readExtractionAttemptLedger } from "../../../../../runs/extraction/authority/attempt-ledger.js";
import { cacheFilePath, inspectCachedRawExtraction } from "../../../../../runs/compile-seed/cache/cache-shard.js";
import { computeCacheKey } from "../../../../../runs/compile-seed/cache/cache-key.js";
import { TEST_EXTRACTION_PROVIDER_URL, writeExtractionCacheTestManifest } from "../../extraction-cache-test-fixture.js";
import { assertionBatchCorpus, assertionBatchPrompt, createHttpExtractor, extractionConfig,
  jsonChatCompletionResponse, MODEL, REQUEST_PROFILE, SYSTEM_PROMPT, truncatedSseResponse } from "./fixture.js";

const lineageDigest = "5".repeat(64);
const request = { systemPrompt: SYSTEM_PROMPT, sourceCorpus: assertionBatchCorpus([1, 2]),
  userPrompt: assertionBatchPrompt([1, 2]), rawResponse: true, retryMode: "disabled" as const,
  maxOutputTokens: 32_768, outputTokenField: "max_tokens" as const };
const rawJson = JSON.stringify({ messages: [1, 2].map(id => ({ message_id: `recorded-${id}`,
  statements: [{ text: `I completed assertion ${id}.`, relation: "recorded event" }] })) });
let cacheRoot: string;
beforeEach(async () => {
  cacheRoot = await mkdtemp(join(tmpdir(), "session-request-accounting-"));
  writeExtractionCacheTestManifest({ cacheRoot, model: MODEL, providerUrl: TEST_EXTRACTION_PROVIDER_URL,
    requestProfile: REQUEST_PROFILE, systemPrompt: SYSTEM_PROMPT });
});
afterEach(async () => { await rm(cacheRoot, { recursive: true, force: true }); });
afterAll(() => { boundary.restore(); expect(boundary.violations).toEqual([]); });
function ledgerBacked(delegate: BenchSignalExtractor) {
  const ledger = openExtractionAttemptLedger({ cacheRoot, lineageDigest,
    cacheIdentity: { model: MODEL, requestProfile: REQUEST_PROFILE }, startingMissing: 1,
    maximumAttempts: 4, successfulShardCeiling: 1 });
  return { ledger, extractor: createCachingSignalExtractor({ delegate, config: extractionConfig(), cacheRoot,
    onTransportAttempt: ledger.reserveAttemptOrdinal, providerAttemptLineageDigest: lineageDigest,
    onLiveExtractionOutcome: ledger.recordTransportOutcome, onLiveProviderExtractionSucceeded: ledger.commitSuccessfulShard,
    onLiveExtractionFailed: ledger.abandonPendingShard }) };
}

describe("session request physical accounting", () => {
  it("settles one truncated response without recursively partitioning or retrying its captured targets", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(truncatedSseResponse());
    const { ledger, extractor } = ledgerBacked(createHttpExtractor(fetchMock));
    await expect(extractor.extract(request)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(ledger.snapshot()).toMatchObject({ attempts: 1, successfulShards: 0, pendingKeys: [], unresolvedAttempts: [],
      settledAttempts: [{ attemptOrdinal: 1 }], transportFailures: [{ attemptOrdinal: 1 }],
      telemetry: { usageUnavailableRequests: 1 } });
    const key = computeCacheKey(MODEL, REQUEST_PROFILE, request.systemPrompt, request.userPrompt);
    expect(inspectCachedRawExtraction(cacheRoot, key, MODEL, REQUEST_PROFILE).status).toBe("missing");
  });

  it("binds the exact session request, physical response and usage to its settled ordinal", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonChatCompletionResponse(rawJson, { inputTokens: 10, outputTokens: 6 }));
    const { ledger, extractor } = ledgerBacked(createHttpExtractor(fetchMock));
    expect(await extractor.extract(request)).toMatchObject({ rawJson });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(ledger.snapshot()).toMatchObject({ attempts: 1, successfulShards: 1, unresolvedAttempts: [], transportFailures: [],
      settledAttempts: [{ attemptOrdinal: 1, usageSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) }],
      telemetry: { inputTokens: 10, outputTokens: 6, totalTokens: 16, usageUnavailableRequests: 0 } });
    const key = ledger.snapshot().successfulKeys[0]!, path = cacheFilePath(cacheRoot, key);
    const bytes = await readFile(path, "utf8"), shard = JSON.parse(bytes);
    expect(shard.provider_responses).toHaveLength(1);
    expect(shard.provider_responses[0].witness.userPrompt).toBe(request.userPrompt);
    const changedRequest = JSON.parse(bytes);
    changedRequest.provider_responses[0].witness.userPrompt = assertionBatchPrompt([1, 3]);
    changedRequest.provider_responses[0].witness.requestSha256 = createHash("sha256")
      .update(changedRequest.provider_responses[0].witness.userPrompt).digest("hex");
    await writeFile(path, JSON.stringify(changedRequest), "utf8");
    expect(inspectCachedRawExtraction(cacheRoot, key, MODEL, REQUEST_PROFILE).status).toBe("quarantined");
    const changedUsage = JSON.parse(bytes);
    changedUsage.response_metadata.usage.input_tokens += 1;
    await writeFile(path, JSON.stringify(changedUsage), "utf8");
    expect(inspectCachedRawExtraction(cacheRoot, key, MODEL, REQUEST_PROFILE).status).toBe("invalid");
    shard.provider_responses[0].witness.httpResponse.bodyBase64 = "AA==";
    await writeFile(path, JSON.stringify(shard), "utf8");
    expect(inspectCachedRawExtraction(cacheRoot, key, MODEL, REQUEST_PROFILE).status).toBe("quarantined");
    await writeFile(path, bytes, "utf8");
    const ledgerPath = join(cacheRoot, `extraction-attempt-ledger.${lineageDigest}.json`);
    const persisted = JSON.parse(await readFile(ledgerPath, "utf8"));
    delete persisted.settled_attempts[0].response_sha256;
    await writeFile(ledgerPath, JSON.stringify(persisted), "utf8");
    expect(() => readExtractionAttemptLedger({ cacheRoot, lineageDigest,
      cacheIdentity: { model: MODEL, requestProfile: REQUEST_PROFILE } })).toThrow(/successful shard closure drifted/u);
  });

  it("settles completed usage when statement admission fails without dispatching another request", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonChatCompletionResponse(rawJson, { inputTokens: 10, outputTokens: 6 }));
    const live = createHttpExtractor(fetchMock);
    const { ledger, extractor } = ledgerBacked({ extract: input => live.extract({ ...input,
      validateRawJson: raw => { input.validateRawJson?.(raw); throw new Error("statement admission rejected"); } }) });
    await expect(extractor.extract(request)).rejects.toThrow(/statement admission rejected/u);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(ledger.snapshot()).toMatchObject({ attempts: 1, successfulShards: 0, pendingKeys: [], unresolvedAttempts: [],
      settledAttempts: [{ attemptOrdinal: 1 }], transportFailures: [{ attemptOrdinal: 1 }],
      telemetry: { inputTokens: 10, outputTokens: 6, totalTokens: 16, retrySuccesses: 0, usageUnavailableRequests: 0 } });
  });
});
