import { join } from "node:path";
import type { FineAssessmentSelectionBoundaryPendingCapture } from
  "@do-soul/alaya-core";
import {
  createLongMemEvalSelectionBoundarySpool,
  type LongMemEvalSelectionBoundarySpool
} from "../../selection-replay/selection-boundary-spool.js";

export const RECALL_EVAL_SELECTION_BOUNDARY_FILENAME =
  "selection-boundaries.ndjson.gz";

export interface RecallEvalSelectionBoundaryBinding {
  readonly filename: typeof RECALL_EVAL_SELECTION_BOUNDARY_FILENAME;
  readonly sha256: string;
  readonly bytes: number;
  readonly record_count: number;
}

export interface RecallEvalSelectionBoundaryArtifact {
  readonly sourcePath: string;
  readonly binding: RecallEvalSelectionBoundaryBinding;
}

export function createRecallEvalSelectionBoundarySpool(
  env: Readonly<Record<string, string | undefined>>
): Promise<LongMemEvalSelectionBoundarySpool | null> {
  return createLongMemEvalSelectionBoundarySpool({ env, concurrency: 1 });
}

export async function finalizeRecallEvalSelectionBoundarySpool(
  spool: LongMemEvalSelectionBoundarySpool | null
): Promise<RecallEvalSelectionBoundaryArtifact | null> {
  if (spool === null) return null;
  const artifactPath = join(
    spool.rootPath,
    RECALL_EVAL_SELECTION_BOUNDARY_FILENAME
  );
  const identity = await spool.writeGzipArtifact(artifactPath);
  return {
    sourcePath: artifactPath,
    binding: {
      filename: RECALL_EVAL_SELECTION_BOUNDARY_FILENAME,
      sha256: identity.sha256,
      bytes: identity.bytes,
      record_count: identity.recordCount
    }
  };
}

export async function captureRecallEvalQuestion<T>(
  spool: LongMemEvalSelectionBoundarySpool | null,
  questionId: string,
  run: (
    observer: ((
      boundary: FineAssessmentSelectionBoundaryPendingCapture
    ) => undefined) | undefined
  ) => Promise<T>
): Promise<T> {
  const capture = spool?.beginQuestion(questionId);
  const result = await run(capture?.observer);
  await capture?.commit();
  return result;
}
