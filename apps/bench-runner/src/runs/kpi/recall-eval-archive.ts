import {
  benchArchiveDiscriminator,
  type BenchPolicyShape,
  type BenchSimulateReportMode
} from "@do-soul/alaya-eval";
import { RECALL_EVAL_ARCHIVE_MARKER } from "../lifecycle/recall-eval/recall-eval-archive-impl.js";
import { composeBenchHistorySlug } from "../provenance/identity/history-code-slug.js";

export function buildRecallEvalArchiveSlug(input: {
  readonly runAt: Date;
  readonly commitSha7: string;
  readonly policyShape: BenchPolicyShape;
  readonly simulateReport: BenchSimulateReportMode;
  readonly worktreeClean: boolean;
  readonly worktreeStateSha256: string;
}): string {
  return composeBenchHistorySlug({
    runAt: input.runAt,
    commitSha7: input.commitSha7,
    policyDiscriminator: `${benchArchiveDiscriminator(input.policyShape, input.simulateReport)}-${RECALL_EVAL_ARCHIVE_MARKER}`,
    worktreeClean: input.worktreeClean,
    worktreeStateSha256: input.worktreeStateSha256
  });
}

export function buildPerQuestionDelivered(
  collected: readonly Readonly<{
    questionId: string;
    deliveredObjectIds: readonly string[];
  }>[]
): ReadonlyMap<string, readonly string[]> {
  return new Map(collected.map((result) => [
    result.questionId,
    result.deliveredObjectIds
  ] as const));
}
