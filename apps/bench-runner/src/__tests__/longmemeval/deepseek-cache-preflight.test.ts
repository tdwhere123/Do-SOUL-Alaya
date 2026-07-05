import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import {
  cacheFilePath,
  computeCacheKey
} from "../../longmemeval/compile-seed-cache.js";
import {
  createCompileSeedRunner,
  DEEPSEEK_WARM_SUBSTRATE_CACHE_ROOT,
  DEEPSEEK_WARM_SUBSTRATE_MODEL,
  isDeepSeekWarmSubstrateCacheRoot,
  preflightDeepSeekWarmSubstrateCache,
  type BenchSignalExtractor,
  type CompileSeedExtractionConfig
} from "../../longmemeval/compile-seed.js";
import * as deepseekCacheConfig from "../../longmemeval/deepseek-cache-config.js";
import {
  computeSystemPromptSha256,
  writeExtractionCacheManifest,
  type ExtractionCacheManifest
} from "../../longmemeval/extraction-cache-manifest.js";
import { buildCompileSeedDaemon, signalsEnvelope } from "./compile-seed-fixture.js";

const CREDENTIALLED_CONFIG: CompileSeedExtractionConfig = {
  providerUrl: "https://api.deepseek.com/v1",
  model: DEEPSEEK_WARM_SUBSTRATE_MODEL,
  apiKey: "cache-only-test-key"
};

function writeManifest(
  cacheRoot: string,
  overrides: { readonly coverage?: number } = {}
): void {
  writeExtractionCacheManifest(cacheRoot, {
    schema_version: 1,
    extraction_model: DEEPSEEK_WARM_SUBSTRATE_MODEL,
    provider_url: "https://api.deepseek.com/v1",
    system_prompt_sha256: computeSystemPromptSha256(OFFICIAL_API_SYSTEM_PROMPT),
    cache_key_algo: "sha256(model\\0systemPrompt\\0turnContent)",
    dataset: "longmemeval-s",
    dataset_revision: "rev",
    requested_turns: 1,
    cached_turns: 1,
    coverage: overrides.coverage ?? 1,
    storage: "git-tracked",
    built_at: "2026-07-01T00:00:00Z",
    builder: "test"
  });
}

function writeCacheShard(cacheRoot: string, turnContent: string, rawJson: string): void {
  const cacheKey = computeCacheKey(
    DEEPSEEK_WARM_SUBSTRATE_MODEL,
    OFFICIAL_API_SYSTEM_PROMPT,
    turnContent
  );
  const filePath = cacheFilePath(cacheRoot, cacheKey);
  mkdirSync(join(cacheRoot, cacheKey.slice(0, 2)), { recursive: true });
  writeFileSync(
    filePath,
    `${JSON.stringify({
      model: DEEPSEEK_WARM_SUBSTRATE_MODEL,
      cache_key: cacheKey,
      raw_json: rawJson,
      extracted_at: "2026-07-01T00:00:00Z"
    })}\n`,
    "utf8"
  );
}

describe("DeepSeek warm-substrate preflight", () => {
  let cacheRoot: string;

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "deepseek-cache-preflight-"));
  });

  afterEach(async () => {
    await rm(cacheRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("no-ops on non-DeepSeek cache roots", () => {
    writeManifest(cacheRoot, { coverage: 0.5 });
    expect(() =>
      preflightDeepSeekWarmSubstrateCache({
        cacheRoot,
        config: CREDENTIALLED_CONFIG
      })
    ).not.toThrow();
  });

  it("no-ops when cache root is warm-substrate but extraction model differs", () => {
    if (!existsSync(DEEPSEEK_WARM_SUBSTRATE_CACHE_ROOT)) {
      return;
    }
    expect(() =>
      preflightDeepSeekWarmSubstrateCache({
        cacheRoot: DEEPSEEK_WARM_SUBSTRATE_CACHE_ROOT,
        config: {
          providerUrl: "https://example.test/v1",
          model: "test-extraction-model",
          apiKey: "test-key"
        }
      })
    ).not.toThrow();
  });

  it("requires coverage=1 for warm-substrate manifests", () => {
    const manifest: ExtractionCacheManifest = {
      schema_version: 1,
      extraction_model: DEEPSEEK_WARM_SUBSTRATE_MODEL,
      provider_url: "https://api.deepseek.com/v1",
      system_prompt_sha256: computeSystemPromptSha256(OFFICIAL_API_SYSTEM_PROMPT),
      cache_key_algo: "sha256(model\\0systemPrompt\\0turnContent)",
      dataset: "longmemeval-s",
      dataset_revision: "rev",
      requested_turns: 1,
      cached_turns: 1,
      coverage: 0.5,
      storage: "git-tracked",
      built_at: "2026-07-01T00:00:00Z",
      builder: "test"
    };
    expect(() =>
      deepseekCacheConfig.validateDeepSeekWarmSubstrateManifest({
        manifest,
        config: CREDENTIALLED_CONFIG
      })
    ).toThrow(/coverage=1/);
  });

  it("passes on the committed warm-substrate cache when present on disk", () => {
    if (!existsSync(DEEPSEEK_WARM_SUBSTRATE_CACHE_ROOT)) {
      return;
    }
    expect(isDeepSeekWarmSubstrateCacheRoot(DEEPSEEK_WARM_SUBSTRATE_CACHE_ROOT)).toBe(
      true
    );
    expect(() =>
      preflightDeepSeekWarmSubstrateCache({
        cacheRoot: DEEPSEEK_WARM_SUBSTRATE_CACHE_ROOT,
        config: CREDENTIALLED_CONFIG
      })
    ).not.toThrow();
  });
});

describe("cache-only compile seed smoke", () => {
  let cacheRoot: string;

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "deepseek-cache-smoke-"));
    writeManifest(cacheRoot);
  });

  afterEach(async () => {
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("reports cacheHits>0 and llmCalls=0 without calling the live extractor", async () => {
    const turnContent = "I moved to Berlin and started a new job in March 2024.";
    writeCacheShard(
      cacheRoot,
      turnContent,
      signalsEnvelope([{ distilled: "Alice lives in Berlin.", matched: "moved to Berlin" }])
    );

    const liveExtract = vi.fn(async () => {
      throw new Error("live extraction must not run in cache-only smoke");
    }) satisfies BenchSignalExtractor;

    const runner = createCompileSeedRunner({
      config: CREDENTIALLED_CONFIG,
      cacheRoot,
      requiredTurnContents: [turnContent],
      extractorFactory: () => ({ extract: liveExtract })
    });
    const daemon = buildCompileSeedDaemon(() => ({
      memoryId: "memory-cache-smoke",
      signalId: "signal-cache-smoke",
      proposalId: "proposal-cache-smoke",
      evidenceId: "evidence-cache-smoke",
      truncated: false,
      charsClipped: 0
    }));

    await runner.seedTurn({
      daemon,
      turnContent,
      evidenceRefBase: "q-smoke-t0",
      seedIndex: 0,
      workspaceId: "ws-smoke",
      runId: "run-smoke"
    });

    expect(runner.stats.cacheHits).toBeGreaterThan(0);
    expect(runner.stats.llmCalls).toBe(0);
    expect(liveExtract).not.toHaveBeenCalled();
  });
});
