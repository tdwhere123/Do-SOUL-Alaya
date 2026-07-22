import { mkdir, mkdtemp, rm } from "node:fs/promises";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import {
  readExtractionCacheManifest
} from "../../../longmemeval/extraction/cache/extraction-cache-manifest.js";
import {
  collectDistinctTurnContents,
  runExtractionFill
} from "../../../longmemeval/extraction/extraction-fill.js";
import { computeExtractionTurnCacheKey } from
  "../../../longmemeval/compile-seed/compile-seed-cache.js";
import { inspectTurnContentKeySpace, type LongMemEvalExtractionTurn } from
  "../../../longmemeval/extraction/turn-contents.js";
import type { LongMemEvalQuestion } from "../../../longmemeval/ingestion/dataset.js";
import {
  inspectExtractionFillCompletion
} from "../../../longmemeval/extraction/fill/fill-completion.js";
import { preflightExtractionCache } from
  "../../../longmemeval/compile-seed/compile-seed-preflight.js";
import {
  buildLongMemEvalFixtureQuestion,
  writeLongMemEvalFixtureDataset
} from "../longmemeval-fixture.js";

const VARIANT = "longmemeval_oracle";
let root: string;
let cacheRoot: string;
let dataDir: string;
let pinnedMetaRoot: string;
let questions: readonly LongMemEvalQuestion[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "extraction-fill-completion-"));
  cacheRoot = join(root, "cache");
  dataDir = join(root, "data");
  pinnedMetaRoot = join(root, "pinned");
  await Promise.all([cacheRoot, dataDir, pinnedMetaRoot].map(
    (path) => mkdir(path, { recursive: true })
  ));
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", "gpt-5.4-mini");
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", "provider-default-v1");
  questions = [
    buildLongMemEvalFixtureQuestion("q1", "s1"),
    buildLongMemEvalFixtureQuestion("q2", "s2")
  ];
  await writeLongMemEvalFixtureDataset({
    variant: VARIANT,
    dataDir,
    pinnedMetaRoot,
    questions
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

it("scopes an expanded fill before workers and refreshes honest partial progress", async () => {
  const firstExpected = collectDistinctTurnContents(questions.slice(0, 1)).length;
  const expandedExpected = collectDistinctTurnContents(questions).length;
  let firstWorkerManifest: unknown;
  const first = await runExtractionFill({
    variant: VARIANT,
    cacheRoot,
    dataDir,
    pinnedMetaRoot,
    limit: 1,
    extractorFactory: () => ({
      extract: async () => {
        firstWorkerManifest ??= readExtractionCacheManifest(cacheRoot);
        return { rawJson: '{"signals":[]}' };
      }
    }),
    log: () => undefined
  });
  expect(firstWorkerManifest).toMatchObject({
    fill_status: "in_progress",
    window_offset: 0,
    window_limit: 1,
    expected_turns: firstExpected,
    cached_turns: 0,
    coverage: 0
  });
  expect(first.manifest).toMatchObject({
    fill_status: "complete",
    window_offset: 0,
    window_limit: 1,
    expected_turns: firstExpected,
    requested_turns: firstExpected,
    cached_turns: firstExpected,
    coverage: 1
  });
  expect(first.manifest).toHaveProperty(
    "expected_key_set_sha256",
    expect.stringMatching(/^[0-9a-f]{64}$/u)
  );
  expect(first.manifest).toHaveProperty(
    "content_closure_sha256",
    expect.stringMatching(/^[0-9a-f]{64}$/u)
  );
  expect(Object.keys(first.manifest.content_closure_index ?? {}))
    .toHaveLength(firstExpected);

  let manifestSeenByWorker: unknown;
  const expanded = runExtractionFill({
    variant: VARIANT,
    cacheRoot,
    dataDir,
    pinnedMetaRoot,
    limit: 2,
    concurrency: 1,
    extractorFactory: () => ({
      extract: async () => {
        manifestSeenByWorker = readExtractionCacheManifest(cacheRoot);
        throw new Error("terminal fixture failure");
      }
    }),
    log: () => undefined
  });

  await expect(expanded).rejects.toMatchObject({ name: "ExtractionFillTaskError" });
  const expectedPartial = {
    fill_status: "in_progress",
    window_offset: 0,
    window_limit: 2,
    expected_turns: expandedExpected,
    requested_turns: expandedExpected,
    cached_turns: firstExpected,
    coverage: firstExpected / expandedExpected
  };
  expect(manifestSeenByWorker).toMatchObject(expectedPartial);
  expect(readExtractionCacheManifest(cacheRoot)).toMatchObject(expectedPartial);
  expect(readExtractionCacheManifest(cacheRoot)?.content_closure_index)
    .toBeUndefined();
  expect(readExtractionCacheManifest(cacheRoot)?.expected_key_set_sha256)
    .not.toBe(first.manifest.expected_key_set_sha256);
});

it("refuses completion when an expected shard is replaced by an orphan", async () => {
  const expectedTurns = collectDistinctTurnContents(questions.slice(0, 1)).length;
  let injected = false;
  const run = runExtractionFill({
    variant: VARIANT,
    cacheRoot,
    dataDir,
    pinnedMetaRoot,
    limit: 1,
    concurrency: 1,
    extractorFactory: emptyExtractor,
    log: (message) => {
      if (injected || !message.includes(`${expectedTurns}/${expectedTurns}`)) return;
      injected = true;
      const shardPath = firstShardPath();
      rmSync(shardPath);
      writeOrphanShard("f".repeat(64));
    }
  });

  await expect(run).rejects.toThrow(/completion.*missing=1.*orphan=1/iu);
  expect(readExtractionCacheManifest(cacheRoot)).toMatchObject({
    fill_status: "in_progress",
    expected_turns: expectedTurns,
    requested_turns: expectedTurns,
    cached_turns: expectedTurns - 1,
    coverage: (expectedTurns - 1) / expectedTurns
  });
});

it("refuses completion when an expected shard becomes invalid", async () => {
  const expectedTurns = collectDistinctTurnContents(questions.slice(0, 1)).length;
  let corrupted = false;
  const run = runExtractionFill({
    variant: VARIANT,
    cacheRoot,
    dataDir,
    pinnedMetaRoot,
    limit: 1,
    concurrency: 1,
    extractorFactory: emptyExtractor,
    log: (message) => {
      if (corrupted || !message.includes(`${expectedTurns}/${expectedTurns}`)) return;
      corrupted = true;
      writeFileSync(firstShardPath(), "{broken", "utf8");
    }
  });

  await expect(run).rejects.toThrow(/completion.*invalid=1.*orphan=0/iu);
  expect(readExtractionCacheManifest(cacheRoot)).toMatchObject({
    fill_status: "in_progress",
    cached_turns: expectedTurns - 1,
    coverage: (expectedTurns - 1) / expectedTurns
  });
});

it("exposes a reusable read-only exact-set completion inspection", async () => {
  const turns = inspectTurnContentKeySpace(questions.slice(0, 1)).distinctExtractionTurns;
  const completed = await runExtractionFill({
    variant: VARIANT,
    cacheRoot,
    dataDir,
    pinnedMetaRoot,
    limit: 1,
    extractorFactory: emptyExtractor,
    log: () => undefined
  });
  const inspection = inspect(turns);
  expect(inspection).toMatchObject({
    expectedTurns: turns.length,
    validTurns: turns.length,
    missingTurns: 0,
    invalidTurns: 0,
    orphanTurns: 0,
    coverage: 1,
    expectedKeySetSha256: completed.manifest.expected_key_set_sha256,
    contentClosureSha256: completed.manifest.content_closure_sha256
  });
  expect(inspect([...turns].reverse()).expectedKeySetSha256)
    .toBe(inspection.expectedKeySetSha256);
  expect(inspect([...turns].reverse()).contentClosureSha256)
    .toBe(inspection.contentClosureSha256);
});

it("uses no partial closure when ledger exclusions leave no valid raw entries", async () => {
  const turns = inspectTurnContentKeySpace(questions.slice(0, 1)).distinctExtractionTurns;
  await runExtractionFill({
    variant: VARIANT,
    cacheRoot,
    dataDir,
    pinnedMetaRoot,
    limit: 1,
    extractorFactory: emptyExtractor,
    log: () => undefined
  });
  const excludedKeys = turns.map((turn) => computeExtractionTurnCacheKey(
    "gpt-5.4-mini", "provider-default-v1", OFFICIAL_API_SYSTEM_PROMPT, turn
  ));
  const inspection = inspectExtractionFillCompletion({
    cacheRoot,
    model: "gpt-5.4-mini",
    requestProfile: "provider-default-v1",
    systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
    extractionTurns: turns,
    excludeContentClosureKeys: excludedKeys
  });

  expect(inspect(turns).partialContentClosureSha256).toMatch(/^[0-9a-f]{64}$/u);
  expect(inspection.partialContentClosureSha256).toBeNull();
});

it("rejects a valid shard whose raw JSON changed after finalization", async () => {
  const turnContents = collectDistinctTurnContents(questions.slice(0, 1));
  await runExtractionFill({
    variant: VARIANT,
    cacheRoot,
    dataDir,
    pinnedMetaRoot,
    limit: 1,
    extractorFactory: emptyExtractor,
    log: () => undefined
  });
  const shardPath = firstShardPath();
  const shard = JSON.parse(readFileSync(shardPath, "utf8")) as Record<string, unknown>;
  writeFileSync(shardPath, JSON.stringify({
    ...shard,
    raw_json: "{ \"signals\": [] }"
  }), "utf8");

  expect(() => preflightExtractionCache({
    cacheRoot,
    config: {
      providerUrl: "https://example.test/v1",
      model: "gpt-5.4-mini",
      requestProfile: "provider-default-v1",
      apiKey: null
    },
    systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
    requiredTurnContents: turnContents,
    requiredQuestionWindow: { offset: 0, limit: 1 }
  })).toThrow(/content closure/iu);
});

it("rejects a narrower window on a superset root before creating a delegate", async () => {
  await runExtractionFill({
    variant: VARIANT,
    cacheRoot,
    dataDir,
    pinnedMetaRoot,
    limit: 2,
    extractorFactory: emptyExtractor,
    log: () => undefined
  });
  const completeManifest = readExtractionCacheManifest(cacheRoot);
  const extractorFactory = vi.fn(emptyExtractor);

  await expect(runExtractionFill({
    variant: VARIANT,
    cacheRoot,
    dataDir,
    pinnedMetaRoot,
    limit: 1,
    extractorFactory,
    log: () => undefined
  })).rejects.toThrow(/outside.*requested window|superset/iu);
  expect(extractorFactory).not.toHaveBeenCalled();
  expect(readExtractionCacheManifest(cacheRoot)).toEqual(completeManifest);
});

function emptyExtractor() {
  return { extract: async () => ({ rawJson: '{"signals":[]}' }) };
}

function firstShardPath(): string {
  for (const prefix of readdirSync(cacheRoot, { withFileTypes: true })) {
    if (!prefix.isDirectory() || !/^[0-9a-f]{2}$/u.test(prefix.name)) continue;
    const shard = readdirSync(join(cacheRoot, prefix.name)).find(
      (name) => name.endsWith(".json")
    );
    if (shard !== undefined) return join(cacheRoot, prefix.name, shard);
  }
  throw new Error("expected a shard to replace");
}

function writeOrphanShard(cacheKey: string): void {
  const prefix = join(cacheRoot, cacheKey.slice(0, 2));
  mkdirSync(prefix, { recursive: true });
  writeFileSync(join(prefix, `${cacheKey}.json`), JSON.stringify({
    model: "gpt-5.4-mini",
    request_profile: "provider-default-v1",
    cache_key: cacheKey,
    raw_json: '{"signals":[]}',
    extracted_at: "2026-07-16T00:00:00.000Z"
  }), "utf8");
}

function inspect(extractionTurns: readonly LongMemEvalExtractionTurn[]) {
  return inspectExtractionFillCompletion({
    cacheRoot,
    model: "gpt-5.4-mini",
    requestProfile: "provider-default-v1",
    systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
    extractionTurns
  });
}
