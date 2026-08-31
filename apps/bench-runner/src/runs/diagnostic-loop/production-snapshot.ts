import { existsSync } from "node:fs";
import {
  isLongMemEvalSnapshotMaterializationResult,
  runLongMemEval
} from "../../datasets/longmemeval/runner.js";
import { DiagnosticLoopFailure } from "./failures.js";
import type {
  DiagnosticLoopPhaseContext,
  DiagnosticLoopPhaseResult
} from "./types.js";
import { resolveSnapshotIdentity } from "./authority/identity.js";
import { maybeEmitSnapshotEmbeddingOverlay } from
  "../snapshot/recall-eval/embedding-cache-overlay/ensure.js";

export async function runProductionSnapshotPhase(
  context: DiagnosticLoopPhaseContext
): Promise<DiagnosticLoopPhaseResult> {
  if (context.request.snapshotPath !== undefined) {
    return reuseSnapshot(
      context.request.snapshotPath,
      context.request.variant,
      context.request.embeddingCacheOverlayReceiptPath
    );
  }
  if (context.request.snapshotOutPath === undefined) {
    throw new DiagnosticLoopFailure({
      phase: "snapshot",
      classification: "infrastructure",
      message: "snapshot phase requires --snapshot or --snapshot-out",
      resumeCommand: ""
    });
  }
  if (context.request.historyRoot === undefined) {
    throw new DiagnosticLoopFailure({
      phase: "snapshot",
      classification: "infrastructure",
      message: "snapshot materialization requires --history-root",
      resumeCommand: ""
    });
  }
  const result = await runLongMemEval({
    variant: context.request.variant,
    snapshotOut: context.request.snapshotOutPath,
    historyRoot: context.request.historyRoot,
    ...(context.request.limit === undefined ? {} : { limit: context.request.limit }),
    ...(context.request.offset === undefined ? {} : { offset: context.request.offset }),
    ...(context.request.dataDir === undefined ? {} : { dataDir: context.request.dataDir }),
    ...(context.request.extractionCacheRoot === undefined
      ? {}
      : { extractionCacheRoot: context.request.extractionCacheRoot }),
    snapshotWriteAuthority: "diagnostic"
  });
  if (!isLongMemEvalSnapshotMaterializationResult(result)) {
    throw new DiagnosticLoopFailure({
      phase: "snapshot",
      classification: "infrastructure",
      message: "longmemeval snapshot materialization did not return a snapshot",
      resumeCommand: ""
    });
  }
  const identity = await resolveSnapshotIdentity(result.snapshotPath, context.request.variant);
  await maybeEmitSnapshotEmbeddingOverlay({
    snapshotDbPath: result.snapshotPath,
    ...(context.request.embeddingCacheOverlayReceiptPath === undefined
      ? {}
      : { receiptPathOverride: context.request.embeddingCacheOverlayReceiptPath })
  });
  return {
    contentIdentity: identity.identity_digest,
    physicalCalls: 0,
    artifactPaths: { snapshot: result.snapshotPath },
    details: { ...identity }
  };
}

async function reuseSnapshot(
  snapshotPath: string,
  variant: DiagnosticLoopPhaseContext["request"]["variant"],
  overlayReceiptPath?: string
): Promise<DiagnosticLoopPhaseResult> {
  if (!existsSync(snapshotPath)) {
    throw new DiagnosticLoopFailure({
      phase: "snapshot",
      classification: "infrastructure",
      message: `snapshot does not exist: ${snapshotPath}`,
      resumeCommand: ""
    });
  }
  const identity = await resolveSnapshotIdentity(snapshotPath, variant);
  await maybeEmitSnapshotEmbeddingOverlay({
    snapshotDbPath: snapshotPath,
    ...(overlayReceiptPath === undefined ? {} : { receiptPathOverride: overlayReceiptPath })
  });
  return {
    contentIdentity: identity.identity_digest,
    physicalCalls: 0,
    artifactPaths: { snapshot: snapshotPath },
    details: { ...identity },
    avoidedWork: { snapshotsReused: 1 }
  };
}
