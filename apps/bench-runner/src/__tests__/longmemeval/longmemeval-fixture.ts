import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LongMemEvalQuestion } from "../../longmemeval/ingestion/dataset.js";

// @anchor longmemeval-test-fixture — shared tiny-dataset builder for the
// offline (no-credentials) seed path. Reused by the snapshot / CLI / recall-eval
// determinism tests so the fixture shape stays single-source.

/** A one-answer-turn question with one decoy session, for offline seed tests. */
export function buildLongMemEvalFixtureQuestion(
  id: string,
  sessionId: string
): LongMemEvalQuestion {
  return {
    question_id: id,
    question_type: "single_session",
    question: `coelacanth depth fact ${id}`,
    answer: `answer ${id}`,
    question_date: "2026-01-01",
    haystack_session_ids: [sessionId, `decoy-${id}`],
    haystack_dates: ["2025-12-01", "2025-11-01"],
    haystack_sessions: [
      [
        {
          role: "user",
          content: `coelacanth depth fact ${id}: it swims very deep in the ocean.`,
          has_answer: true
        },
        { role: "assistant", content: "Acknowledged." }
      ],
      [{ role: "user", content: "unrelated chatter about pasta recipes." }]
    ],
    answer_session_ids: [sessionId]
  };
}

/**
 * Write a fixture dataset JSON + its pinned-meta checksum so loadDataset (which
 * verifies the local JSON sha256 against the pinned meta) accepts it.
 */
export async function writeLongMemEvalFixtureDataset(input: {
  readonly variant: string;
  readonly dataDir: string;
  readonly pinnedMetaRoot: string;
  readonly questions: readonly LongMemEvalQuestion[];
}): Promise<void> {
  const raw = JSON.stringify(input.questions);
  const sha = createHash("sha256").update(raw, "utf8").digest("hex");
  await writeFile(join(input.dataDir, `${input.variant}.json`), raw, "utf8");
  await writeFile(
    join(input.pinnedMetaRoot, `${input.variant}.meta.json`),
    JSON.stringify({
      name: input.variant,
      sha256: sha,
      question_count: input.questions.length
    }),
    "utf8"
  );
}
