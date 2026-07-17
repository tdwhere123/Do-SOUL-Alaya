import type { ShardArchiveRef } from "../command/merge-command-shards.js";
import {
  createLongMemEvalSelectionContractFromAssignments,
  type LongMemEvalSelectionContract
} from "../../../longmemeval/selection/contract.js";

export function buildMergedSelectionContract(
  refs: readonly ShardArchiveRef[]
): LongMemEvalSelectionContract | null {
  if (!refs.every((ref) => ref.verifiedEvidence !== null)) return null;
  const datasetSha256 = refs[0]?.payload.dataset.checksum_sha256;
  if (datasetSha256 === undefined) return null;
  return createLongMemEvalSelectionContractFromAssignments({
    datasetSha256,
    assignments: refs.flatMap((ref) => ref.verifiedEvidence!.assignments)
  });
}
