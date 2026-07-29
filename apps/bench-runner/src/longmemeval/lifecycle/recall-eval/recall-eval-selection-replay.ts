import { join } from "node:path";
import type { FineAssessmentSelectionBoundaryCase } from
  "@do-soul/alaya-core";
import {
  createLongMemEvalSelectionBoundarySpool,
  type LongMemEvalSelectionBoundarySpool
} from "../../selection-replay/selection-boundary-spool.js";

export const RECALL_EVAL_SELECTION_BOUNDARY_FILENAME =
  "selection-boundaries.ndjson.gz";

export function createRecallEvalSelectionBoundarySpool(
  env: Readonly<Record<string, string | undefined>>
): Promise<LongMemEvalSelectionBoundarySpool | null> {
  return createLongMemEvalSelectionBoundarySpool({ env, concurrency: 1 });
}

export async function finalizeRecallEvalSelectionBoundarySpool(
  spool: LongMemEvalSelectionBoundarySpool | null
): Promise<string | null> {
  if (spool === null) return null;
  const artifactPath = join(
    spool.rootPath,
    RECALL_EVAL_SELECTION_BOUNDARY_FILENAME
  );
  await spool.writeGzipArtifact(artifactPath);
  return artifactPath;
}

export async function captureRecallEvalQuestion<T>(
  spool: LongMemEvalSelectionBoundarySpool | null,
  questionId: string,
  run: (
    observer: ((
      boundary: FineAssessmentSelectionBoundaryCase
    ) => undefined) | undefined
  ) => Promise<T>
): Promise<T> {
  const capture = spool?.beginQuestion(questionId);
  const result = await run(capture?.observer);
  await capture?.commit();
  return result;
}
