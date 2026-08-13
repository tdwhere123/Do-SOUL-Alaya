import {
  reconstructFineAssessmentComposition
} from "@do-soul/alaya-core";
import {
  forEachSelectionBoundaryGzipRecord
} from "./selection-boundary-artifact-reader.js";
import {
  LONGMEMEVAL_SELECTION_BOUNDARY_GZIP_MAX_BYTES
} from "./selection-boundary-spool.js";

const SELECTION_COMPOSITION_ARTIFACT_ERRORS = Object.freeze({
  utf8Invalid: (context: string) =>
    `selection composition record UTF-8 is invalid (${context})`,
  jsonInvalid: (context: string) =>
    `selection composition record JSON is invalid (${context})`,
  gzipExceeded: (maxBytes: number) =>
    `selection composition gzip exceeds the ${maxBytes} byte size limit`
});

export async function verifyLongMemEvalSelectionBoundaryCompositionArtifact(
  artifactPath: string,
  options: {
    readonly maxArtifactBytes?: number;
    readonly authoritativeOnly?: boolean;
  } = {}
): Promise<{
  readonly recordCount: number;
  readonly compositionCount: number;
}> {
  const maxArtifactBytes = options.maxArtifactBytes ??
    LONGMEMEVAL_SELECTION_BOUNDARY_GZIP_MAX_BYTES;
  const authoritativeOnly = options.authoritativeOnly ?? true;
  let compositionCount = 0;
  const { recordCount } = await forEachSelectionBoundaryGzipRecord(
    artifactPath,
    maxArtifactBytes,
    SELECTION_COMPOSITION_ARTIFACT_ERRORS,
    (record) => {
      if (authoritativeOnly && !record.authoritative) return;
      reconstructFineAssessmentComposition(record.boundary);
      compositionCount += 1;
    }
  );
  return { recordCount, compositionCount };
}
