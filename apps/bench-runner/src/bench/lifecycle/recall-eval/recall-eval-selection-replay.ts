import { basename, dirname, join, relative, resolve } from "node:path";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { computeLongMemEvalQuestionIdDigest } from "@do-soul/alaya-eval";
import type { FineAssessmentSelectionBoundaryPendingCapture } from
  "@do-soul/alaya-core";
import {
  appendLongMemEvalSelectionBoundaryArtifact,
  createLongMemEvalSelectionBoundarySpool,
  verifyLongMemEvalSelectionBoundaryArtifact,
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
  readonly rootPath: string;
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
    rootPath: spool.rootPath,
    sourcePath: artifactPath,
    binding: {
      filename: RECALL_EVAL_SELECTION_BOUNDARY_FILENAME,
      sha256: identity.sha256,
      bytes: identity.bytes,
      record_count: identity.recordCount
    }
  };
}

export async function assembleRecallEvalSelectionBoundaryArtifacts(input: {
  readonly artifacts: readonly RecallEvalSelectionBoundaryArtifact[];
  readonly expectedQuestionIds: readonly string[];
}): Promise<RecallEvalSelectionBoundaryArtifact | null> {
  if (input.artifacts.length === 0 && input.expectedQuestionIds.length === 0) {
    return null;
  }
  const keepAliveWindow = input.artifacts.length === 1 &&
    input.expectedQuestionIds.length > 1;
  if (!keepAliveWindow &&
      input.artifacts.length !== input.expectedQuestionIds.length) {
    throw new Error("selection replay child artifact count differs from evaluated window");
  }
  if (keepAliveWindow) {
    const artifact = input.artifacts[0];
    if (artifact === undefined) {
      throw new Error("selection replay assembly lost an evaluated question");
    }
    return adoptKeepAliveSelectionArtifact(artifact, input.expectedQuestionIds);
  }
  const spool = await createLongMemEvalSelectionBoundarySpool({
    env: { ALAYA_BENCH_SELECTION_REPLAY: "1" },
    concurrency: 1
  });
  if (spool === null) throw new Error("selection replay assembly spool is unavailable");
  try {
    for (let index = 0; index < input.artifacts.length; index += 1) {
      const artifact = input.artifacts[index];
      const questionId = input.expectedQuestionIds[index];
      if (artifact === undefined || questionId === undefined) {
        throw new Error("selection replay assembly lost an evaluated question");
      }
      await appendLongMemEvalSelectionBoundaryArtifact(
        spool, artifact.sourcePath, questionId
      );
    }
    const assembled = await finalizeRecallEvalSelectionBoundarySpool(spool);
    if (assembled === null) throw new Error("selection replay assembly produced no artifact");
    const verified = await verifyLongMemEvalSelectionBoundaryArtifact(
      assembled.sourcePath
    );
    const expectedDigest = computeLongMemEvalQuestionIdDigest(
      input.expectedQuestionIds
    );
    if (verified.questionCount !== input.expectedQuestionIds.length ||
        verified.questionIdDigest !== expectedDigest) {
      await assembledArtifactCleanup(assembled);
      throw new Error("selection replay run artifact differs from evaluated window");
    }
    return assembled;
  } catch (error) {
    await spool.dispose();
    throw error;
  }
}

// Keep-alive pager emits one child artifact for the evaluated window.
async function adoptKeepAliveSelectionArtifact(
  artifact: RecallEvalSelectionBoundaryArtifact,
  expectedQuestionIds: readonly string[]
): Promise<RecallEvalSelectionBoundaryArtifact> {
  const verified = await verifyLongMemEvalSelectionBoundaryArtifact(
    artifact.sourcePath
  );
  const expectedDigest = computeLongMemEvalQuestionIdDigest(expectedQuestionIds);
  if (verified.questionCount !== expectedQuestionIds.length ||
      verified.questionIdDigest !== expectedDigest) {
    throw new Error("selection replay run artifact differs from evaluated window");
  }
  const rootPath = await mkdtemp(join(tmpdir(), "alaya-selection-replay-"));
  const sourcePath = join(rootPath, RECALL_EVAL_SELECTION_BOUNDARY_FILENAME);
  try {
    await copyFile(artifact.sourcePath, sourcePath);
    return { rootPath, sourcePath, binding: artifact.binding };
  } catch (error) {
    await rm(rootPath, { recursive: true, force: true });
    throw error;
  }
}

export async function disposeRecallEvalSelectionBoundaryArtifact(
  artifact: RecallEvalSelectionBoundaryArtifact | null
): Promise<void> {
  if (artifact === null) return;
  await assembledArtifactCleanup(artifact);
}

export async function disposeRecallEvalSelectionBoundaryRoot(
  rootPath: string
): Promise<void> {
  const resolvedRoot = resolve(rootPath);
  const relativeToTemp = relative(resolve(tmpdir()), resolvedRoot);
  if (relativeToTemp.startsWith("..") || relativeToTemp.length === 0 ||
      !basename(resolvedRoot).startsWith("alaya-selection-replay-")) {
    throw new Error("selection replay root is outside owned temporary storage");
  }
  await rm(resolvedRoot, { recursive: true, force: true });
}

async function assembledArtifactCleanup(
  artifact: RecallEvalSelectionBoundaryArtifact
): Promise<void> {
  const rootPath = resolve(artifact.rootPath);
  if (resolve(dirname(artifact.sourcePath)) !== rootPath ||
      basename(artifact.sourcePath) !== RECALL_EVAL_SELECTION_BOUNDARY_FILENAME) {
    throw new Error("selection replay artifact root is outside owned temporary storage");
  }
  await disposeRecallEvalSelectionBoundaryRoot(rootPath);
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
