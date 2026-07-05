import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import {
  createCachingSignalExtractor,
  createCompileSeedRunner,
  preflightExtractionCache,
  type BenchSignalExtractor,
  type CompileSeedExtractionConfig
} from "../../longmemeval/compile-seed.js";
import {
  cacheFilePath,
  computeCacheKey
} from "../../longmemeval/compile-seed-cache.js";
import { buildCompileSeedDaemon, CREDENTIALLED_CONFIG } from "./compile-seed-fixture.js";
import {
  computeSystemPromptSha256,
  writeExtractionCacheManifest,
  type ExtractionCacheManifest
} from "../../longmemeval/extraction-cache-manifest.js";

const CONFIG: CompileSeedExtractionConfig = {
  providerUrl: "https://yunwu.ai/v1",
  model: "gpt-5.4-mini",
  apiKey: "test-key"
};

function manifestFor(
  overrides: Partial<ExtractionCacheManifest> = {}
): ExtractionCacheManifest {
  return {
    schema_version: 1,
    extraction_model: "gpt-5.4-mini",
    provider_url: "https://yunwu.ai/v1",
    system_prompt_sha256: computeSystemPromptSha256(OFFICIAL_API_SYSTEM_PROMPT),
    cache_key_algo: "sha256(model\\0systemPrompt\\0turnContent)",
    dataset: "longmemeval-s",
    dataset_revision: "rev",
    requested_turns: 100,
    cached_turns: 100,
    coverage: 1,
    storage: "git-tracked",
    built_at: "2026-05-27T00:00:00Z",
    builder: "test",
    ...overrides
  };
}

describe("preflightExtractionCache", () => {
  let cacheRoot: string;

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "extraction-preflight-"));
  });

  afterEach(async () => {
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("warns and allows when no manifest exists (first-ever build)", () => {
    const warn = vi.fn();
    expect(() =>
      preflightExtractionCache({
        cacheRoot,
        config: CONFIG,
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
        warn
      })
    ).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/first-ever build/u);
  });

  it("passes silently when model, prompt-sha, and coverage all match", () => {
    writeExtractionCacheManifest(cacheRoot, manifestFor());
    const warn = vi.fn();
    expect(() =>
      preflightExtractionCache({
        cacheRoot,
        config: CONFIG,
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
        warn
      })
    ).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it("throws on a model mismatch, naming both models", () => {
    writeExtractionCacheManifest(
      cacheRoot,
      manifestFor({ extraction_model: "gpt-4.1-mini" })
    );
    expect(() =>
      preflightExtractionCache({
        cacheRoot,
        config: CONFIG,
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
      })
    ).toThrow(/extraction model mismatch.*gpt-5\.4-mini.*gpt-4\.1-mini/su);
  });

  it("throws on a system-prompt sha drift", () => {
    writeExtractionCacheManifest(
      cacheRoot,
      manifestFor({ system_prompt_sha256: "f".repeat(64) })
    );
    expect(() =>
      preflightExtractionCache({
        cacheRoot,
        config: CONFIG,
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
      })
    ).toThrow(/system prompt drift/u);
  });

  it("throws on a coverage gap when allow-live is not set", () => {
    writeExtractionCacheManifest(
      cacheRoot,
      manifestFor({ cached_turns: 50, coverage: 0.5 })
    );
    expect(() =>
      preflightExtractionCache({
        cacheRoot,
        config: CONFIG,
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
      })
    ).toThrow(/coverage 50\.0% is below.*--allow-live-extraction/su);
  });

  it("allows a coverage gap when allowLiveExtraction is true", () => {
    writeExtractionCacheManifest(
      cacheRoot,
      manifestFor({ cached_turns: 50, coverage: 0.5 })
    );
    expect(() =>
      preflightExtractionCache({
        cacheRoot,
        config: CONFIG,
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
        allowLiveExtraction: true
      })
    ).not.toThrow();
  });

  // @anchor finding-1-no-coverage-gap: a manifest WITHOUT a coverage field is a
  // gap, not a silent pass. extraction-fill always writes coverage, so a
  // coverage-less manifest means the cache was never filled against a known
  // denominator.
  it("throws on a manifest with NO coverage field when allow-live is not set", () => {
    const { coverage: _omitCoverage, ...withoutCoverage } = manifestFor();
    void _omitCoverage;
    writeExtractionCacheManifest(
      cacheRoot,
      withoutCoverage as typeof withoutCoverage & { coverage?: number }
    );
    expect(() =>
      preflightExtractionCache({
        cacheRoot,
        config: CONFIG,
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
      })
    ).toThrow(/no coverage field.*--allow-live-extraction/su);
  });

  it("allows a NO-coverage manifest when allowLiveExtraction is true", () => {
    const { coverage: _omitCoverage, ...withoutCoverage } = manifestFor();
    void _omitCoverage;
    writeExtractionCacheManifest(
      cacheRoot,
      withoutCoverage as typeof withoutCoverage & { coverage?: number }
    );
    expect(() =>
      preflightExtractionCache({
        cacheRoot,
        config: CONFIG,
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
        allowLiveExtraction: true
      })
    ).not.toThrow();
  });

  it("throws when requireManifest is set and manifest is absent", () => {
    expect(() =>
      preflightExtractionCache({
        cacheRoot,
        config: CONFIG,
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
        requireManifest: true
      })
    ).toThrow(/manifest is missing/u);
  });

  it("requires full coverage when minimumCoverage is 1", () => {
    writeExtractionCacheManifest(
      cacheRoot,
      manifestFor({ cached_turns: 99, coverage: 0.99 })
    );
    expect(() =>
      preflightExtractionCache({
        cacheRoot,
        config: CONFIG,
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
        minimumCoverage: 1
      })
    ).toThrow(/below the 100% threshold/u);
  });
});

function writeCacheShard(
  cacheRoot: string,
  model: string,
  turnContent: string,
  rawJson: string
): void {
  const cacheKey = computeCacheKey(model, OFFICIAL_API_SYSTEM_PROMPT, turnContent);
  const filePath = cacheFilePath(cacheRoot, cacheKey);
  mkdirSync(join(cacheRoot, cacheKey.slice(0, 2)), { recursive: true });
  writeFileSync(
    filePath,
    `${JSON.stringify({
      model,
      cache_key: cacheKey,
      raw_json: rawJson,
      extracted_at: "2026-07-01T00:00:00Z"
    })}\n`,
    "utf8"
  );
}

describe("cache-only compile seed smoke", () => {
  let cacheRoot: string;

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "extraction-cache-smoke-"));
    writeExtractionCacheManifest(cacheRoot, manifestFor({ extraction_model: CREDENTIALLED_CONFIG.model }));
  });

  afterEach(async () => {
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("reports cacheHits>0 and llmCalls=0 without calling the live extractor", async () => {
    const turnContent = "I moved to Berlin and started a new job in March 2024.";
    writeCacheShard(
      cacheRoot,
      CREDENTIALLED_CONFIG.model,
      turnContent,
      '{"signals":[{"distilled":"Alice lives in Berlin.","matched":"moved to Berlin"}]}'
    );

    const liveExtract: BenchSignalExtractor = {
      extract: vi.fn(async () => {
        throw new Error("live extraction must not run in cache-only smoke");
      })
    };

    const runner = createCompileSeedRunner({
      config: CREDENTIALLED_CONFIG,
      cacheRoot,
      requiredTurnContents: [turnContent],
      extractorFactory: () => liveExtract
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

describe("single-source extraction model", () => {
  let cacheRoot: string;

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "extraction-single-source-"));
  });

  afterEach(async () => {
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("writes the same model into the cache fixture that the config carries", async () => {
    const delegate: BenchSignalExtractor = {
      extract: vi.fn(async () => ({ rawJson: '{"signals":[]}' }))
    };
    const extractor = createCachingSignalExtractor({
      delegate,
      model: "gpt-5.4-mini",
      cacheRoot
    });
    await extractor.extract({ systemPrompt: "sys", userPrompt: "turn" });

    // The cache-key model component and the persisted fixture model both come
    // from the single `model` field — there is no independent re-derivation.
    const shardDirs = readdirSync(cacheRoot);
    const shardDir = shardDirs.find((d) => d !== "manifest.json");
    expect(shardDir).toBeDefined();
    const shardFiles = readdirSync(join(cacheRoot, shardDir as string));
    const fixturePath = join(cacheRoot, shardDir as string, shardFiles[0] as string);
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      model: string;
    };
    expect(fixture.model).toBe("gpt-5.4-mini");
  });

  it("misses the cache when the model changes (model is in the cache key)", async () => {
    const delegate: BenchSignalExtractor = {
      extract: vi.fn(async () => ({ rawJson: '{"signals":[]}' }))
    };
    const writer = createCachingSignalExtractor({
      delegate,
      model: "gpt-5.4-mini",
      cacheRoot
    });
    await writer.extract({ systemPrompt: "sys", userPrompt: "turn" });
    expect(delegate.extract).toHaveBeenCalledTimes(1);

    // A different model -> different cache key -> miss -> a fresh live call.
    const reader = createCachingSignalExtractor({
      delegate,
      model: "gpt-4.1-mini",
      cacheRoot
    });
    await reader.extract({ systemPrompt: "sys", userPrompt: "turn" });
    expect(delegate.extract).toHaveBeenCalledTimes(2);
  });
});
