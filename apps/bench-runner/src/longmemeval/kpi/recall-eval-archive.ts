import {
  benchArchiveDiscriminator,
  entrySlug,
  type BenchPolicyShape,
  type BenchSimulateReportMode
} from "@do-soul/alaya-eval";
import { RECALL_EVAL_ARCHIVE_MARKER } from "../recall-eval-archive.js";

export function buildRecallEvalArchiveSlug(input: {
  readonly runAt: Date;
  readonly commitSha7: string;
  readonly policyShape: BenchPolicyShape;
  readonly simulateReport: BenchSimulateReportMode;
}): string {
  return entrySlug(
    input.runAt,
    input.commitSha7,
    `${benchArchiveDiscriminator(input.policyShape, input.simulateReport)}-${RECALL_EVAL_ARCHIVE_MARKER}`
  );
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
