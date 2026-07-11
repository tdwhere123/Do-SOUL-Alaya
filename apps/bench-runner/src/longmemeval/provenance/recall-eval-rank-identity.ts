import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { snapshotQuestionIdDigest } from "../snapshot.js";

export const RECALL_EVAL_RANK_IDENTITY_FILENAME =
  "recall-eval-rank-identity.json";

export interface RecallEvalRankIdentityInput {
  readonly questionId: string;
  readonly deliveredObjectIds: readonly string[];
}

export interface RecallEvalRankIdentityBinding {
  readonly expectedQuestionCount: number;
  readonly expectedQuestionIdDigest: string | null;
  readonly requireFullSnapshotMatch: boolean;
}

export function renderRecallEvalRankIdentity(
  collected: readonly RecallEvalRankIdentityInput[],
  binding: RecallEvalRankIdentityBinding
): string {
  if (collected.length === 0) {
    throw new Error("recall-eval rank identity refuses an empty replay");
  }
  const questionIdDigest = snapshotQuestionIdDigest(collected);
  const fullSnapshotMatch =
    collected.length === binding.expectedQuestionCount &&
    binding.expectedQuestionIdDigest !== null &&
    questionIdDigest === binding.expectedQuestionIdDigest;
  if (binding.requireFullSnapshotMatch && !fullSnapshotMatch) {
    throw new Error("recall-eval rank identity does not match the frozen snapshot binding");
  }
  const questions = collected.map((result) => ({
    question_id: result.questionId,
    delivered_object_ids: [...result.deliveredObjectIds]
  }));
  return `${JSON.stringify({
    schema_version: 1,
    snapshot_binding: {
      expected_question_count: binding.expectedQuestionCount,
      expected_question_id_digest: binding.expectedQuestionIdDigest
    },
    replay: {
      question_count: collected.length,
      question_id_digest: questionIdDigest,
      full_snapshot_match: fullSnapshotMatch
    },
    questions
  }, null, 2)}\n`;
}

export async function writeRecallEvalRankIdentity(
  archiveRoot: string,
  collected: readonly RecallEvalRankIdentityInput[],
  binding: RecallEvalRankIdentityBinding
): Promise<void> {
  await writeFile(
    join(archiveRoot, RECALL_EVAL_RANK_IDENTITY_FILENAME),
    renderRecallEvalRankIdentity(collected, binding),
    "utf8"
  );
}
