import { mkdirSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import { runExtractionFill } from "../../longmemeval/extraction-fill.js";
import {
  EXTRACTION_CACHE_KEY_ALGO,
  computeSystemPromptSha256,
  writeExtractionCacheManifest
} from "../../longmemeval/extraction-cache-manifest.js";
import {
  createCachingSignalExtractor,
  type BenchSignalExtractor
} from "../../longmemeval/compile-seed.js";
import { cacheFilePath, computeCacheKey } from "../../longmemeval/compile-seed-cache.js";

import {
  buildExtractionFillQuestion as buildQuestion,
  expectFirstExtractionShardModel as expectFirstShardModel,
  EXTRACTION_FILL_VARIANT as VARIANT,
  registerExtractionFillHooks
} from "./extraction-fill/fixture.js";

let cacheRoot: string;
let dataDir: string;
let pinnedMetaRoot: string;
const writeFixtureDataset = registerExtractionFillHooks((roots) => {
  ({ cacheRoot, dataDir, pinnedMetaRoot } = roots);
});

describe("runExtractionFill", () => {

  it("serves a second fill entirely from cache (zero new extractions)", async () => {
    await writeFixtureDataset([
      buildQuestion("q001", "User: alpha\nAssistant: ok.", "User: decoy")
    ]);
    const extract = vi.fn<BenchSignalExtractor["extract"]>(async () => ({
      rawJson: '{"signals":[]}'
    }));
    const factory = (): BenchSignalExtractor => ({ extract });

    const first = await runExtractionFill({
      variant: VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      extractorFactory: factory,
      log: () => undefined
    });
    expect(first.newlyExtracted).toBe(2);
    expect(first.cacheHits).toBe(0);

    const second = await runExtractionFill({
      variant: VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      extractorFactory: factory,
      log: () => undefined
    });
    // Same content -> every key is a hit, no new delegate calls beyond the
    // first run's 2.
    expect(second.cacheHits).toBe(2);
    expect(second.newlyExtracted).toBe(0);
    expect(extract).toHaveBeenCalledTimes(2);
    expect(second.coverage).toBe(1);
  });

  it("rejects an existing provider identity before invoking the live delegate", async () => {
    vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", "https://other-provider.invalid/v1");
    await writeFixtureDataset([
      buildQuestion("q001", "User: alpha\nAssistant: ok.", "User: decoy")
    ]);
    writeExtractionCacheManifest(cacheRoot, {
      schema_version: 3,
      extraction_model: "gpt-5.4-mini",
      model_family: "gpt-5.4-mini",
      request_profile: "provider-default-v1",
      provider_url: "https://provider.invalid/v1",
      system_prompt_sha256: computeSystemPromptSha256(OFFICIAL_API_SYSTEM_PROMPT),
      cache_key_algo: EXTRACTION_CACHE_KEY_ALGO,
      dataset: "longmemeval-oracle",
      dataset_revision: "rev",
      requested_turns: 2,
      cached_turns: 0,
      coverage: 0,
      storage: "git-tracked",
      built_at: "2026-07-12T00:00:00.000Z",
      builder: "test"
    });
    const extractorFactory = vi.fn(() => ({
      extract: vi.fn(async () => ({ rawJson: '{"signals":[]}' }))
    }));
    await expect(runExtractionFill({
      variant: VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      extractorFactory,
      log: () => undefined
    })).rejects.toThrow(/provider URL mismatch/u);
    expect(extractorFactory).not.toHaveBeenCalled();
  });

  it("treats shard persistence failure as a fatal cache invariant", async () => {
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
    const turn = "unwritable shard turn";
    const key = computeCacheKey(
      "gpt-5.4-mini", "provider-default-v1", OFFICIAL_API_SYSTEM_PROMPT, turn
    );
    mkdirSync(cacheFilePath(cacheRoot, key), { recursive: true });
    const liveWriter = createCachingSignalExtractor({
      delegate: { extract: async () => ({ rawJson: '{"signals":[]}' }) },
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
    })).rejects.toThrow(/failed to persist extraction cache shard/u);
  });

  it("honours --limit by staging the first N questions only", async () => {
    await writeFixtureDataset([
      buildQuestion("q001", "User: one\nAssistant: ok.", "User: decoy-one"),
      buildQuestion("q002", "User: two\nAssistant: ok.", "User: decoy-two"),
      buildQuestion("q003", "User: three\nAssistant: ok.", "User: decoy-three")
    ]);
    const extract = vi.fn<BenchSignalExtractor["extract"]>(async () => ({
      rawJson: '{"signals":[]}'
    }));
    const result = await runExtractionFill({
      variant: VARIANT,
      limit: 1,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      extractorFactory: () => ({ extract }),
      log: () => undefined
    });
    // Only q001 -> answer round + decoy = 2 distinct turns.
    expect(result.requestedTurns).toBe(2);
    expect(extract).toHaveBeenCalledTimes(2);
  });

});
