import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, vi } from "vitest";

import type { LongMemEvalQuestion } from "../../../longmemeval/ingestion/dataset.js";
import { signalsEnvelope } from "../compile-seed/compile-seed-fixture.js";

export const EXTRACTION_FILL_VARIANT = "longmemeval_oracle";

interface ExtractionFillTestRoots {
  readonly cacheRoot: string;
  readonly dataDir: string;
  readonly pinnedMetaRoot: string;
}

export function registerExtractionFillHooks(
  setRoots: (roots: ExtractionFillTestRoots) => void,
  variant: string = EXTRACTION_FILL_VARIANT
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
    vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", "https://fixture-provider.invalid/v1");
    setRoots({ cacheRoot, dataDir, pinnedMetaRoot });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(tmpDir, { recursive: true, force: true });
  });

  return async (questions) => await writeExtractionFillDataset(
    dataDir,
    pinnedMetaRoot,
    questions,
    variant
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

export function setExtractionCredentialFixture(): void {
  vi.stubEnv("ALAYA_OFFICIAL_GARDEN_SECRET_REF", "env:E0_TEST_GARDEN_KEY");
  vi.stubEnv("E0_TEST_GARDEN_KEY", "test-key");
}

export function buildAuthorityQuestion(
  id: string,
  fact: string,
  decoy: string
): LongMemEvalQuestion {
  return buildExtractionFillQuestion(
    id,
    `I completed ${fact}.`,
    `I completed ${decoy}.`
  );
}

export function buildGroundedSignalResponse(userPrompt: string): string {
  const request = JSON.parse(userPrompt) as {
    readonly source_assertions?: readonly {
      readonly assertion_id: number;
      readonly text: string;
    }[];
  };
  const sourceAssertion = request.source_assertions?.[0];
  const assertion = sourceAssertion?.text;
  if (assertion === undefined) throw new Error("expected a source assertion");
  const envelope = JSON.parse(
    signalsEnvelope([{ distilled: assertion, matched: assertion }])
  ) as { signals: Record<string, unknown>[] };
  envelope.signals[0]!.source_locator = {
    contract_version: 2,
    kind: "assertion_catalog",
    assertion_id: sourceAssertion.assertion_id
  };
  return JSON.stringify(envelope);
}

async function writeExtractionFillDataset(
  dataDir: string,
  pinnedMetaRoot: string,
  questions: readonly LongMemEvalQuestion[],
  variant: string
): Promise<void> {
  const raw = JSON.stringify(questions);
  const sha = createHash("sha256").update(raw, "utf8").digest("hex");
  await writeFile(
    join(dataDir, `${variant}.json`),
    raw,
    "utf8"
  );
  await writeFile(
    join(pinnedMetaRoot, `${variant}.meta.json`),
    JSON.stringify({
      name: variant,
      sha256: sha,
      size_bytes: Buffer.byteLength(raw, "utf8"),
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
