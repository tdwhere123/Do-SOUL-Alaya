import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import {
  collectDistinctTurnContents,
  runExtractionFill
} from "../../../longmemeval/extraction/extraction-fill.js";
import { readExtractionCacheManifest } from "../../../longmemeval/extraction/cache/extraction-cache-manifest.js";
import type { BenchSignalExtractor } from "../../../longmemeval/compile-seed.js";
import { cacheFilePath, computeCacheKey } from "../../../longmemeval/compile-seed/compile-seed-cache.js";
import {
  inspectExtractionAuthority,
  readCurrentExtractionAuthorityRevision
} from "../../../longmemeval/extraction/authority/inspection.js";
import {
  createExtractionAuthorityReceipt,
  writeExtractionAuthorityReceipt
} from "../../../longmemeval/extraction/authority/receipt.js";
import {
  acquireExtractionCacheWriteLease,
  withExtractionCacheWriteLease
} from "../../../longmemeval/extraction/fill/manifest/fill-root-guard.js";

import {
  buildExtractionFillQuestion as buildQuestion,
  expectFirstExtractionShardModel as expectFirstShardModel,
  EXTRACTION_FILL_VARIANT as VARIANT,
  registerExtractionFillHooks
} from "./fixture.js";

let cacheRoot: string;
let dataDir: string;
let pinnedMetaRoot: string;
const writeFixtureDataset = registerExtractionFillHooks((roots) => {
  ({ cacheRoot, dataDir, pinnedMetaRoot } = roots);
});

describe("runExtractionFill", () => {

  it("preserves extraction and lock-release failures together", async () => {
    await writeFixtureDataset([
      buildQuestion("q001", "User: alpha\nAssistant: ok.", "User: decoy")
    ]);
    let thrown: unknown;
    try {
      await runExtractionFill({
        variant: VARIANT,
        cacheRoot,
        dataDir,
        pinnedMetaRoot,
        concurrency: 1,
        extractorFactory: () => ({ extract: async () => ({ rawJson: '{"signals":[]}' }) }),
        log: (message) => {
          if (!message.includes("1/2")) return;
          writeFileSync(
            join(cacheRoot, ".extraction-fill.lock", "owner.json"),
            JSON.stringify({ pid: process.pid, token: "replaced" }),
            "utf8"
          );
          throw new Error("simulated extraction failure");
        }
      });
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors.map(String).join(" ")).toMatch(
      /simulated extraction failure.*ownership changed/su
    );
  });

  it("preserves an undefined thrown value when lock release also fails", async () => {
    const lease = acquireExtractionCacheWriteLease(cacheRoot);
    let thrown: unknown;
    try {
      await withExtractionCacheWriteLease(lease, async () => {
        writeFileSync(
          join(cacheRoot, ".extraction-fill.lock", "owner.json"),
          JSON.stringify({ pid: process.pid, token: "replacement" }),
          "utf8"
        );
        throw undefined;
      });
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors[0]).toBeUndefined();
  });

  it("rejects suspicious manifest-less shard prefixes before the delegate", async () => {
    await writeFixtureDataset([
      buildQuestion("q001", "User: alpha\nAssistant: ok.", "User: decoy")
    ]);
    await writeFile(join(cacheRoot, "aa"), "not-a-shard-directory", "utf8");
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
    })).rejects.toThrow(/manifest.*suspicious|identity.*initialized/iu);
    expect(extractorFactory).not.toHaveBeenCalled();
  });

  it("binds family config to the exact HTTP model, shard, and manifest", async () => {
    vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", "deepseek-v4-flash-free");
    vi.stubEnv(
      "ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE",
      "deepseek-v4-nonthinking-v1"
    );
    vi.stubEnv("ALAYA_BENCH_EXTRACTION_MODEL_FAMILY", "deepseek-v4-flash");
    vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", "https://opencode.ai/zen/v1");
    vi.stubEnv("ALAYA_OFFICIAL_GARDEN_SECRET_REF", "env:ZEN_TEST_API_KEY");
    vi.stubEnv("ZEN_TEST_API_KEY", "test-only-key");
    await writeFixtureDataset([
      buildQuestion("q001", "User: alpha\nAssistant: ok.", "User: decoy")
    ]);
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"signals":[]}' } }]
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const authorityReceiptPath = await writeLiveAuthorityReceipt();

    await runExtractionFill({
      variant: VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      concurrency: 1,
      authorityReceiptPath,
      log: () => undefined
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).toBe("https://opencode.ai/zen/v1/chat/completions");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "deepseek-v4-flash-free",
        stream: true
      });
    }
    const shardDirs = readdirSync(cacheRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expectFirstShardModel(cacheRoot, shardDirs, "deepseek-v4-flash-free");
    const answerTurn = collectDistinctTurnContents([
      buildQuestion("key", "User: alpha\nAssistant: ok.", "User: decoy")
    ]).find((turn) => turn.includes("alpha"));
    expect(answerTurn).toBeDefined();
    const exactKey = computeCacheKey(
      "deepseek-v4-flash-free",
      "deepseek-v4-nonthinking-v1",
      OFFICIAL_API_SYSTEM_PROMPT,
      answerTurn!
    );
    const familyKey = computeCacheKey(
      "deepseek-v4-flash",
      "deepseek-v4-nonthinking-v1",
      OFFICIAL_API_SYSTEM_PROMPT,
      answerTurn!
    );
    expect(existsSync(cacheFilePath(cacheRoot, exactKey))).toBe(true);
    expect(existsSync(cacheFilePath(cacheRoot, familyKey))).toBe(false);
    expect(readExtractionCacheManifest(cacheRoot)).toMatchObject({
      extraction_model: "deepseek-v4-flash-free",
      model_family: "deepseek-v4-flash",
      provider_url: "https://opencode.ai/zen/v1"
    });
  });

  it("dedups turn_content, write-throughs misses, and writes a coverage manifest", async () => {
    vi.stubEnv("ALAYA_BENCH_EXTRACTION_MODEL_FAMILY", "gpt-5-family");
    // q001 and q002 share an identical answer round -> one cache key. Each has
    // a distinct decoy round. Distinct turns: 2 shared-collapsed-to-1 + 2 decoys
    // = 3 cache keys.
    await writeFixtureDataset([
      buildQuestion("q001", "User: shared fact\nAssistant: Acknowledged.", "User: decoy one"),
      buildQuestion("q002", "User: shared fact\nAssistant: Acknowledged.", "User: decoy two")
    ]);
    const extract = vi.fn<BenchSignalExtractor["extract"]>(async () => ({
      rawJson: '{"signals":[]}'
    }));
    const result = await runExtractionFill({
      variant: VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      extractorFactory: () => ({ extract }),
      log: () => undefined
    });

    // 2 questions × (answer round + decoy round); the answer round collapses
    // across the two questions, so 3 distinct turn_content cache keys.
    expect(result.requestedTurns).toBe(3);
    expect(result.newlyExtracted).toBe(3);
    expect(result.cacheHits).toBe(0);
    expect(extract).toHaveBeenCalledTimes(3);

    const manifest = readExtractionCacheManifest(cacheRoot);
    expect(manifest).toBeDefined();
    expect(manifest?.extraction_model).toBe("gpt-5.4-mini");
    expect(manifest?.model_family).toBe("gpt-5-family");
    expect(manifest?.coverage).toBe(1);
    expect(manifest?.requested_turns).toBe(3);
    expect(manifest?.builder).toBe("extraction-fill");
    // Shards on disk are the 3 distinct keys.
    const shardDirs = readdirSync(cacheRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    const shardCount = shardDirs.reduce(
      (sum, dir) => sum + readdirSync(join(cacheRoot, dir)).length,
      0
    );
    expect(shardCount).toBe(3);
    expect(manifest?.cached_turns).toBe(3);
    expectFirstShardModel(cacheRoot, shardDirs, "gpt-5.4-mini");
  });


});

async function writeLiveAuthorityReceipt(): Promise<string> {
  const inspection = await inspectExtractionAuthority({
    variant: VARIANT,
    cacheRoot,
    dataDir,
    pinnedMetaRoot,
    revision: readCurrentExtractionAuthorityRevision(),
    action: "fill"
  });
  const receipt = createExtractionAuthorityReceipt({
    action: "fill",
    observation: inspection.observation,
    outputTokenCap: { field: "max_tokens", value: 512 },
    priceEstimate: {
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 2,
      maximumInputTokensPerAttempt: 300
    },
    diskFloorBytes: 0,
    inspection: {
      writerLock: inspection.writerLock,
      disk: inspection.disk,
      credentialStatus: inspection.credentialStatus,
      modelReadiness: inspection.modelReadiness
    }
  });
  const path = join(cacheRoot, "authority-receipt.json");
  writeExtractionAuthorityReceipt(path, receipt);
  return path;
}
