import {
  buildFineAssessmentComponentLedger,
  reconstructFineAssessmentComposition
} from "@do-soul/alaya-core";
import {
  forEachSelectionBoundaryGzipRecord
} from "./selection-boundary-artifact-reader.js";
import {
  LONGMEMEVAL_SELECTION_BOUNDARY_GZIP_MAX_BYTES
} from "./selection-boundary-spool.js";

const SELECTION_LEDGER_ARTIFACT_ERRORS = Object.freeze({
  utf8Invalid: (context: string) =>
    `selection ledger record UTF-8 is invalid (${context})`,
  jsonInvalid: (context: string) =>
    `selection ledger record JSON is invalid (${context})`,
  gzipExceeded: (maxBytes: number) =>
    `selection ledger gzip exceeds the ${maxBytes} byte size limit`
});

/**
 * Observational ledger sample: derive ledger then prove composition identity.
 * Stops after `sampleLimit` authoritative records.
 */
export async function verifyLongMemEvalSelectionBoundaryLedgerSample(
  artifactPath: string,
  options: {
    readonly maxArtifactBytes?: number;
    readonly sampleLimit?: number;
  } = {}
): Promise<{
  readonly recordCount: number;
  readonly sampleCount: number;
  readonly ledgerCandidateCount: number;
}> {
  const maxArtifactBytes = options.maxArtifactBytes ??
    LONGMEMEVAL_SELECTION_BOUNDARY_GZIP_MAX_BYTES;
  const sampleLimit = options.sampleLimit ?? 3;
  let sampleCount = 0;
  let ledgerCandidateCount = 0;
  const { recordCount } = await forEachSelectionBoundaryGzipRecord(
    artifactPath,
    maxArtifactBytes,
    SELECTION_LEDGER_ARTIFACT_ERRORS,
    async (record) => {
      if (!record.authoritative || sampleCount >= sampleLimit) return;
      const ledger = buildFineAssessmentComponentLedger(record.boundary);
      if (ledger.schema_version !== 1) {
        throw new Error("selection ledger schema_version mismatch");
      }
      if (
        ledger.candidates.length !==
        record.boundary.input.ordered_candidates.length
      ) {
        throw new Error("selection ledger candidate count mismatch");
      }
      reconstructFineAssessmentComposition(record.boundary);
      ledgerCandidateCount += ledger.candidates.length;
      sampleCount += 1;
    }
  );
  return { recordCount, sampleCount, ledgerCandidateCount };
}
