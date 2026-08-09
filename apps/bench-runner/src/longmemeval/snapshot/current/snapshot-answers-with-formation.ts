import {
  inspectSnapshotGraphPreflight,
  type SnapshotGraphPreflight
} from
  "./snapshot-graph-preflight.js";
import type { LongMemEvalAnswersWithFormationReceipt } from
  "../materialize.js";

interface SnapshotFormationQuestion {
  readonly workspaceId: string;
  readonly answersWithFormation?: LongMemEvalAnswersWithFormationReceipt;
}

export function assertSnapshotAnswersWithFormation(
  dbPath: string,
  questions?: readonly SnapshotFormationQuestion[]
): Readonly<SnapshotGraphPreflight> {
  const preflight = inspectSnapshotGraphPreflight(dbPath);
  if (preflight.eligibleCount < 1) {
    throw new Error(
      "snapshot writer requires at least one eligible answers_with relation"
    );
  }
  if (questions !== undefined) {
    assertFormationReceipts(preflight, questions);
  }
  return preflight;
}

function assertFormationReceipts(
  preflight: Readonly<SnapshotGraphPreflight>,
  questions: readonly SnapshotFormationQuestion[]
): void {
  const receipts = questions.map((question) => ({
    workspaceId: question.workspaceId,
    receipt: requireValidReceipt(question)
  }));
  const expectedCount = receipts.reduce((sum, item) => sum + item.receipt.admitted, 0);
  if (preflight.eligibleCount !== expectedCount) {
    throw new Error(
      "snapshot answers_with formation count mismatch: " +
      `eligible_paths=${preflight.eligibleCount} admitted=${expectedCount}`
    );
  }
  const expected = receipts
    .filter((item) => item.receipt.admitted > 0)
    .map((item) => item.workspaceId)
    .sort();
  const actual = [...preflight.eligibleWorkspaceIds].sort();
  if (expected.length !== actual.length ||
      expected.some((workspaceId, index) => workspaceId !== actual[index])) {
    throw new Error(
      "snapshot answers_with formation coverage mismatch: " +
      `eligible_workspaces=${actual.length} expected_workspaces=${expected.length}`
    );
  }
}

function requireValidReceipt(
  question: SnapshotFormationQuestion
): LongMemEvalAnswersWithFormationReceipt {
  const receipt = question.answersWithFormation;
  if (receipt === undefined) {
    throw new Error(
      `snapshot question ${question.workspaceId} is missing answers_with formation receipt`
    );
  }
  const counts = [receipt.coRelevantPairs, receipt.keptPairs, receipt.admitted];
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 0) ||
      receipt.coRelevantPairs < receipt.keptPairs ||
      receipt.keptPairs !== receipt.admitted) {
    throw new Error(
      `snapshot question ${question.workspaceId} has invalid answers_with formation receipt`
    );
  }
  return receipt;
}
