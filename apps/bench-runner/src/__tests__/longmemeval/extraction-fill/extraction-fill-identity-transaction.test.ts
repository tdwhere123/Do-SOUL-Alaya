import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import { runExtractionFill } from "../../../longmemeval/extraction/extraction-fill.js";
import {
  computeSystemPromptSha256,
  readExtractionCacheManifest,
  writeExtractionCacheManifest
} from "../../../longmemeval/extraction/cache/extraction-cache-manifest.js";
import type { LongMemEvalQuestion } from "../../../longmemeval/ingestion/dataset.js";

const VARIANT = "longmemeval_oracle";
let root: string;
let cacheRoot: string;
let dataDir: string;
let pinnedMetaRoot: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fill-identity-transaction-"));
  cacheRoot = join(root, "cache");
  dataDir = join(root, "data");
  pinnedMetaRoot = join(root, "pinned");
  await Promise.all([cacheRoot, dataDir, pinnedMetaRoot].map(
    (path) => mkdir(path, { recursive: true })
  ));
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", "fixture-model");
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", "provider-default-v1");
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", "https://provider-a.invalid/v1");
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_MODEL_FAMILY", "family-a");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("extraction-fill identity transaction", () => {
  it("rejects manifest replacement during dataset preparation on an all-hit run", async () => {
    await writeDataset([question()]);
    await fillSuccessfully();
    const rerun = fillSuccessfully();
    writeIdentityManifest("https://provider-b.invalid/v1", "family-b", "replacement");
    await expect(rerun).rejects.toThrow(/changed during authority preparation/u);
    expect(readExtractionCacheManifest(cacheRoot)?.builder).toBe("replacement");
  });

  it("rejects manifest replacement during dataset preparation on a zero-turn run", async () => {
    await writeDataset([]);
    writeIdentityManifest("https://provider-a.invalid/v1", "family-a", "initial");
    const run = fillSuccessfully();
    writeIdentityManifest("https://provider-b.invalid/v1", "family-b", "replacement");
    await expect(run).rejects.toThrow(/changed during authority preparation/u);
    expect(readExtractionCacheManifest(cacheRoot)?.builder).toBe("replacement");
  });

  it("rejects a shard injected into a manifest-less root during dataset preparation", async () => {
    await writeDataset([question()]);
    const run = fillSuccessfully();
    mkdirSync(join(cacheRoot, "aa"));
    writeFileSync(join(cacheRoot, "aa", "injected.json"), "{}", "utf8");
    await expect(run).rejects.toThrow(
      /cache contains .*shard.*(?:outside the requested window|no manifest)|cache identity.*shard|manifest-less cache.*shard/u,
    );
    expect(readExtractionCacheManifest(cacheRoot)).toBeUndefined();
  });

  it("checks pinned identity again after workers finish and before finalization", async () => {
    await writeDataset([question()]);
    const run = runExtractionFill({
      variant: VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      concurrency: 1,
      extractorFactory: () => ({ extract: async () => ({ rawJson: '{"signals":[]}' }) }),
      log: (message) => {
        if (!message.includes("2/2")) return;
        writeIdentityManifest("https://provider-a.invalid/v1", "family-a", "replacement");
      }
    });
    await expect(run).rejects.toThrow(/identity changed before finalization/u);
    expect(readExtractionCacheManifest(cacheRoot)?.builder).toBe("replacement");
  });

  it("keeps the lease until all workers settle after a fatal invariant", async () => {
    await writeDataset([question()]);
    let releaseBlocked!: () => void;
    let blockedStarted!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseBlocked = resolve; });
    const started = new Promise<void>((resolve) => { blockedStarted = resolve; });
    let call = 0;
    let settled = false;
    const run = runExtractionFill({
      variant: VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      concurrency: 2,
      extractorFactory: () => ({
        extract: async () => {
          call++;
          if (call === 1) {
            await started;
            writeIdentityManifest("https://provider-b.invalid/v1", "family-b", "replacement");
          } else {
            blockedStarted();
            await blocked;
          }
          return { rawJson: '{"signals":[]}' };
        }
      }),
      log: () => undefined
    });
    void run.finally(() => { settled = true; }).catch(() => undefined);
    await started;
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(existsSync(join(cacheRoot, ".extraction-fill.lock"))).toBe(true);
    releaseBlocked();
    await expect(run).rejects.toThrow(/manifest changed during live extraction/u);
  });
});

async function fillSuccessfully() {
  return runExtractionFill({
    variant: VARIANT,
    cacheRoot,
    dataDir,
    pinnedMetaRoot,
    concurrency: 1,
    extractorFactory: () => ({ extract: async () => ({ rawJson: '{"signals":[]}' }) }),
    log: () => undefined
  });
}

async function writeDataset(questions: readonly LongMemEvalQuestion[]): Promise<void> {
  const raw = JSON.stringify(questions);
  await writeFile(join(dataDir, `${VARIANT}.json`), raw, "utf8");
  await writeFile(join(pinnedMetaRoot, `${VARIANT}.meta.json`), JSON.stringify({
    name: VARIANT,
    sha256: createHash("sha256").update(raw, "utf8").digest("hex"),
    question_count: questions.length
  }), "utf8");
}

function writeIdentityManifest(providerUrl: string, modelFamily: string, builder: string): void {
  writeExtractionCacheManifest(cacheRoot, {
    schema_version: 2,
    extraction_model: "fixture-model",
    model_family: modelFamily,
    provider_url: providerUrl,
    system_prompt_sha256: computeSystemPromptSha256(OFFICIAL_API_SYSTEM_PROMPT),
    cache_key_algo: "sha256(model\\0systemPrompt\\0turnContent)",
    dataset: "longmemeval-oracle",
    dataset_revision: "fixture",
    storage: "git-tracked",
    built_at: "2026-07-12T00:00:00.000Z",
    builder
  });
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
    haystack_sessions: [
      [
        { role: "user", content: "alpha", has_answer: true },
        { role: "assistant", content: "ok" }
      ],
      [{ role: "user", content: "unrelated decoy" }]
    ],
    answer_session_ids: ["s1"]
  };
}
