import type { LongMemEvalReleaseEvidenceAuthority } from
  "@do-soul/alaya-eval/internal";
import {
  deriveLongMemEvalReleaseEvidenceAuthority,
  type VerifiedLongMemEvalDatasetAuthority
} from "../../longmemeval/fetch.js";
import type { ShardArchiveRef } from "../merge-command-shards.js";

export function deriveMergedLongMemEvalReleaseAuthority(
  datasetAuthority: VerifiedLongMemEvalDatasetAuthority | null,
  shards: readonly ShardArchiveRef[]
): LongMemEvalReleaseEvidenceAuthority | null {
  if (datasetAuthority === null || shards.length === 0) return null;
  const questionIds: string[] = [];
  for (const shard of shards) {
    if (shard.verifiedEvidence === null) return null;
    questionIds.push(...shard.verifiedEvidence.assignments.map(
      (assignment) => assignment.question_id
    ));
  }
  return deriveLongMemEvalReleaseEvidenceAuthority(datasetAuthority, {
    kind: "dataset_order_subset",
    questionIds
  });
}
