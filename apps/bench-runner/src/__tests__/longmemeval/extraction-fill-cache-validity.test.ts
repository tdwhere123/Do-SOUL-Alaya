import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import { runExtractionFill } from "../../longmemeval/extraction-fill.js";
import { readExtractionCacheManifest } from "../../longmemeval/extraction-cache-manifest.js";
import {
  cacheFilePath,
  computeCacheKey,
  inspectCachedExtraction
} from "../../longmemeval/compile-seed-cache.js";
import type { LongMemEvalQuestion } from "../../longmemeval/dataset.js";

const VARIANT = "longmemeval_oracle";
let root: string;
let cacheRoot: string;
let dataDir: string;
let pinnedMetaRoot: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fill-cache-validity-"));
  cacheRoot = join(root, "cache");
  dataDir = join(root, "data");
  pinnedMetaRoot = join(root, "pinned");
  await Promise.all([cacheRoot, dataDir, pinnedMetaRoot].map(
    (path) => mkdir(path, { recursive: true })
  ));
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", "fixture-model");
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", "provider-default-v1");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("extraction-fill cache validity", () => {
  it("rejects a non-empty signals array with no valid entries", async () => {
    await writeDataset();
    await expect(fill(() => ({ rawJson: '{"signals":[42]}' }))).rejects.toMatchObject({
      name: "ExtractionFillTaskError",
      retryClassification: "unknown"
    });
    expect(readExtractionCacheManifest(cacheRoot)).toMatchObject({
      requested_turns: 2,
      cached_turns: 0,
      coverage: 0
    });
  });

  it("keeps valid siblings when another signal entry is malformed", async () => {
    await writeDataset();
    const rawJson = JSON.stringify({
      signals: [42, {
        signal_kind: "potential_preference",
        object_kind: "user_preference",
        confidence: 0.9,
        matched_text: "alpha",
        distilled_fact: "Alpha fact."
      }]
    });
    const result = await fill(() => ({ rawJson }));
    expect(result).toMatchObject({ coverage: 1, newlyExtracted: 2 });
    const shard = JSON.parse(readFileSync(firstShardPath(), "utf8")) as {
      readonly cache_key: string;
    };
    expect(inspectCachedExtraction(
      cacheRoot,
      shard.cache_key,
      "fixture-model",
      "provider-default-v1"
    )).toMatchObject({
      status: "hit",
      rawSignalCount: 2,
      parsedDraftCount: 1
    });
  });

  it("replaces a semantically invalid existing shard during live fill", async () => {
    await writeDataset();
    await fill(() => ({ rawJson: '{"signals":[]}' }));
    const shardPath = firstShardPath();
    const shard = JSON.parse(readFileSync(shardPath, "utf8")) as Record<string, unknown>;
    writeFileSync(shardPath, JSON.stringify({ ...shard, raw_json: '{"signals":[42]}' }));
    const delegate = vi.fn(async () => ({ rawJson: '{"signals":[]}' }));

    const result = await fill(delegate);

    expect(result).toMatchObject({ cacheHits: 1, newlyExtracted: 1 });
    expect(delegate).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(shardPath, "utf8"))).toMatchObject({
      raw_json: '{"signals":[]}'
    });
  });

  it("does not finalize the manifest after a shard persistence failure", async () => {
    await writeDataset();
    const logs: string[] = [];
    const run = runExtractionFill({
      variant: VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      concurrency: 1,
      extractorFactory: () => ({
        extract: async (input) => {
          const turn = JSON.parse(input.userPrompt) as { turn_content: string };
          const key = computeCacheKey(
            "fixture-model",
            "provider-default-v1",
            OFFICIAL_API_SYSTEM_PROMPT,
            turn.turn_content
          );
          mkdirSync(cacheFilePath(cacheRoot, key), { recursive: true });
          return { rawJson: '{"signals":[]}' };
        }
      }),
      log: (message) => logs.push(message)
    });

    await expect(run).rejects.toThrow(/failed to persist extraction cache shard/u);
    expect(logs.some((message) => message.includes("[extraction-fill] done"))).toBe(false);
    expect(readExtractionCacheManifest(cacheRoot)).toMatchObject({
      builder: "extraction-fill",
      cached_turns: 0,
      coverage: 0
    });
    const temporaryShards = readdirSync(cacheRoot)
      .filter((entry) => /^[0-9a-f]{2}$/u.test(entry))
      .flatMap((prefix) => readdirSync(join(cacheRoot, prefix)))
      .filter((entry) => entry.endsWith(".tmp"));
    expect(temporaryShards).toEqual([]);
  });

  it("aggregates retry and terminal transport telemetry", async () => {
    await writeDataset();
    let call = 0;
    const logs: string[] = [];
    const run = runExtractionFill({
      variant: VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      concurrency: 1,
      extractorFactory: () => ({
        extract: async () => {
          call += 1;
          if (call === 1) {
            return {
              rawJson: '{"signals":[]}',
              extractorMeta: {
                recoveryKind: "none",
                retryCount: 1,
                retryClassification: "success_after_retry",
                rateLimitRetries: 1
              }
            };
          }
          const error = new Error("provider retries exhausted");
          (error as { benchRetry?: unknown }).benchRetry = {
            retryCount: 3,
            retryClassification: "failure_max_retries",
            rateLimitRetries: 2
          };
          throw error;
        }
      }),
      log: (message) => logs.push(message)
    });

    await expect(run).rejects.toMatchObject({
      name: "ExtractionFillTaskError",
      retryClassification: "failure_max_retries"
    });
    expect(logs).toEqual(expect.arrayContaining([expect.stringMatching(
      /retry_classification=failure_max_retries.*retry_successes=1.*rate_limit_retries=3/u
    )]));
    expect(logs.some((message) => message.includes("[extraction-fill] done"))).toBe(false);
  });
});

async function fill(extract: () => Promise<{ rawJson: string }> | { rawJson: string }) {
  return runExtractionFill({
    variant: VARIANT,
    cacheRoot,
    dataDir,
    pinnedMetaRoot,
    concurrency: 1,
    extractorFactory: () => ({ extract: async () => extract() }),
    log: () => undefined
  });
}

function firstShardPath(): string {
  const prefix = readdirSync(cacheRoot).find((entry) => /^[0-9a-f]{2}$/u.test(entry));
  if (prefix === undefined) throw new Error("expected extraction shard prefix");
  const file = readdirSync(join(cacheRoot, prefix))[0];
  if (file === undefined) throw new Error("expected extraction shard");
  return join(cacheRoot, prefix, file);
}

async function writeDataset(): Promise<void> {
  const raw = JSON.stringify([question()]);
  await writeFile(join(dataDir, `${VARIANT}.json`), raw, "utf8");
  await writeFile(join(pinnedMetaRoot, `${VARIANT}.meta.json`), JSON.stringify({
    name: VARIANT,
    sha256: createHash("sha256").update(raw, "utf8").digest("hex"),
    question_count: 1
  }), "utf8");
}

function question(): LongMemEvalQuestion {
  return {
    question_id: "q001",
    question_type: "single_session",
    question: "What happened?",
    answer: "alpha",
    question_date: "2026-01-01",
    haystack_session_ids: ["s1", "s2"],
    haystack_dates: ["2025-12-01", "2025-12-02"],
    haystack_sessions: [[
      { role: "user", content: "alpha", has_answer: true },
      { role: "assistant", content: "ok" }
    ], [{ role: "user", content: "unrelated decoy" }]],
    answer_session_ids: ["s1"]
  };
}
