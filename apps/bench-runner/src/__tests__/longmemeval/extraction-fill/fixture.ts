import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, vi } from "vitest";

import type { LongMemEvalQuestion } from "../../../longmemeval/dataset.js";

export const EXTRACTION_FILL_VARIANT = "longmemeval_oracle";

interface ExtractionFillTestRoots {
  readonly cacheRoot: string;
  readonly dataDir: string;
  readonly pinnedMetaRoot: string;
}

export function registerExtractionFillHooks(
  setRoots: (roots: ExtractionFillTestRoots) => void
): (questions: readonly LongMemEvalQuestion[]) => Promise<void> {
  let tmpDir = "";
  let dataDir = "";
  let pinnedMetaRoot = "";
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "extraction-fill-"));
    const cacheRoot = join(tmpDir, "cache");
    dataDir = join(tmpDir, "data");
    pinnedMetaRoot = join(tmpDir, "pinned");
    await mkdir(cacheRoot, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await mkdir(pinnedMetaRoot, { recursive: true });
    vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", "gpt-5.4-mini");
    vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", "provider-default-v1");
    setRoots({ cacheRoot, dataDir, pinnedMetaRoot });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(tmpDir, { recursive: true, force: true });
  });

  return async (questions) => await writeExtractionFillDataset(
    dataDir,
    pinnedMetaRoot,
    questions
  );
}

export function buildExtractionFillQuestion(
  id: string,
  fact: string,
  decoy: string
): LongMemEvalQuestion {
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

async function writeExtractionFillDataset(
  dataDir: string,
  pinnedMetaRoot: string,
  questions: readonly LongMemEvalQuestion[]
): Promise<void> {
  const raw = JSON.stringify(questions);
  const sha = createHash("sha256").update(raw, "utf8").digest("hex");
  await writeFile(
    join(dataDir, `${EXTRACTION_FILL_VARIANT}.json`),
    raw,
    "utf8"
  );
  await writeFile(
    join(pinnedMetaRoot, `${EXTRACTION_FILL_VARIANT}.meta.json`),
    JSON.stringify({
      name: EXTRACTION_FILL_VARIANT,
      sha256: sha,
      question_count: questions.length
    }),
    "utf8"
  );
}

export function expectFirstExtractionShardModel(
  cacheRoot: string,
  shardDirs: readonly string[],
  expectedModel: string
): void {
  const shardDir = shardDirs[0];
  const shardFile = shardDir === undefined
    ? undefined
    : readdirSync(join(cacheRoot, shardDir))[0];
  expect(shardFile).toBeDefined();
  if (shardDir === undefined || shardFile === undefined) {
    throw new Error("expected at least one extraction shard");
  }
  const shard = JSON.parse(
    readFileSync(join(cacheRoot, shardDir, shardFile), "utf8")
  ) as { readonly model: string };
  expect(shard.model).toBe(expectedModel);
}
