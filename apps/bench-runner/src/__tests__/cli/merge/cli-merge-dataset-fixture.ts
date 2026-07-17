import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const STATIC_IDS = [
  "legacy-hit", "q-a", "q-b", "q-binding", "q-bundle", "q-collide",
  "q-compact", "q-diagnostics-a", "q-failed", "q-full", "q-full-gold-a",
  "q-full-gold-b", "q-full-gold-expected", "q-history", "q-merge",
  "q-missing-diag", "q-ok", "q-one", "q-partial", "q-provenance",
  "q-stream", "q-taxonomy-legacy", "q-unverified", "workspace-1"
] as const;
const PREFIXES = [
  "q", "fixture", "gate-a", "gate-b", "lat-a", "lat-b", "qA", "qB",
  "q-baseline", "q-chat", "q-chat-mixed", "q-gate-drops-a",
  "q-gate-drops-b", "q-latest-run-a", "q-latest-run-b", "q-passing",
  "q-seed-clean", "q-seed-fallback", "q-seed-official", "q-seed-offline",
  "q-seed-zero-a", "q-seed-zero-b", "q-shard-a", "q-shard-b",
  "q-shard-default"
] as const;
const GENERATED_IDS = PREFIXES.flatMap((prefix) =>
  Array.from({ length: 500 }, (_, index) => `${prefix}-${index + 1}`)
);

export const MERGE_TEST_DATASET_CONTENTS = `${JSON.stringify(
  [...new Set([...GENERATED_IDS, ...STATIC_IDS])].map((question_id) => ({
    question_id,
    question_type: "single-session-user",
    question: `Question ${question_id}`,
    answer: "fixture answer",
    question_date: "2026-01-01",
    haystack_session_ids: [],
    haystack_dates: [],
    haystack_sessions: [],
    answer_session_ids: []
  })),
  null,
  2
)}\n`;

export const MERGE_TEST_DATASET_SHA256 = createHash("sha256")
  .update(MERGE_TEST_DATASET_CONTENTS, "utf8")
  .digest("hex");

export async function createMergeDatasetSource(root: string): Promise<{
  readonly sourcePath: string;
  readonly checksumSourcePath: string;
  readonly cliArgs: readonly string[];
}> {
  const dataDir = path.join(root, "dataset");
  const pinnedMetaRoot = path.join(root, "pinned-dataset");
  const sourcePath = path.join(dataDir, "longmemeval_s.json");
  const checksumSourcePath = path.join(pinnedMetaRoot, "longmemeval_s.meta.json");
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(pinnedMetaRoot, { recursive: true })
  ]);
  await Promise.all([
    writeFile(sourcePath, MERGE_TEST_DATASET_CONTENTS),
    writeFile(
      checksumSourcePath,
      `${JSON.stringify({ sha256: MERGE_TEST_DATASET_SHA256 })}\n`
    )
  ]);
  return {
    sourcePath,
    checksumSourcePath,
    cliArgs: ["--data-dir", dataDir, "--pinned-meta-root", pinnedMetaRoot]
  };
}
