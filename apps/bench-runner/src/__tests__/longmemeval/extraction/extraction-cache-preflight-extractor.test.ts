import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildOfficialApiExtractionRequest,
  stringifyOfficialApiExtractionRequest
} from "@do-soul/alaya-soul";
import {
  createCachingSignalExtractor,
  createCompileSeedRunner,
  type BenchSignalExtractor
} from "../../../runs/compile-seed.js";
import { cacheFilePath, computeSourceTurnCacheKey } from "../../../runs/compile-seed/compile-seed-cache.js";
import { writeExtractionCacheManifest } from "../../../runs/extraction/cache/extraction-cache-manifest.js";
import {
  buildCompileSeedDaemon,
  CREDENTIALLED_CONFIG,
  signalsEnvelope
} from "../compile-seed/compile-seed-fixture.js";
import {
  providerBackedExtractionResult,
  TEST_EXTRACTION_PROVIDER_URL,
  writeExtractionCacheTestManifest
} from "./extraction-cache-test-fixture.js";
import {
  EXTRACTION_CONFIG as CONFIG,
  manifestFor,
  registerCacheRootHooks,
  writeCacheShard
} from "./extraction-cache-preflight-fixture.js";

const TURN_CONTENT = "I moved to Berlin.";
const TURN_REQUEST = stringifyOfficialApiExtractionRequest(
  buildOfficialApiExtractionRequest(TURN_CONTENT, [])
);
const TURN_RESPONSE = signalsEnvelope([{
  matched: TURN_CONTENT,
  distilled: "The user moved to Berlin."
}]);

describe("cache-only compile seed smoke", () => {
  let cacheRoot: string;
  registerCacheRootHooks(
    "extraction-cache-smoke-",
    (root) => { cacheRoot = root; },
    (root) => writeExtractionCacheManifest(root, manifestFor({
      extraction_model: CREDENTIALLED_CONFIG.model,
      model_family: CREDENTIALLED_CONFIG.model
    }))
  );

  it("reports cacheHits>0 and llmCalls=0 without calling the live extractor", async () => {
    const turnContent = "I moved to Berlin and started a new job in March 2024.";
    writeCacheShard(
      cacheRoot,
      CREDENTIALLED_CONFIG.model,
      turnContent,
      signalsEnvelope([{
        matched: "I moved to Berlin and started a new job in March 2024.",
        distilled: "Alice lives in Berlin."
      }])
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
  registerCacheRootHooks("extraction-single-source-", (root) => { cacheRoot = root; });

  it("writes the same model into the cache fixture that the config carries", async () => {
    writeExtractionCacheTestManifest({
      cacheRoot,
      model: "gpt-5.4-mini",
      systemPrompt: "sys"
    });
    const delegate: BenchSignalExtractor = {
      extract: vi.fn(async () => providerBackedExtractionResult(TURN_RESPONSE))
    };
    const extractor = createCachingSignalExtractor({
      delegate,
      config: { ...CONFIG, providerUrl: TEST_EXTRACTION_PROVIDER_URL },
      cacheRoot
    });
    await extractor.extract({ systemPrompt: "sys", userPrompt: TURN_REQUEST });

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
      extract: vi.fn(async () => providerBackedExtractionResult(TURN_RESPONSE))
    };
    const writer = createCachingSignalExtractor({
      delegate,
      config: { ...CONFIG, providerUrl: TEST_EXTRACTION_PROVIDER_URL },
      cacheRoot
    });
    await writer.extract({ systemPrompt: "sys", userPrompt: TURN_REQUEST });
    expect(delegate.extract).toHaveBeenCalledOnce();

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
      reader.extract({ systemPrompt: "sys", userPrompt: TURN_REQUEST })
    ).rejects.toThrow(/extraction model mismatch/u);
    expect(delegate.extract).toHaveBeenCalledOnce();
  });

  it("rejects a request-profile change before the delegate or shard write", async () => {
    writeExtractionCacheTestManifest({
      cacheRoot,
      model: CONFIG.model,
      systemPrompt: "sys"
    });
    const delegate = vi.fn(async () => providerBackedExtractionResult('{"signals":[]}'));
    const extractor = createCachingSignalExtractor({
      delegate: { extract: delegate },
      config: { ...CONFIG, requestProfile: "deepseek-v4-nonthinking-v1" },
      cacheRoot
    });

    await expect(extractor.extract({ systemPrompt: "sys", userPrompt: TURN_REQUEST }))
      .rejects.toThrow(/request profile mismatch/u);
    expect(delegate).not.toHaveBeenCalled();
    expect(readdirSync(cacheRoot).filter((entry) => /^[0-9a-f]{2}$/u.test(entry)))
      .toEqual([]);
  });

  it("fails closed on a cache miss when live extraction is disabled", async () => {
    const delegate: BenchSignalExtractor = {
      extract: vi.fn(async () => providerBackedExtractionResult('{"signals":[]}'))
    };
    const extractor = createCachingSignalExtractor({
      delegate,
      config: CONFIG,
      cacheRoot,
      allowLiveExtraction: false
    });

    await expect(extractor.extract({ systemPrompt: "sys", userPrompt: TURN_REQUEST }))
      .rejects.toThrow(/cache-only.*missing|missing.*live extraction disabled/u);
    expect(delegate.extract).not.toHaveBeenCalled();
  });

  it("fails closed on a corrupt cache entry when live extraction is disabled", async () => {
    const cacheKey = computeSourceTurnCacheKey(
      CONFIG.model,
      CONFIG.requestProfile,
      "sys",
      { turnContent: TURN_CONTENT }
    );
    mkdirSync(join(cacheRoot, cacheKey.slice(0, 2)), { recursive: true });
    writeFileSync(cacheFilePath(cacheRoot, cacheKey), "{torn", "utf8");
    const delegate: BenchSignalExtractor = {
      extract: vi.fn(async () => providerBackedExtractionResult('{"signals":[]}'))
    };
    const extractor = createCachingSignalExtractor({
      delegate,
      config: CONFIG,
      cacheRoot,
      allowLiveExtraction: false
    });

    await expect(extractor.extract({ systemPrompt: "sys", userPrompt: TURN_REQUEST }))
      .rejects.toThrow(/cache-only.*invalid/u);
    expect(delegate.extract).not.toHaveBeenCalled();
  });

});
