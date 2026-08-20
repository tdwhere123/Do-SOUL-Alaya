import { isCanonicalFtsLaneIds } from "@do-soul/alaya-protocol";
import type { SerializedRecallSupplementaryData } from
  "../selection-boundary-types.js";
import { throwSelectionBoundaryFidelityMismatch } from "./fidelity-error.js";

export function assertEvidenceFtsReceipts(
  data: Readonly<SerializedRecallSupplementaryData>
): void {
  for (const [evidenceRef, receipts] of Object.entries(
    data.evidenceProjectionMatchesByRef ?? {}
  )) {
    if (evidenceRef.length === 0 || receipts.some((receipt) =>
      receipt.evidence_ref !== evidenceRef ||
      (receipt.matched_fts_lanes !== undefined &&
        !isCanonicalFtsLaneIds(receipt.matched_fts_lanes))
    )) {
      throwSelectionBoundaryFidelityMismatch(
        "expected evidence_ref-matching canonical FTS lanes, actual mismatch"
      );
    }
  }
}
