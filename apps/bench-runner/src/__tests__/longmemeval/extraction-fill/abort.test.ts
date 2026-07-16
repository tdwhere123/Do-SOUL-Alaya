import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  readExtractionCacheManifest
} from "../../../longmemeval/extraction-cache-manifest.js";
import {
  runExtractionFill
} from "../../../longmemeval/extraction-fill.js";
import type {
  BenchSignalExtractor
} from "../../../longmemeval/compile-seed.js";
import type {
  LongMemEvalQuestion
} from "../../../longmemeval/dataset.js";

const VARIANT = "longmemeval_oracle";
let root: string;
let cacheRoot: string;
let dataDir: string;
let pinnedMetaRoot: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "extraction-fill-abort-"));
  cacheRoot = join(root, "cache");
  dataDir = join(root, "data");
  pinnedMetaRoot = join(root, "pinned");
  await Promise.all([mkdir(cacheRoot), mkdir(dataDir), mkdir(pinnedMetaRoot)]);
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", "gpt-5.4-mini");
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", "provider-default-v1");
  await writeDataset();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

it("aborts in-flight extraction, releases the lease, and resumes saved shards", async () => {
  const controller = new AbortController();
  const interrupted = new Error("operator interrupted extraction-fill");
  const secondStarted = deferred();
  const logs: string[] = [];
  let calls = 0;
  const extract = vi.fn<BenchSignalExtractor["extract"]>(async (input) => {
    calls += 1;
    if (calls === 1) return { rawJson: '{"signals":[]}' };
    secondStarted.resolve();
    return waitForAbort(input.abortSignal);
  });
  const running = runExtractionFill({
    variant: VARIANT,
    cacheRoot,
    dataDir,
    pinnedMetaRoot,
    concurrency: 1,
    signal: controller.signal,
    extractorFactory: () => ({ extract }),
    log: (message) => logs.push(message)
  });

  await secondStarted.promise;
  controller.abort(interrupted);
  await expect(running).rejects.toBe(interrupted);

  expect(logs.some((message) => message.includes("2/2"))).toBe(false);
  expect(existsSync(join(cacheRoot, ".extraction-fill.lock"))).toBe(false);
  expect(readExtractionCacheManifest(cacheRoot)).toMatchObject({
    fill_status: "in_progress",
    requested_turns: 2,
    cached_turns: 1,
    coverage: 0.5
  });
  expect(countShards()).toBe(1);

  const resumed = await runExtractionFill({
    variant: VARIANT,
    cacheRoot,
    dataDir,
    pinnedMetaRoot,
    concurrency: 1,
    extractorFactory: () => ({
      extract: async () => ({ rawJson: '{"signals":[]}' })
    }),
    log: () => undefined
  });
  expect(resumed).toMatchObject({ cacheHits: 1, newlyExtracted: 1, coverage: 1 });
  expect(countShards()).toBe(2);
});

it("stops peer workers on the first terminal task failure and releases the lease", async () => {
  const peerStarted = deferred();
  const logs: string[] = [];
  let calls = 0;
  const extract = vi.fn<BenchSignalExtractor["extract"]>(async (input) => {
    calls += 1;
    if (calls === 1) {
      await peerStarted.promise;
      const error = new Error("sk-do-not-log PROMPT_BODY");
      (error as { benchRetry?: unknown }).benchRetry = {
        retryCount: 0,
        retryClassification: "failure_non_retryable_4xx",
        rateLimitRetries: 0
      };
      throw error;
    }
    peerStarted.resolve();
    return waitForAbort(input.abortSignal);
  });

  const running = runExtractionFill({
    variant: VARIANT,
    cacheRoot,
    dataDir,
    pinnedMetaRoot,
    concurrency: 2,
    extractorFactory: () => ({ extract }),
    log: (message) => logs.push(message)
  });

  await expect(running).rejects.toMatchObject({
    name: "ExtractionFillTaskError",
    exitCode: 1,
    retryClassification: "failure_non_retryable_4xx"
  });
  expect(logs.join("\n")).toContain(
    "retry_classification=failure_non_retryable_4xx"
  );
  expect(logs.join("\n")).not.toMatch(/sk-do-not-log|PROMPT_BODY/u);
  expect(existsSync(join(cacheRoot, ".extraction-fill.lock"))).toBe(false);
});

it("stops on a failing extraction without finalizing the pinned manifest", async () => {
  const extract = vi.fn<BenchSignalExtractor["extract"]>(async () => {
    throw new Error("simulated provider 500");
  });
  const running = runExtractionFill({
    variant: VARIANT,
    cacheRoot,
    dataDir,
    pinnedMetaRoot,
    concurrency: 1,
    extractorFactory: () => ({ extract }),
    log: () => undefined
  });

  await expect(running).rejects.toMatchObject({
    name: "ExtractionFillTaskError",
    retryClassification: "unknown"
  });
  expect(extract).toHaveBeenCalledOnce();
  expect(readExtractionCacheManifest(cacheRoot)).toMatchObject({
    fill_status: "in_progress",
    requested_turns: 2,
    cached_turns: 0,
    coverage: 0
  });
});

it("stops without caching a semantically invalid extraction payload", async () => {
  const running = runExtractionFill({
    variant: VARIANT,
    cacheRoot,
    dataDir,
    pinnedMetaRoot,
    concurrency: 1,
    extractorFactory: () => ({
      extract: async () => ({ rawJson: '{"not_signals":[]}' })
    }),
    log: () => undefined
  });

  await expect(running).rejects.toMatchObject({
    name: "ExtractionFillTaskError",
    retryClassification: "unknown"
  });
  expect(readExtractionCacheManifest(cacheRoot)).toMatchObject({
    fill_status: "in_progress",
    requested_turns: 2,
    cached_turns: 0,
    coverage: 0
  });
});

it("does not finalize coverage when interruption follows the last response", async () => {
  const controller = new AbortController();
  const interrupted = new Error("operator interrupted before finalization");
  const running = runExtractionFill({
    variant: VARIANT,
    cacheRoot,
    dataDir,
    pinnedMetaRoot,
    concurrency: 1,
    signal: controller.signal,
    extractorFactory: () => ({
      extract: async () => ({ rawJson: '{"signals":[]}' })
    }),
    log: (message) => {
      if (message.includes("2/2")) controller.abort(interrupted);
    }
  });

  await expect(running).rejects.toBe(interrupted);
  expect(existsSync(join(cacheRoot, ".extraction-fill.lock"))).toBe(false);
  expect(readExtractionCacheManifest(cacheRoot)).toMatchObject({
    fill_status: "in_progress",
    requested_turns: 2,
    cached_turns: 2,
    coverage: 1
  });
  expect(countShards()).toBe(2);
});

async function waitForAbort(
  signal: AbortSignal | undefined
): Promise<{ readonly rawJson: string }> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(
      () => reject(new Error("abort signal was not propagated")),
      100
    );
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

async function writeDataset(): Promise<void> {
  const questions = [questionFixture()];
  const raw = JSON.stringify(questions);
  const sha256 = createHash("sha256").update(raw, "utf8").digest("hex");
  await writeFile(join(dataDir, `${VARIANT}.json`), raw, "utf8");
  await writeFile(
    join(pinnedMetaRoot, `${VARIANT}.meta.json`),
    JSON.stringify({ sha256, question_count: questions.length }),
    "utf8"
  );
}

function questionFixture(): LongMemEvalQuestion {
  return {
    question_id: "q-abort",
    question_type: "single_session",
    question: "What was saved?",
    answer: "alpha",
    question_date: "2026-01-01",
    haystack_session_ids: ["s-answer", "s-decoy"],
    haystack_dates: ["2025-12-01", "2025-11-01"],
    haystack_sessions: [
      [
        { role: "user", content: "alpha", has_answer: true },
        { role: "assistant", content: "noted" }
      ],
      [{ role: "user", content: "decoy" }]
    ],
    answer_session_ids: ["s-answer"]
  };
}

function countShards(): number {
  return readdirSync(cacheRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[0-9a-f]{2}$/u.test(entry.name))
    .reduce((total, entry) =>
      total + readdirSync(join(cacheRoot, entry.name)).filter(
        (name) => name.endsWith(".json")
      ).length, 0);
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = () => complete();
  });
  return { promise, resolve };
}
