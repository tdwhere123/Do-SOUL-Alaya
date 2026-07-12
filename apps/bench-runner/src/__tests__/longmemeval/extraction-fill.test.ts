import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import {
  collectDistinctTurnContents,
  runExtractionFill
} from "../../longmemeval/extraction-fill.js";
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
import {
  cacheFilePath,
  computeCacheKey
} from "../../longmemeval/compile-seed-cache.js";
import {
  acquireExtractionCacheWriteLease,
  withExtractionCacheWriteLease
} from "../../longmemeval/extraction/fill-root-guard.js";
import type { LongMemEvalQuestion } from "../../longmemeval/dataset.js";

// @anchor extraction-fill-contract: Layer 1 daemon-free cache fill. Drives a
// stub extractor (no live network) over a tiny fixture dataset and asserts
// dedup, write-through, second-run cache hits, and a coverage-bearing manifest.

let tmpDir: string;
let cacheRoot: string;
let dataDir: string;
let pinnedMetaRoot: string;

const VARIANT = "longmemeval_oracle";

function buildQuestion(id: string, fact: string, decoy: string): LongMemEvalQuestion {
  return {
    question_id: id,
    question_type: "single_session",
    question: `What about ${id}?`,
    answer: `answer ${id}`,
    question_date: "2026-01-01",
    haystack_session_ids: [`s-${id}`, `decoy-${id}`],
    haystack_dates: ["2025-12-01", "2025-11-01"],
    haystack_sessions: [
      [
        { role: "user", content: fact, has_answer: true },
        { role: "assistant", content: "Acknowledged." }
      ],
      [{ role: "user", content: decoy }]
    ],
    answer_session_ids: [`s-${id}`]
  };
}

async function writeFixtureDataset(
  questions: readonly LongMemEvalQuestion[]
): Promise<void> {
  const raw = JSON.stringify(questions);
  const sha = createHash("sha256").update(raw, "utf8").digest("hex");
  await writeFile(join(dataDir, `${VARIANT}.json`), raw, "utf8");
  await writeFile(
    join(pinnedMetaRoot, `${VARIANT}.meta.json`),
    JSON.stringify({ name: VARIANT, sha256: sha, question_count: questions.length }),
    "utf8"
  );
}

function expectFirstShardModel(
  cacheRootPath: string,
  shardDirs: readonly string[],
  expectedModel: string
): void {
  const shardDir = shardDirs[0];
  const shardFile = shardDir === undefined ? undefined : readdirSync(join(cacheRootPath, shardDir))[0];
  expect(shardFile).toBeDefined();
  if (shardDir === undefined || shardFile === undefined) {
    throw new Error("expected at least one extraction shard");
  }
  const shard = JSON.parse(
    readFileSync(join(cacheRootPath, shardDir, shardFile), "utf8")
  ) as { readonly model: string };
  expect(shard.model).toBe(expectedModel);
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "extraction-fill-"));
  cacheRoot = join(tmpDir, "cache");
  dataDir = join(tmpDir, "data");
  pinnedMetaRoot = join(tmpDir, "pinned");
  await mkdir(cacheRoot, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await mkdir(pinnedMetaRoot, { recursive: true });
  // The fill pass resolves the model from the single source; set the env so it
  // never relies on a manifest that does not exist yet.
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", "gpt-5.4-mini");
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", "provider-default-v1");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tmpDir, { recursive: true, force: true });
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

    await runExtractionFill({
      variant: VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      concurrency: 1,
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
    expect(result.failures).toBe(0);
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

  it("counts a failing extraction without crashing the pass (coverage reflects it)", async () => {
    await writeFixtureDataset([
      buildQuestion("q001", "User: beta\nAssistant: ok.", "User: gamma decoy")
    ]);
    const extract = vi.fn<BenchSignalExtractor["extract"]>(async () => {
      throw new Error("simulated provider 500");
    });
    const result = await runExtractionFill({
      variant: VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      extractorFactory: () => ({ extract }),
      log: () => undefined
    });
    expect(result.requestedTurns).toBe(2);
    expect(result.failures).toBe(2);
    expect(result.newlyExtracted).toBe(0);
    expect(result.coverage).toBe(0);
    // A manifest is still written so the next preflight sees the gap.
    expect(existsSync(join(cacheRoot, "manifest.json"))).toBe(true);
  });

  it("does not count or cache a semantically invalid extraction payload", async () => {
    await writeFixtureDataset([
      buildQuestion("q001", "User: beta\nAssistant: ok.", "User: gamma decoy")
    ]);
    const result = await runExtractionFill({
      variant: VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      extractorFactory: () => ({
        extract: async () => ({ rawJson: '{"not_signals":[]}' })
      }),
      log: () => undefined
    });
    expect(result.failures).toBe(2);
    expect(result.coverage).toBe(0);
    expect(result.manifest.cached_turns).toBe(0);
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
