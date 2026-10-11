import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_COMPLETE_PROVIDER_HTTP_RESPONSE_BYTES, ProviderChatCompletionError } from "@do-soul/alaya-engine-gateway";
import {
  buildOfficialApiExtractionRequest,
  stringifyOfficialApiExtractionRequest
} from "@do-soul/alaya-soul";
import {
  createCachingSignalExtractor,
  createGardenHttpExtractor,
  type BenchSignalExtractor
} from "../../../../runs/compile-seed.js";
import { extractLiveDelegate } from
  "../../../../runs/extraction/cache/cache-live-delegate.js";
import { openExtractionAttemptLedger } from
  "../../../../runs/extraction/authority/attempt-ledger.js";
import { inspectCachedExtraction, inspectCachedRawExtraction } from
  "../../../../runs/compile-seed/cache/cache-shard.js";
import { cacheFilePath } from "../../../../runs/compile-seed/compile-seed-cache.js";
import { computeCacheKey } from
  "../../../../runs/compile-seed/cache/cache-key.js";
import {
  TEST_EXTRACTION_PROVIDER_URL,
  providerBackedResponseResult,
  writeExtractionCacheTestManifest
} from "../extraction-cache-test-fixture.js";
import {
  providerBackedResult
} from "../../compile-seed/compile-seed-fixture.js";
import {
  createHttpExtractor,
  extractionConfig,
  jsonChatCompletionResponse,
  MODEL,
  readShard,
  REQUEST_PROFILE,
  SYSTEM_PROMPT,
  sourceCorpusWithAssertions,
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
    vi.unstubAllEnvs();
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("reopens exact BOM and large response bytes with optional usage from loopback HTTP", async () => {
    const rawJson = '{"interpretations":[]}';
    const responseBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify({
      choices: [{ message: { content: rawJson }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30,
        prompt_tokens_details: { cached_tokens: 2 },
        completion_tokens_details: { reasoning_tokens: 3 } },
      padding: " ".repeat(65_536)
    }))]);
    let requests = 0;
    await withLoopbackResponse((response) => {
      requests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(responseBytes);
    }, async (providerUrl) => {
      vi.stubEnv("ALAYA_ALLOW_PRIVATE_PROVIDER_URL", "1");
      writeExtractionCacheTestManifest({ cacheRoot, model: MODEL, providerUrl,
        requestProfile: REQUEST_PROFILE, systemPrompt: SYSTEM_PROMPT });
      const config = { ...extractionConfig(), providerUrl };
      const lineageDigest = "b".repeat(64);
      const ledger = openExtractionAttemptLedger({ cacheRoot, lineageDigest,
        cacheIdentity: { model: MODEL, requestProfile: REQUEST_PROFILE },
        startingMissing: 1, maximumAttempts: 1, successfulShardCeiling: 1 });
      const options = { delegate: createGardenHttpExtractor({ ...config, apiKey: "test-key" }),
        config, cacheRoot, onTransportAttempt: ledger.reserveAttemptOrdinal,
        providerAttemptLineageDigest: lineageDigest,
        onLiveExtractionOutcome: ledger.recordTransportOutcome,
        onLiveProviderExtractionSucceeded: ledger.commitSuccessfulShard,
        onLiveExtractionFailed: ledger.abandonPendingShard };
      const request = { systemPrompt: SYSTEM_PROMPT, sourceCorpus: sourceCorpusWithAssertions(),
        userPrompt: userPromptWithAssertions() };
      const cacheKey = computeCacheKey(MODEL, REQUEST_PROFILE, request.systemPrompt, request.userPrompt);
      const result = await createCachingSignalExtractor(options).extract(request);
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20, totalTokens: 30 });
      expect(inspectCachedExtraction(cacheRoot, cacheKey, MODEL, REQUEST_PROFILE).status).toBe("hit");
      const shard = JSON.parse(readFileSync(cacheFilePath(cacheRoot, cacheKey), "utf8")) as {
        provider_responses: readonly { usage: { cachedInputTokens?: number;
          reasoningOutputTokens?: number }; witness: { httpResponse: { bodyBase64: string;
          bodyByteLength: number; bodySha256: string; bodyTruncated: boolean } } }[]
      };
      const physical = shard.provider_responses[0]!.witness.httpResponse;
      expect(shard.provider_responses[0]!.usage).toMatchObject({
        cachedInputTokens: 2, reasoningOutputTokens: 3
      });
      expect(physical.bodyByteLength).toBe(responseBytes.length);
      expect(physical.bodyTruncated).toBe(false);
      expect(Buffer.from(physical.bodyBase64, "base64")).toEqual(responseBytes);
      expect(physical.bodySha256).toBe(createHash("sha256").update(responseBytes).digest("hex"));
      expect(ledger.snapshot()).toMatchObject({ successfulShards: 1, unresolvedAttempts: [],
        telemetry: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } });
      await expect(createCachingSignalExtractor({ ...options, allowLiveExtraction: false })
        .extract(request)).resolves.toMatchObject({ rawJson });
      expect(requests).toBe(1);
    });
  });

  it("settles unknown usage when the native response exceeds its finite read bound", async () => {
    const responseBytes = Buffer.from(JSON.stringify({
      choices: [{ message: { content: '{"interpretations":[]}' }, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      padding: " ".repeat(9 * 1024 * 1024)
    }));
    let requests = 0;
    await withLoopbackResponse((response) => {
      requests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(responseBytes);
    }, async (providerUrl) => {
      vi.stubEnv("ALAYA_ALLOW_PRIVATE_PROVIDER_URL", "1");
      writeExtractionCacheTestManifest({ cacheRoot, model: MODEL, providerUrl,
        requestProfile: REQUEST_PROFILE, systemPrompt: SYSTEM_PROMPT });
      const config = { ...extractionConfig(), providerUrl };
      const lineageDigest = "c".repeat(64);
      const ledger = openExtractionAttemptLedger({ cacheRoot, lineageDigest,
        cacheIdentity: { model: MODEL, requestProfile: REQUEST_PROFILE },
        startingMissing: 1, maximumAttempts: 1, successfulShardCeiling: 1 });
      const extractor = createCachingSignalExtractor({
        delegate: createGardenHttpExtractor({ ...config, apiKey: "test-key" }),
        config, cacheRoot, onTransportAttempt: ledger.reserveAttemptOrdinal,
        providerAttemptLineageDigest: lineageDigest,
        onLiveExtractionOutcome: ledger.recordTransportOutcome,
        onLiveProviderExtractionSucceeded: ledger.commitSuccessfulShard,
        onLiveExtractionFailed: ledger.abandonPendingShard
      });
      const request = { systemPrompt: SYSTEM_PROMPT, sourceCorpus: sourceCorpusWithAssertions(),
        userPrompt: userPromptWithAssertions() };
      const cacheKey = computeCacheKey(MODEL, REQUEST_PROFILE, request.systemPrompt, request.userPrompt);
      const failure = await extractor.extract(request).catch((cause: unknown) => cause);
      expect(failure).toMatchObject({ message: "provider response exceeds its finite read-byte limit" });
      if (!(failure instanceof Error) || !(failure.cause instanceof ProviderChatCompletionError) ||
          failure.cause.httpResponse === undefined) {
        throw new Error("bounded response must preserve its native HTTP failure evidence");
      }
      expect(failure.cause).toMatchObject({ kind: "response_parse_error", inspectionReason: "schema", httpStatus: 200 });
      const evidence = failure.cause.httpResponse;
      const retained = Buffer.from(evidence.bodyBase64, "base64");
      expect(evidence.bodyComplete).toBe(false);
      expect(evidence.bodyByteLength).toBeGreaterThanOrEqual(MAX_COMPLETE_PROVIDER_HTTP_RESPONSE_BYTES);
      expect(evidence.bodyByteLength).toBeLessThan(responseBytes.length);
      expect(retained).toHaveLength(MAX_COMPLETE_PROVIDER_HTTP_RESPONSE_BYTES);
      expect(retained.equals(responseBytes.subarray(0, MAX_COMPLETE_PROVIDER_HTTP_RESPONSE_BYTES))).toBe(true);
      expect(evidence.bodyTruncated).toBe(evidence.bodyByteLength > retained.length);
      expect(evidence.bodySha256).toBe(createHash("sha256")
        .update(responseBytes.subarray(0, evidence.bodyByteLength)).digest("hex"));
      expect(requests).toBe(1);
      expect(ledger.snapshot()).toMatchObject({ attempts: 1, successfulShards: 0,
        pendingKeys: [], unresolvedAttempts: [],
        settledAttempts: [{ attemptOrdinal: 1, cacheKey }],
        transportFailures: [{ attemptOrdinal: 1, cacheKey, kind: "response_schema_error" }],
        telemetry: { inputTokens: 0, outputTokens: 0, totalTokens: 0,
          usageUnavailableRequests: 1, unresolvedTransportAttempts: 0, usageUnknownAttempts: 1 } });
      expect(ledger.snapshot().settledAttempts[0]!.responseSha256).toBeUndefined();
      expect(inspectCachedRawExtraction(cacheRoot, cacheKey, MODEL, REQUEST_PROFILE).status)
        .toBe("missing");
    });
  });

  it("retains physical output-limit bytes and settlement without admitting normalized stop", async () => {
    const rawJson = '{"interpretations":[]}';
    const lineageDigest = "d".repeat(64);
    const ledger = openExtractionAttemptLedger({ cacheRoot, lineageDigest,
      cacheIdentity: { model: MODEL, requestProfile: REQUEST_PROFILE },
      startingMissing: 1, maximumAttempts: 1, successfulShardCeiling: 1 });
    const request = { systemPrompt: SYSTEM_PROMPT, sourceCorpus: sourceCorpusWithAssertions(),
      userPrompt: userPromptWithAssertions() };
    const cacheKey = computeCacheKey(MODEL, REQUEST_PROFILE, request.systemPrompt, request.userPrompt);
    let physicalBytes: Buffer | undefined;
    let delegateCalls = 0;
    const delegate: BenchSignalExtractor = { extract: async (input) => {
      delegateCalls += 1;
      const result = await providerBackedResponseResult(input, rawJson);
      const physical = JSON.parse(Buffer.from(result.httpResponse.bodyBase64, "base64").toString("utf8"));
      physical.choices[0].finish_reason = "length";
      physicalBytes = Buffer.from(JSON.stringify(physical));
      return { ...result, httpResponse: { ...result.httpResponse,
        bodyBase64: physicalBytes.toString("base64"), bodyByteLength: physicalBytes.length,
        bodySha256: createHash("sha256").update(physicalBytes).digest("hex") } };
    } };
    const extractor = createCachingSignalExtractor({ delegate, config: extractionConfig(), cacheRoot,
      onTransportAttempt: ledger.reserveAttemptOrdinal, providerAttemptLineageDigest: lineageDigest,
      onLiveExtractionOutcome: ledger.recordTransportOutcome,
      onLiveProviderExtractionSucceeded: ledger.commitSuccessfulShard,
      onLiveExtractionFailed: ledger.abandonPendingShard });

    await expect(extractor.extract(request)).rejects.toMatchObject({
      name: "AlayaError", code: "CONFLICT",
      message: expect.stringMatching(/physical provider response is incomplete/u)
    });
    const shard = JSON.parse(readFileSync(cacheFilePath(cacheRoot, cacheKey), "utf8")) as {
      provider_responses: readonly {
      witness: { httpResponse: { bodyBase64: string } } }[] };
    expect(Buffer.from(shard.provider_responses[0]!.witness.httpResponse.bodyBase64, "base64"))
      .toEqual(physicalBytes);
    expect(inspectCachedRawExtraction(cacheRoot, cacheKey, MODEL, REQUEST_PROFILE).status)
      .toBe("quarantined");
    await expect(extractor.extract(request)).rejects.toThrow(/quarantined.*physical provider response is incomplete/u);
    expect(delegateCalls).toBe(1);
    expect(Buffer.from(JSON.parse(readFileSync(cacheFilePath(cacheRoot, cacheKey), "utf8"))
      .provider_responses[0].witness.httpResponse.bodyBase64, "base64")).toEqual(physicalBytes);
    expect(ledger.snapshot()).toMatchObject({ attempts: 1, successfulShards: 0,
      pendingKeys: [], settledAttempts: [{ attemptOrdinal: 1, cacheKey }] });
  });

  it("persists a completed empty result once and reuses it without a paid recheck", async () => {
    const usage = { inputTokens: 10, outputTokens: 1, totalTokens: 11 };
    const lineageDigest = "8".repeat(64);
    const ledger = openExtractionAttemptLedger({ cacheRoot, lineageDigest,
      cacheIdentity: { model: MODEL, requestProfile: REQUEST_PROFILE },
      startingMissing: 1, maximumAttempts: 1, successfulShardCeiling: 1 });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonChatCompletionResponse('{"interpretations":[]}', usage));
    const delegate = createHttpExtractor(fetchMock);
    const onLiveExtractionOutcome = vi.fn();
    const options = { delegate, config: extractionConfig(), cacheRoot,
      onTransportAttempt: ledger.reserveAttemptOrdinal, providerAttemptLineageDigest: lineageDigest,
      onLiveExtractionOutcome: (key: string, outcome: Parameters<typeof ledger.recordTransportOutcome>[1], ordinal?: number) => {
        onLiveExtractionOutcome();
        ledger.recordTransportOutcome(key, outcome, ordinal);
      },
      onLiveProviderExtractionSucceeded: ledger.commitSuccessfulShard,
      onLiveExtractionFailed: ledger.abandonPendingShard };
    const request = { systemPrompt: SYSTEM_PROMPT, sourceCorpus: sourceCorpusWithAssertions(), userPrompt: userPromptWithAssertions() };
    const result = await createCachingSignalExtractor(options).extract(request);
    expect(result).toMatchObject({ rawJson: '{"interpretations":[]}', usage });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(onLiveExtractionOutcome).toHaveBeenCalledOnce();
    expect(readShard(cacheRoot)).toMatchObject({ raw_json: '{"interpretations":[]}', response_metadata: {
      usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 }
    } });
    const replay = await createCachingSignalExtractor({ ...options, allowLiveExtraction: false }).extract(request);
    expect(replay).toMatchObject({ rawJson: '{"interpretations":[]}' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("settles a completed empty transport exactly once across a ledger reload", async () => {
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
      delegate: createHttpExtractor(vi.fn<typeof fetch>().mockResolvedValue(
        jsonChatCompletionResponse('{"interpretations":[]}'))),
      config: extractionConfig(),
      cacheRoot,
      onTransportAttempt: ledger.reserveAttemptOrdinal,
      providerAttemptLineageDigest: ledgerInput.lineageDigest,
      onLiveExtractionOutcome: ledger.recordTransportOutcome,
      onLiveProviderExtractionSucceeded: ledger.commitSuccessfulShard,
      onLiveExtractionFailed: ledger.abandonPendingShard
    });

    await extractor.extract({
      systemPrompt: SYSTEM_PROMPT,
      sourceCorpus: sourceCorpusWithAssertions(), userPrompt: userPromptWithAssertions()
    });

    const expected = {
      attempts: 1,
      successfulShards: 1,
      pendingKeys: [],
      unresolvedAttempts: [],
      transportFailures: [],
      telemetry: { unresolvedTransportAttempts: 0, usageUnknownAttempts: 1 }
    };
    expect(ledger.snapshot()).toMatchObject(expected);
    expect(openExtractionAttemptLedger(ledgerInput).snapshot()).toMatchObject(expected);
  });

  it("settles a successful response with missing physical bytes before refusing its shard", async () => {
    const lineageDigest = "a".repeat(64);
    const ledger = openExtractionAttemptLedger({ cacheRoot, lineageDigest,
      cacheIdentity: { model: MODEL, requestProfile: REQUEST_PROFILE },
      startingMissing: 1, maximumAttempts: 1, successfulShardCeiling: 1 });
    const delegate: BenchSignalExtractor = { extract: vi.fn(async (input) => {
      await input.onTransportAttempt?.(input.abortSignal);
      return providerBackedResult('{"interpretations":[]}');
    }) };
    const request = { systemPrompt: SYSTEM_PROMPT, sourceCorpus: sourceCorpusWithAssertions(),
      userPrompt: userPromptWithAssertions() };
    const cacheKey = computeCacheKey(MODEL, REQUEST_PROFILE, request.systemPrompt, request.userPrompt);
    const extractor = createCachingSignalExtractor({ delegate, config: extractionConfig(), cacheRoot,
      onTransportAttempt: ledger.reserveAttemptOrdinal, providerAttemptLineageDigest: lineageDigest,
      onLiveExtractionOutcome: ledger.recordTransportOutcome,
      onLiveProviderExtractionSucceeded: ledger.commitSuccessfulShard,
      onLiveExtractionFailed: ledger.abandonPendingShard });

    await expect(extractor.extract(request)).rejects.toThrow(/physical responses/u);
    expect(ledger.snapshot()).toMatchObject({ attempts: 1, successfulShards: 0,
      pendingKeys: [], unresolvedAttempts: [],
      settledAttempts: [{ attemptOrdinal: 1, cacheKey }],
      telemetry: { unresolvedTransportAttempts: 0, usageUnknownAttempts: 1 } });
    expect(inspectCachedRawExtraction(cacheRoot, cacheKey, MODEL, REQUEST_PROFILE).status).toBe("missing");
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
    })).resolves.toMatchObject({ rawJson: '{"interpretations":[]}' });

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
        sourceCorpus: sourceCorpusWithAssertions(), userPrompt: userPromptWithAssertions(),
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
      onTransportAttempt: ledger.reserveAttemptOrdinal,
      providerAttemptLineageDigest: "e".repeat(64),
      onLiveExtractionOutcome: ledger.recordTransportOutcome,
      onLiveProviderExtractionSucceeded: ledger.commitSuccessfulShard,
      onLiveExtractionFailed: ledger.abandonPendingShard
    });

    await expect(extractor.extract({
      systemPrompt: SYSTEM_PROMPT,
      sourceCorpus: sourceCorpusWithAssertions(), userPrompt: userPromptWithAssertions()
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

  it("does not recheck a strict empty request when retries are disabled", async () => {
    const delegate: BenchSignalExtractor = {
      extract: vi.fn(async () => providerBackedResult('{"interpretations":[]}'))
    };

    await extractLiveDelegate({
      delegate,
      request: {
        systemPrompt: SYSTEM_PROMPT,
        sourceCorpus: sourceCorpusWithAssertions(), userPrompt: userPromptWithAssertions(),
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
      request: { systemPrompt: SYSTEM_PROMPT, sourceCorpus: sourceCorpusWithAssertions(), userPrompt: userPromptWithAssertions() },
      stats: undefined,
      onFailure: vi.fn()
    });

    expect(delegate.extract).toHaveBeenCalledOnce();
    expect(result.rawJson).toBe(rawJson);
  });
});

async function withLoopbackResponse(
  respond: (response: ServerResponse) => void,
  run: (providerUrl: string) => Promise<void>
): Promise<void> {
  const server = createServer((_request, response) => respond(response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}/v1`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
