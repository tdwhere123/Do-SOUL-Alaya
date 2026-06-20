import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OfficialApiGardenProvider } from "@do-soul/alaya-soul";
import {
  computeNextTurnSeedRefs,
  createCachingSignalExtractor,
  createCompileSeedRunner,
  createGardenHttpExtractor,
  extractContentFromChatCompletionBody,
  resolveCompileSeedExtractionConfig,
  toSeedExtractionPathKpi,
  type BenchSignalExtractor,
  type CompileSeedDaemon,
  type CompileSeedExtractionConfig,
  type CompileSeedExtractionStats
} from "../../longmemeval/compile-seed.js";
import type { BenchSignalSeedInput, SeededMemoryResult } from "../../harness/daemon.js";
import {
  buildCompileSeedDaemon,
  CREDENTIALLED_CONFIG,
  OFFLINE_CONFIG,
  signalsEnvelope
} from "./compile-seed-fixture.js";
import { createUnscoredMaterializedSeedError } from "../../harness/seed-errors.js";

describe("createCachingSignalExtractor", () => {
  let cacheRoot: string;

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "compile-seed-cache-"));
  });

  afterEach(async () => {
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("delegates to the real extractor on a cache miss", async () => {
    const delegate: BenchSignalExtractor = {
      extract: vi.fn(async () => ({ rawJson: '{"signals":[]}' }))
    };
    const stats: CompileSeedExtractionStats = {
      path: "official_api_compile",
      cacheHits: 0,
      llmCalls: 0,
      offlineFallbacks: 0,
      liveExtractionFailures: 0,
      cachedExtractionFailures: 0,
      factsProduced: 0,
      signalsDropped: 0,
      signalsDroppedByReason: { candidate_absent: 0, materialization_error: 0 },
      parseDropped: 0,
      compileOverflowDropped: 0,
      lastTurnRawSignalCount: 0,
      lastTurnDraftCount: 0,
      lastExtractionSource: null
    };
    const extractor = createCachingSignalExtractor({
      delegate,
      model: "test-model",
      cacheRoot,
      stats
    });

    const result = await extractor.extract({
      systemPrompt: "sys",
      userPrompt: "user"
    });

    expect(result.rawJson).toBe('{"signals":[]}');
    expect(delegate.extract).toHaveBeenCalledTimes(1);
    expect(stats.llmCalls).toBe(1);
    expect(stats.cacheHits).toBe(0);
    expect(stats.liveExtractionFailures).toBe(0);
    expect(stats.cachedExtractionFailures).toBe(0);
    expect(stats.lastExtractionSource).toBe("live");
  });

  it("serves a second extraction from the on-disk fixture with zero LLM calls", async () => {
    const delegate: BenchSignalExtractor = {
      extract: vi.fn(async () => ({ rawJson: '{"signals":[{"x":1}]}' }))
    };
    const firstStats: CompileSeedExtractionStats = {
      path: "official_api_compile",
      cacheHits: 0,
      llmCalls: 0,
      offlineFallbacks: 0,
      liveExtractionFailures: 0,
      cachedExtractionFailures: 0,
      factsProduced: 0,
      signalsDropped: 0,
      signalsDroppedByReason: { candidate_absent: 0, materialization_error: 0 },
      parseDropped: 0,
      compileOverflowDropped: 0,
      lastTurnRawSignalCount: 0,
      lastTurnDraftCount: 0,
      lastExtractionSource: null
    };
    const firstRun = createCachingSignalExtractor({
      delegate,
      model: "test-model",
      cacheRoot,
      stats: firstStats
    });
    await firstRun.extract({ systemPrompt: "sys", userPrompt: "turn-A" });
    expect(delegate.extract).toHaveBeenCalledTimes(1);

    // A fresh extractor sharing the same fixture must not call the delegate.
    const secondStats: CompileSeedExtractionStats = {
      path: "official_api_compile",
      cacheHits: 0,
      llmCalls: 0,
      offlineFallbacks: 0,
      liveExtractionFailures: 0,
      cachedExtractionFailures: 0,
      factsProduced: 0,
      signalsDropped: 0,
      signalsDroppedByReason: { candidate_absent: 0, materialization_error: 0 },
      parseDropped: 0,
      compileOverflowDropped: 0,
      lastTurnRawSignalCount: 0,
      lastTurnDraftCount: 0,
      lastExtractionSource: null
    };
    const secondRun = createCachingSignalExtractor({
      delegate,
      model: "test-model",
      cacheRoot,
      stats: secondStats
    });
    const cached = await secondRun.extract({
      systemPrompt: "sys",
      userPrompt: "turn-A"
    });

    expect(delegate.extract).toHaveBeenCalledTimes(1);
    expect(secondStats.cacheHits).toBe(1);
    expect(secondStats.llmCalls).toBe(0);
    expect(secondStats.liveExtractionFailures).toBe(0);
    expect(secondStats.cachedExtractionFailures).toBe(0);
    expect(secondStats.lastExtractionSource).toBe("cache");
    expect(cached.rawJson).toBe('{"signals":[{"x":1}]}');
  });

  it("keys the cache on the prompt: a different user prompt is a fresh miss", async () => {
    const delegate: BenchSignalExtractor = {
      extract: vi
        .fn<BenchSignalExtractor["extract"]>()
        .mockResolvedValueOnce({ rawJson: '{"signals":[{"a":1}]}' })
        .mockResolvedValueOnce({ rawJson: '{"signals":[{"b":2}]}' })
    };
    const extractor = createCachingSignalExtractor({
      delegate,
      model: "test-model",
      cacheRoot
    });

    const first = await extractor.extract({ systemPrompt: "s", userPrompt: "A" });
    const second = await extractor.extract({ systemPrompt: "s", userPrompt: "B" });

    expect(first.rawJson).toBe('{"signals":[{"a":1}]}');
    expect(second.rawJson).toBe('{"signals":[{"b":2}]}');
    expect(delegate.extract).toHaveBeenCalledTimes(2);
  });
});

describe("resolveCompileSeedExtractionConfig", () => {
  it("resolves a null key when no garden secret ref is set", () => {
    const config = resolveCompileSeedExtractionConfig({
      OFFICIAL_API_GARDEN_MODEL: "gpt-5.4-mini"
    });
    expect(config.apiKey).toBeNull();
    expect(config.model).toBe("gpt-5.4-mini");
    expect(config.providerUrl).toBe("https://yunwu.ai/v1");
  });

  it("throws when neither env model nor manifest can resolve the model", () => {
    expect(() => resolveCompileSeedExtractionConfig({})).toThrow(
      /extraction model is unresolved/u
    );
  });

  it("falls back to the manifest extraction_model when env is unset", () => {
    const config = resolveCompileSeedExtractionConfig(
      {},
      {
        schema_version: 1,
        extraction_model: "gpt-5.4-mini",
        provider_url: "https://yunwu.ai/v1",
        system_prompt_sha256: "deadbeef",
        cache_key_algo: "sha256(model\\0systemPrompt\\0turnContent)",
        dataset: "longmemeval-s",
        dataset_revision: "rev",
        storage: "git-tracked",
        built_at: "2026-05-27T00:00:00Z",
        builder: "test"
      }
    );
    expect(config.model).toBe("gpt-5.4-mini");
    expect(config.providerUrl).toBe("https://yunwu.ai/v1");
  });
});
