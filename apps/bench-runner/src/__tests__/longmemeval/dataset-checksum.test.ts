import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadDataset } from "../../longmemeval/fetch.js";

let tmpDir: string;
let dataDir: string;
let pinnedMetaRoot: string;

const VARIANT = "longmemeval_oracle" as const;

// Minimal but schema-valid LongMemEval question for the test fixture.
const FIXTURE_QUESTIONS = [
  {
    question_id: "fixture-1",
    question_type: "single_session",
    question: "fixture probe",
    answer: "fixture answer",
    question_date: "2026-01-01",
    haystack_session_ids: ["session-a"],
    haystack_dates: ["2025-12-01"],
    haystack_sessions: [
      [{ role: "user", content: "fixture content", has_answer: true }]
    ],
    answer_session_ids: ["session-a"]
  }
];

async function seedLocalDataset(rawOverride?: string): Promise<string> {
  const raw = rawOverride ?? JSON.stringify(FIXTURE_QUESTIONS);
  await writeFile(join(dataDir, `${VARIANT}.json`), raw, "utf8");
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

async function seedPinnedMeta(sha256: string): Promise<void> {
  await writeFile(
    join(pinnedMetaRoot, `${VARIANT}.meta.json`),
    JSON.stringify(
      {
        name: VARIANT,
        sha256,
        question_count: FIXTURE_QUESTIONS.length,
        first_pinned_at: "2026-05-14T00:00:00Z",
        pinned_by_commit: "test"
      },
      null,
      2
    ),
    "utf8"
  );
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "alaya-dataset-checksum-"));
  dataDir = join(tmpDir, "data");
  pinnedMetaRoot = join(tmpDir, "pinned-meta");
  await mkdir(dataDir, { recursive: true });
  await mkdir(pinnedMetaRoot, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("loadDataset checksum verification", () => {
  it("loads the dataset when the local sha256 matches the pinned sha256", async () => {
    const sha = await seedLocalDataset();
    await seedPinnedMeta(sha);

    const result = await loadDataset(VARIANT, { dataDir, pinnedMetaRoot });

    expect(result).toHaveLength(FIXTURE_QUESTIONS.length);
    expect(result[0]?.question_id).toBe("fixture-1");
  });

  it("throws checksum mismatch when the local file is mutated after pinning", async () => {
    const sha = await seedLocalDataset();
    await seedPinnedMeta(sha);

    // Mutate the local file so its sha drifts away from the pinned value.
    const localPath = join(dataDir, `${VARIANT}.json`);
    const original = await readFile(localPath, "utf8");
    await writeFile(localPath, original + "\n// mutated\n", "utf8");

    await expect(
      loadDataset(VARIANT, { dataDir, pinnedMetaRoot })
    ).rejects.toThrow(/dataset checksum mismatch: longmemeval_oracle/);
  });

  it("throws 'dataset not pinned' when the pinned meta file is missing", async () => {
    await seedLocalDataset();
    // Intentionally do NOT seed pinned meta.
    await unlink(join(pinnedMetaRoot, `${VARIANT}.meta.json`)).catch(() => {
      // Already absent; that is the precondition under test.
    });

    await expect(
      loadDataset(VARIANT, { dataDir, pinnedMetaRoot })
    ).rejects.toThrow(/dataset not pinned: longmemeval_oracle/);
  });
});
