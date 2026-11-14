import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const boundary = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../../scripts/test-support/provider-free/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
import { readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SOURCE_STATEMENTS_PROMPT } from "@do-soul/alaya-soul";
import { createCachingSignalExtractor, resolveCompileSeedExtractionConfig, type BenchSignalExtractor, type CompileSeedExtractionStats } from "../../../runs/compile-seed.js";
import { sourceStatementRequests, sourceStatementSession } from "../../../runs/extraction/source-statement-request.js";
import { providerBackedResponseResult, fixtureAttemptAuthority, TEST_EXTRACTION_PROVIDER_URL,
  writeExtractionCacheTestManifest } from "../extraction/extraction-cache-test-fixture.js";

const config = { model: "test-model", modelFamily: "test-model", providerUrl: TEST_EXTRACTION_PROVIDER_URL,
  requestProfile: "provider-default-v1" as const, sourcePacking: "session-statements" as const };
const messages = [{ message_id: "recorded-user", role: "user" as const, content: "I have a dog." }];
const request = { systemPrompt: SOURCE_STATEMENTS_PROMPT, userPrompt: sourceStatementRequests(messages)[0]!.userPrompt,
  sourceCorpus: sourceStatementSession(messages).rendered.content };
const rawJson = JSON.stringify({ messages: [{ message_id: "recorded-user",
  statements: [{ text: "The user has a dog.", relation: "recorded statement" }] }] });
let cacheRoot: string;
beforeEach(async () => {
  cacheRoot = await mkdtemp(join(tmpdir(), "statement-cache-authority-"));
  writeExtractionCacheTestManifest({ cacheRoot, model: config.model, systemPrompt: SOURCE_STATEMENTS_PROMPT });
});
afterEach(async () => { await rm(cacheRoot, { recursive: true, force: true }); });
afterAll(() => { boundary.restore(); expect(boundary.violations).toEqual([]); });
function emptyStats(): CompileSeedExtractionStats {
  return { path: "official_api_compile", cacheHits: 0, llmCalls: 0, offlineFallbacks: 0,
    liveExtractionFailures: 0, cachedExtractionFailures: 0, factsProduced: 0, signalsDropped: 0,
    signalsDroppedByReason: { candidate_absent: 0, materialization_drop: 0 }, parseDropped: 0, compileOverflowDropped: 0,
    lastTurnRawSignalCount: 0, lastTurnDraftCount: 0, lastExtractionSource: null, lastRawJsonSha256: null };
}

describe("statement cache execution authority", () => {
  it("records one authorized live extraction and replays its exact response without another delegate call", async () => {
    const delegate = { extract: vi.fn<BenchSignalExtractor["extract"]>(input => providerBackedResponseResult(input, rawJson)) };
    const liveStats = emptyStats();
    const live = createCachingSignalExtractor({ cacheRoot, config, delegate, stats: liveStats,
      ...fixtureAttemptAuthority({ cacheRoot, model: config.model, requestProfile: config.requestProfile }) });
    expect(await live.extract(request)).toMatchObject({ rawJson });
    expect(delegate.extract).toHaveBeenCalledOnce();
    expect(liveStats).toMatchObject({ llmCalls: 1, cacheHits: 0, liveExtractionFailures: 0, cachedExtractionFailures: 0, lastExtractionSource: "live" });
    const cachedStats = emptyStats();
    const cached = createCachingSignalExtractor({ cacheRoot, config, delegate, stats: cachedStats });
    expect(await cached.extract(request)).toMatchObject({ rawJson });
    expect(delegate.extract).toHaveBeenCalledOnce();
    expect(cachedStats).toMatchObject({ llmCalls: 0, cacheHits: 1, liveExtractionFailures: 0, cachedExtractionFailures: 0,
      lastExtractionSource: "cache", lastRawJsonSha256: liveStats.lastRawJsonSha256 });
  });

  it("refuses a physical provider response whose completion authority is absent", async () => {
    const delegate = { extract: vi.fn<BenchSignalExtractor["extract"]>(async input => ({ ...await providerBackedResponseResult(input, rawJson), responseMetadata: undefined })) };
    const extractor = createCachingSignalExtractor({ cacheRoot, config, delegate,
      ...fixtureAttemptAuthority({ cacheRoot, model: config.model, requestProfile: config.requestProfile }) });
    await expect(extractor.extract(request)).rejects.toThrow("failed to persist extraction cache shard");
    expect(delegate.extract).toHaveBeenCalledOnce();
    expect(readdirSync(cacheRoot).filter(entry => /^[0-9a-f]{2}$/u.test(entry))).toEqual([]);
  });

  it("refuses synthetic empty output that never reserved a physical provider attempt", async () => {
    const delegate = { extract: vi.fn(async () => ({ rawJson: '{"messages":[{"message_id":"recorded-user","statements":[]}]}' })) };
    const authority = fixtureAttemptAuthority({ cacheRoot, model: config.model, requestProfile: config.requestProfile });
    const extractor = createCachingSignalExtractor({ cacheRoot, config, delegate, ...authority, requireProviderBackedExtraction: true });
    await expect(extractor.extract(request)).rejects.toThrow();
    expect(delegate.extract).toHaveBeenCalledOnce();
    expect(readdirSync(cacheRoot).filter(entry => /^[0-9a-f]{2}$/u.test(entry))).toEqual([]);
  });
});

describe("extraction configuration", () => {
  it("requires an explicit request profile when no cache manifest exists", () => {
    expect(() => resolveCompileSeedExtractionConfig({ OFFICIAL_API_GARDEN_MODEL: "gpt-5.4-mini",
      OFFICIAL_API_GARDEN_PROVIDER_URL: "https://provider.example/v1" }))
      .toThrow(/request profile.*unresolved|ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE/iu);
  });
  it("resolves the closed request profile independently of the model", () => {
    expect(resolveCompileSeedExtractionConfig({ OFFICIAL_API_GARDEN_MODEL: "arbitrary-model",
      ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE: "deepseek-v4-nonthinking-v1", OFFICIAL_API_GARDEN_PROVIDER_URL: "https://provider.example/v1" })
      .requestProfile).toBe("deepseek-v4-nonthinking-v1");
  });
  it("rejects an unknown request profile", () => {
    expect(() => resolveCompileSeedExtractionConfig({ OFFICIAL_API_GARDEN_MODEL: "arbitrary-model",
      ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE: "deepseek-auto", OFFICIAL_API_GARDEN_PROVIDER_URL: "https://provider.example/v1" }))
      .toThrow(/must be one of.*provider-default-v1.*deepseek-v4-nonthinking-v1/iu);
  });
  it("keeps the exact request model separate from its comparison family", () => {
    expect(resolveCompileSeedExtractionConfig({ OFFICIAL_API_GARDEN_MODEL: "deepseek-v4-flash-free",
      ALAYA_BENCH_EXTRACTION_MODEL_FAMILY: "deepseek-v4-flash", ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE: "provider-default-v1",
      OFFICIAL_API_GARDEN_PROVIDER_URL: "https://provider.example/v1" })).toMatchObject({ model: "deepseek-v4-flash-free", modelFamily: "deepseek-v4-flash" });
  });
  it("requires an explicit provider URL when no cache manifest exists", () => {
    expect(() => resolveCompileSeedExtractionConfig({ OFFICIAL_API_GARDEN_MODEL: "gpt-5.4-mini",
      ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE: "provider-default-v1" })).toThrow(/provider URL is unresolved.*OFFICIAL_API_GARDEN_PROVIDER_URL/iu);
  });
  it("resolves a null key when no garden secret ref is set", () => {
    expect(resolveCompileSeedExtractionConfig({ OFFICIAL_API_GARDEN_MODEL: "gpt-5.4-mini",
      ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE: "provider-default-v1", OFFICIAL_API_GARDEN_PROVIDER_URL: "https://provider.example/v1" }))
      .toMatchObject({ apiKey: null, model: "gpt-5.4-mini", providerUrl: "https://provider.example/v1" });
  });
  it("refuses unresolved models", () => {
    expect(() => resolveCompileSeedExtractionConfig({ OFFICIAL_API_GARDEN_PROVIDER_URL: "https://provider.example/v1",
      ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE: "provider-default-v1" })).toThrow(/extraction model is unresolved/u);
  });
  it("reads a historical manifest model when the environment is unset", () => {
    expect(resolveCompileSeedExtractionConfig({ ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE: "provider-default-v1" }, {
      schema_version: 1, extraction_model: "gpt-5.4-mini", provider_url: "https://provider.example/v1",
      system_prompt_sha256: "deadbeef", cache_key_algo: "sha256(model\\0systemPrompt\\0turnContent)", dataset: "longmemeval-s",
      dataset_revision: "rev", storage: "git-tracked", built_at: "2026-05-27T00:00:00Z", builder: "test" }))
      .toMatchObject({ model: "gpt-5.4-mini", providerUrl: "https://provider.example/v1" });
  });
  it("keeps logical cache identity separate from a physical provider route", () => {
    expect(resolveCompileSeedExtractionConfig({ OFFICIAL_API_GARDEN_MODEL: "DeepSeek-V4-Flash",
      OFFICIAL_API_GARDEN_PROVIDER_URL: "https://logical.example/v1", ALAYA_BENCH_EXTRACTION_MODEL_FAMILY: "deepseek-v4-flash-nonthinking",
      ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE: "deepseek-v4-nonthinking-v1", ALAYA_BENCH_EXTRACTION_TRANSPORT_PROVIDER_URL: "https://physical.example/v1/",
      ALAYA_BENCH_EXTRACTION_TRANSPORT_MODEL: "deepseek-v4-flash" })).toMatchObject({ providerUrl: "https://logical.example/v1",
        model: "DeepSeek-V4-Flash", transportProviderUrl: "https://physical.example/v1", transportModel: "deepseek-v4-flash" });
  });
});
