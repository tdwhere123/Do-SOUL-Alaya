import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import { runExtractionFill } from "../../longmemeval/extraction-fill.js";
import {
  EXTRACTION_CACHE_KEY_ALGO,
  computeSystemPromptSha256,
  readExtractionCacheManifest,
  writeExtractionCacheManifest
} from "../../longmemeval/extraction-cache-manifest.js";
import {
  createCachingSignalExtractor,
  preflightExtractionCache,
  type BenchSignalExtractor
} from "../../longmemeval/compile-seed.js";
import { cacheFilePath, computeCacheKey } from "../../longmemeval/compile-seed-cache.js";

import {
  buildExtractionFillQuestion as buildQuestion,
  expectFirstExtractionShardModel as expectFirstShardModel,
  EXTRACTION_FILL_VARIANT as VARIANT,
  registerExtractionFillHooks
} from "./extraction-fill/fixture.js";

// @anchor extraction-fill-contract: Layer 1 daemon-free cache fill. Drives a
// stub extractor (no live network) over a tiny fixture dataset and asserts
// dedup, write-through, second-run cache hits, and a coverage-bearing manifest.

let cacheRoot: string;
let dataDir: string;
let pinnedMetaRoot: string;
const writeFixtureDataset = registerExtractionFillHooks((roots) => {
  ({ cacheRoot, dataDir, pinnedMetaRoot } = roots);
});

describe("runExtractionFill", () => {

  it("pins identity before the first shard and rejects cross-provider resume", async () => {
    vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", "https://provider-a.invalid/v1");
    vi.stubEnv("ALAYA_BENCH_EXTRACTION_MODEL_FAMILY", "family-a");
    await writeFixtureDataset([
      buildQuestion("q001", "User: alpha\nAssistant: ok.", "User: decoy")
    ]);
    const extract = vi.fn<BenchSignalExtractor["extract"]>(async () => ({
      rawJson: '{"signals":[]}'
    }));
    let interrupted = false;
    await expect(runExtractionFill({
      variant: VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      concurrency: 1,
      extractorFactory: () => ({ extract }),
      log: (message) => {
        if (!interrupted && message.includes("1/2")) {
          interrupted = true;
          throw new Error("simulated interruption");
        }
      }
    })).rejects.toThrow(/simulated interruption/u);

    expect(readExtractionCacheManifest(cacheRoot)).toMatchObject({
      schema_version: 3,
      provider_url: "https://provider-a.invalid/v1",
      model_family: "family-a"
    });
    vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", "https://provider-b.invalid/v1");
    vi.stubEnv("ALAYA_BENCH_EXTRACTION_MODEL_FAMILY", "family-b");
    await expect(runExtractionFill({
      variant: VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      extractorFactory: () => ({ extract }),
      log: () => undefined
    })).rejects.toThrow(/provider URL mismatch|model family mismatch/u);
  });

  it("holds an exclusive cache-root lock for the full fill", async () => {
    await writeFixtureDataset([
      buildQuestion("q001", "User: alpha\nAssistant: ok.", "User: decoy")
    ]);
    let releaseFirst!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = runExtractionFill({
      variant: VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      concurrency: 1,
      extractorFactory: () => ({
        extract: async () => {
          markStarted();
          await blocked;
          return { rawJson: '{"signals":[]}' };
        }
      }),
      log: () => undefined
    });
    await started;
    const secondFactory = vi.fn(() => ({
      extract: vi.fn(async () => ({ rawJson: '{"signals":[]}' }))
    }));
    await expect(runExtractionFill({
      variant: VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      extractorFactory: secondFactory,
      log: () => undefined
    })).rejects.toThrow(/fill.*lock|already.*fill/iu);
    expect(secondFactory).not.toHaveBeenCalled();
    releaseFirst();
    await first;
  });

  it("revalidates manifest identity at the shared live-write boundary", async () => {
    preflightExtractionCache({
      cacheRoot,
      config: {
        model: "gpt-5.4-mini",
        modelFamily: "family-b",
        providerUrl: "https://provider-b.invalid/v1",
        requestProfile: "provider-default-v1",
        apiKey: "test-key"
      },
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
      requireManifest: false,
      warn: () => undefined
    });
    vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", "https://provider-a.invalid/v1");
    vi.stubEnv("ALAYA_BENCH_EXTRACTION_MODEL_FAMILY", "family-a");
    await writeFixtureDataset([
      buildQuestion("q001", "User: alpha\nAssistant: ok.", "User: decoy")
    ]);
    await runExtractionFill({
      variant: VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      extractorFactory: () => ({ extract: async () => ({ rawJson: '{"signals":[]}' }) }),
      log: () => undefined
    });
    const delegate = vi.fn(async () => ({ rawJson: '{"signals":[]}' }));
    const liveWriter = createCachingSignalExtractor({
      delegate: { extract: delegate },
      config: {
        model: "gpt-5.4-mini", modelFamily: "family-b",
        providerUrl: "https://provider-b.invalid/v1",
        requestProfile: "provider-default-v1"
      },
      cacheRoot
    });
    await expect(liveWriter.extract({
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
      userPrompt: JSON.stringify({ turn_content: "new uncached turn" })
    })).rejects.toThrow(/model family mismatch|provider URL mismatch/u);
    expect(delegate).not.toHaveBeenCalled();
  });

  it("rejects an ordinary live write when extraction-fill has not initialized identity", async () => {
    const delegate = vi.fn(async () => ({ rawJson: '{"signals":[]}' }));
    const liveWriter = createCachingSignalExtractor({
      delegate: { extract: delegate },
      config: {
        model: "gpt-5.4-mini", modelFamily: "gpt-5.4-mini",
        providerUrl: "https://provider.invalid/v1",
        requestProfile: "provider-default-v1"
      },
      cacheRoot
    });
    await expect(liveWriter.extract({
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
      userPrompt: JSON.stringify({ turn_content: "uncached turn" })
    })).rejects.toThrow(/require manifest\.json.*extraction-fill/su);
    expect(delegate).not.toHaveBeenCalled();
    expect(readdirSync(cacheRoot).some((name) => /^[0-9a-f]{2}$/u.test(name))).toBe(false);
  });

  it("does not write a shard when manifest identity disappears during the delegate", async () => {
    await writeFixtureDataset([
      buildQuestion("q001", "User: alpha\nAssistant: ok.", "User: decoy")
    ]);
    await runExtractionFill({
      variant: VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      extractorFactory: () => ({ extract: async () => ({ rawJson: '{"signals":[]}' }) }),
      log: () => undefined
    });
    const turn = "new turn after fill";
    const key = computeCacheKey(
      "gpt-5.4-mini", "provider-default-v1", OFFICIAL_API_SYSTEM_PROMPT, turn
    );
    const liveWriter = createCachingSignalExtractor({
      delegate: {
        extract: async () => {
          rmSync(join(cacheRoot, "manifest.json"));
          return { rawJson: '{"signals":[]}' };
        }
      },
      config: {
        model: "gpt-5.4-mini", modelFamily: "gpt-5.4-mini",
        providerUrl: "https://yunwu.ai/v1",
        requestProfile: "provider-default-v1"
      },
      cacheRoot
    });
    await expect(liveWriter.extract({
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
      userPrompt: JSON.stringify({ turn_content: turn })
    })).rejects.toThrow(/require manifest\.json|manifest changed/u);
    expect(existsSync(cacheFilePath(cacheRoot, key))).toBe(false);
  });

  it("does not write a shard when lease ownership changes inside the delegate", async () => {
    writeExtractionCacheManifest(cacheRoot, {
      schema_version: 3,
      extraction_model: "gpt-5.4-mini",
      model_family: "gpt-5.4-mini",
      request_profile: "provider-default-v1",
      provider_url: "https://yunwu.ai/v1",
      system_prompt_sha256: computeSystemPromptSha256(OFFICIAL_API_SYSTEM_PROMPT),
      cache_key_algo: EXTRACTION_CACHE_KEY_ALGO,
      dataset: "longmemeval-oracle",
      dataset_revision: "fixture",
      storage: "git-tracked",
      built_at: "2026-07-12T00:00:00.000Z",
      builder: "test"
    });
    const turn = "ownership-loss turn";
    const key = computeCacheKey(
      "gpt-5.4-mini", "provider-default-v1", OFFICIAL_API_SYSTEM_PROMPT, turn
    );
    const liveWriter = createCachingSignalExtractor({
      delegate: {
        extract: async () => {
          writeFileSync(
            join(cacheRoot, ".extraction-fill.lock", "owner.json"),
            JSON.stringify({ pid: process.pid, token: "replacement" }),
            "utf8"
          );
          return { rawJson: '{"signals":[]}' };
        }
      },
      config: {
        model: "gpt-5.4-mini", modelFamily: "gpt-5.4-mini",
        providerUrl: "https://yunwu.ai/v1",
        requestProfile: "provider-default-v1"
      },
      cacheRoot
    });
    await expect(liveWriter.extract({
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
      userPrompt: JSON.stringify({ turn_content: turn })
    })).rejects.toBeInstanceOf(AggregateError);
    expect(existsSync(cacheFilePath(cacheRoot, key))).toBe(false);
  });

  it("does not auto-delete an ownerless crash lock", async () => {
    await writeFixtureDataset([
      buildQuestion("q001", "User: alpha\nAssistant: ok.", "User: decoy")
    ]);
    const lockPath = join(cacheRoot, ".extraction-fill.lock");
    mkdirSync(lockPath);
    await expect(runExtractionFill({
      variant: VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      extractorFactory: () => ({ extract: async () => ({ rawJson: '{"signals":[]}' }) }),
      log: () => undefined
    })).rejects.toThrow(/writer lock.*verifying its owner process/iu);
    expect(existsSync(lockPath)).toBe(true);
  });

  it("aborts fill without finalizing when delegate replaces the lease token", async () => {
    await writeFixtureDataset([
      buildQuestion("q001", "User: alpha\nAssistant: ok.", "User: decoy")
    ]);
    await expect(runExtractionFill({
      variant: VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      concurrency: 1,
      extractorFactory: () => ({
        extract: async () => {
          writeFileSync(
            join(cacheRoot, ".extraction-fill.lock", "owner.json"),
            JSON.stringify({ pid: process.pid, token: "replacement" }),
            "utf8"
          );
          return { rawJson: '{"signals":[]}' };
        }
      }),
      log: () => undefined
    })).rejects.toBeInstanceOf(AggregateError);
    expect(readExtractionCacheManifest(cacheRoot)).toMatchObject({
      cached_turns: 0,
      coverage: 0
    });
    expect(readdirSync(cacheRoot).filter((name) => /^[0-9a-f]{2}$/u.test(name))).toHaveLength(0);
  });

  it("aborts fill without overwriting a manifest replaced during the delegate", async () => {
    await writeFixtureDataset([
      buildQuestion("q001", "User: alpha\nAssistant: ok.", "User: decoy")
    ]);
    await expect(runExtractionFill({
      variant: VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      concurrency: 1,
      extractorFactory: () => ({
        extract: async () => {
          writeExtractionCacheManifest(cacheRoot, {
            schema_version: 2,
            extraction_model: "gpt-5.4-mini",
            model_family: "gpt-5.4-mini",
            provider_url: "https://yunwu.ai/v1",
            system_prompt_sha256: computeSystemPromptSha256(OFFICIAL_API_SYSTEM_PROMPT),
            cache_key_algo: "sha256(model\\0systemPrompt\\0turnContent)",
            dataset: "longmemeval-oracle",
            dataset_revision: "fixture",
            storage: "git-tracked",
            built_at: "2026-07-12T00:00:00.000Z",
            builder: "intruder"
          });
          return { rawJson: '{"signals":[]}' };
        }
      }),
      log: () => undefined
    })).rejects.toThrow(/manifest changed during live extraction/u);
    expect(readExtractionCacheManifest(cacheRoot)).toMatchObject({ builder: "intruder" });
    expect(readExtractionCacheManifest(cacheRoot)?.coverage).toBeUndefined();
    expect(readdirSync(cacheRoot).filter((name) => /^[0-9a-f]{2}$/u.test(name))).toHaveLength(0);
  });


});
