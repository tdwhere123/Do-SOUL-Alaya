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
  resolveBenchRequireExtractionCacheManifest,
  type BenchSignalExtractor,
  type CompileSeedExtractionConfig
} from "../../longmemeval/compile-seed.js";
import {
  cacheFilePath,
  computeCacheKey
} from "../../longmemeval/compile-seed-cache.js";
import { buildCompileSeedDaemon, CREDENTIALLED_CONFIG } from "./compile-seed-fixture.js";
import {
  TEST_EXTRACTION_PROVIDER_URL,
  writeExtractionCacheTestManifest
} from "./extraction-cache-test-fixture.js";
import {
  computeSystemPromptSha256,
  EXTRACTION_CACHE_KEY_ALGO,
  writeExtractionCacheManifest,
  type ExtractionCacheManifestV3
} from "../../longmemeval/extraction-cache-manifest.js";

const CONFIG: CompileSeedExtractionConfig = {
  providerUrl: "https://yunwu.ai/v1",
  model: "gpt-5.4-mini",
  requestProfile: "provider-default-v1",
  apiKey: "test-key"
};

function manifestFor(
  overrides: Partial<Omit<ExtractionCacheManifestV3, "schema_version">> = {}
): ExtractionCacheManifestV3 {
  return {
    schema_version: 3,
    extraction_model: "gpt-5.4-mini",
    model_family: "gpt-5.4-mini",
    request_profile: "provider-default-v1",
    provider_url: "https://yunwu.ai/v1",
    system_prompt_sha256: computeSystemPromptSha256(OFFICIAL_API_SYSTEM_PROMPT),
    cache_key_algo: EXTRACTION_CACHE_KEY_ALGO,
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

  it("throws on a cache-key algorithm drift", () => {
    writeExtractionCacheManifest(
      cacheRoot,
      manifestFor({ cache_key_algo: "sha256(legacy)" })
    );
    expect(() =>
      preflightExtractionCache({
        cacheRoot,
        config: CONFIG,
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
      })
    ).toThrow(/cache-key algorithm mismatch/u);
  });

  it("throws when an explicit comparison model family disagrees with the manifest", () => {
    writeExtractionCacheManifest(
      cacheRoot,
      {
        ...manifestFor(),
        model_family: "gpt-5-family"
      }
    );
    expect(() =>
      preflightExtractionCache({
        cacheRoot,
        config: { ...CONFIG, modelFamily: "other-family" },
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
      })
    ).toThrow(/model family mismatch/u);
  });

  it("rejects a v2 cache even when non-thinking is explicit", () => {
    const { request_profile: _profile, ...legacy } = manifestFor();
    writeExtractionCacheManifest(cacheRoot, { ...legacy, schema_version: 2 });
    expect(() => preflightExtractionCache({
      cacheRoot,
      config: { ...CONFIG, requestProfile: "deepseek-v4-nonthinking-v1" },
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
    })).toThrow(/request profile mismatch|schema_version 2/u);
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

  it("rejects provider drift before a live fill can mix cache sources", () => {
    writeExtractionCacheManifest(cacheRoot, manifestFor());
    expect(() =>
      preflightExtractionCache({
        cacheRoot,
        config: { ...CONFIG, providerUrl: "https://opencode.ai/zen/v1" },
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
        allowLiveExtraction: true
      })
    ).toThrow(/provider URL mismatch/u);
  });

  it("uses frozen manifest provenance when provider drift cannot trigger a live call", () => {
    writeExtractionCacheManifest(cacheRoot, manifestFor());
    expect(() =>
      preflightExtractionCache({
        cacheRoot,
        config: { ...CONFIG, providerUrl: "https://opencode.ai/zen/v1" },
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
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
    ).toThrow(/ALAYA_BENCH_REQUIRE_EXTRACTION_CACHE_MANIFEST=0/u);
  });

  it("defaults runner cache-manifest requirement to fail-closed", () => {
    expect(resolveBenchRequireExtractionCacheManifest({} as NodeJS.ProcessEnv)).toBe(true);
    expect(
      resolveBenchRequireExtractionCacheManifest({
        ALAYA_BENCH_REQUIRE_EXTRACTION_CACHE_MANIFEST: "0"
      } as NodeJS.ProcessEnv)
    ).toBe(false);
    expect(
      resolveBenchRequireExtractionCacheManifest({
        ALAYA_BENCH_REQUIRE_EXTRACTION_CACHE_MANIFEST: "false"
      } as NodeJS.ProcessEnv)
    ).toBe(false);
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

  it("rejects a corrupt required fixture instead of trusting its path", () => {
    const turnContent = "required turn";
    const cacheKey = computeCacheKey(
      CONFIG.model,
      CONFIG.requestProfile,
      OFFICIAL_API_SYSTEM_PROMPT,
      turnContent
    );
    mkdirSync(join(cacheRoot, cacheKey.slice(0, 2)), { recursive: true });
    writeFileSync(cacheFilePath(cacheRoot, cacheKey), "{torn", "utf8");
    writeExtractionCacheManifest(cacheRoot, manifestFor());

    expect(() => preflightExtractionCache({
      cacheRoot,
      config: CONFIG,
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
      requiredTurnContents: [turnContent]
    })).toThrow(/invalid.*fixture|fixture.*invalid/u);
  });

  it.each([0, 1])("rejects a semantically invalid required fixture at coverage %s", (coverage) => {
    const turnContent = "required semantic validation";
    writeCacheShard(cacheRoot, CONFIG.model, turnContent, '{"not_signals":[]}');
    writeExtractionCacheManifest(cacheRoot, manifestFor({ coverage }));

    expect(() => preflightExtractionCache({
      cacheRoot,
      config: CONFIG,
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
      requiredTurnContents: [turnContent]
    })).toThrow(/invalid fixture/u);
  });

  it.each([
    ["model", { model: "wrong", raw_json: "{}" }],
    ["cache_key", { model: CONFIG.model, cache_key: "wrong", raw_json: "{}" }],
    ["raw_json", { model: CONFIG.model, raw_json: 7 }]
  ])("validates required fixture %s", (_field, override) => {
    const turnContent = `required-${_field}`;
    const cacheKey = computeCacheKey(
      CONFIG.model,
      CONFIG.requestProfile,
      OFFICIAL_API_SYSTEM_PROMPT,
      turnContent
    );
    mkdirSync(join(cacheRoot, cacheKey.slice(0, 2)), { recursive: true });
    const fixture: Record<string, unknown> = {
      model: CONFIG.model,
      cache_key: cacheKey,
      raw_json: "{}"
    };
    Object.assign(fixture, override);
    writeFileSync(cacheFilePath(cacheRoot, cacheKey), JSON.stringify(fixture));
    writeExtractionCacheManifest(cacheRoot, manifestFor());

    expect(() => preflightExtractionCache({
      cacheRoot,
      config: CONFIG,
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
      requiredTurnContents: [turnContent]
    })).toThrow(/invalid fixture/u);
  });
});

function writeCacheShard(
  cacheRoot: string,
  model: string,
  turnContent: string,
  rawJson: string
): void {
  const cacheKey = computeCacheKey(
    model,
    CONFIG.requestProfile,
    OFFICIAL_API_SYSTEM_PROMPT,
    turnContent
  );
  const filePath = cacheFilePath(cacheRoot, cacheKey);
  mkdirSync(join(cacheRoot, cacheKey.slice(0, 2)), { recursive: true });
  writeFileSync(
    filePath,
    `${JSON.stringify({
      model,
      request_profile: CONFIG.requestProfile,
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
    writeExtractionCacheManifest(cacheRoot, manifestFor({
      extraction_model: CREDENTIALLED_CONFIG.model,
      model_family: CREDENTIALLED_CONFIG.model
    }));
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
      JSON.stringify({ signals: [{
        signal_kind: "potential_preference",
        object_kind: "user_preference",
        confidence: 0.9,
        matched_text: "moved to Berlin",
        distilled_fact: "Alice lives in Berlin."
      }] })
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
    expect(liveExtract.extract).not.toHaveBeenCalled();
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
    writeExtractionCacheTestManifest({
      cacheRoot,
      model: "gpt-5.4-mini",
      systemPrompt: "sys"
    });
    const delegate: BenchSignalExtractor = {
      extract: vi.fn(async () => ({ rawJson: '{"signals":[]}' }))
    };
    const extractor = createCachingSignalExtractor({
      delegate,
      config: { ...CONFIG, providerUrl: TEST_EXTRACTION_PROVIDER_URL },
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

  it("rejects a model change before writing its different cache key", async () => {
    writeExtractionCacheTestManifest({
      cacheRoot,
      model: "gpt-5.4-mini",
      systemPrompt: "sys"
    });
    const delegate: BenchSignalExtractor = {
      extract: vi.fn(async () => ({ rawJson: '{"signals":[]}' }))
    };
    const writer = createCachingSignalExtractor({
      delegate,
      config: { ...CONFIG, providerUrl: TEST_EXTRACTION_PROVIDER_URL },
      cacheRoot
    });
    await writer.extract({ systemPrompt: "sys", userPrompt: "turn" });
    expect(delegate.extract).toHaveBeenCalledTimes(1);

    const reader = createCachingSignalExtractor({
      delegate,
      config: {
        ...CONFIG,
        model: "gpt-4.1-mini",
        modelFamily: "gpt-4.1-mini",
        providerUrl: TEST_EXTRACTION_PROVIDER_URL
      },
      cacheRoot
    });
    await expect(
      reader.extract({ systemPrompt: "sys", userPrompt: "turn" })
    ).rejects.toThrow(/extraction model mismatch/u);
    expect(delegate.extract).toHaveBeenCalledTimes(1);
  });

  it("rejects a request-profile change before the delegate or shard write", async () => {
    writeExtractionCacheTestManifest({
      cacheRoot,
      model: CONFIG.model,
      systemPrompt: "sys"
    });
    const delegate = vi.fn(async () => ({ rawJson: '{"signals":[]}' }));
    const extractor = createCachingSignalExtractor({
      delegate: { extract: delegate },
      config: { ...CONFIG, requestProfile: "deepseek-v4-nonthinking-v1" },
      cacheRoot
    });

    await expect(extractor.extract({ systemPrompt: "sys", userPrompt: "turn" }))
      .rejects.toThrow(/request profile mismatch/u);
    expect(delegate).not.toHaveBeenCalled();
    expect(readdirSync(cacheRoot).filter((entry) => /^[0-9a-f]{2}$/u.test(entry)))
      .toEqual([]);
  });

  it("fails closed on a cache miss when live extraction is disabled", async () => {
    const delegate: BenchSignalExtractor = {
      extract: vi.fn(async () => ({ rawJson: '{"signals":[]}' }))
    };
    const extractor = createCachingSignalExtractor({
      delegate,
      config: CONFIG,
      cacheRoot,
      allowLiveExtraction: false
    });

    await expect(extractor.extract({ systemPrompt: "sys", userPrompt: "turn" }))
      .rejects.toThrow(/cache-only.*missing|missing.*live extraction disabled/u);
    expect(delegate.extract).not.toHaveBeenCalled();
  });

  it("fails closed on a corrupt cache entry when live extraction is disabled", async () => {
    const cacheKey = computeCacheKey(
      CONFIG.model,
      CONFIG.requestProfile,
      "sys",
      "turn"
    );
    mkdirSync(join(cacheRoot, cacheKey.slice(0, 2)), { recursive: true });
    writeFileSync(cacheFilePath(cacheRoot, cacheKey), "{torn", "utf8");
    const delegate: BenchSignalExtractor = {
      extract: vi.fn(async () => ({ rawJson: '{"signals":[]}' }))
    };
    const extractor = createCachingSignalExtractor({
      delegate,
      config: CONFIG,
      cacheRoot,
      allowLiveExtraction: false
    });

    await expect(extractor.extract({ systemPrompt: "sys", userPrompt: "turn" }))
      .rejects.toThrow(/cache-only.*invalid/u);
    expect(delegate.extract).not.toHaveBeenCalled();
  });
});
