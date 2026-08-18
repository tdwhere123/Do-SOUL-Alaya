import { existsSync } from "node:fs";
import { sha256File } from "../snapshot/integrity.js";
import {
  isLongMemEvalSnapshotMaterializationResult,
  runLongMemEval
} from "../../longmemeval/runner.js";
import { DiagnosticLoopFailure } from "./failures.js";
import type {
  DiagnosticLoopPhaseContext,
  DiagnosticLoopPhaseResult
} from "./types.js";

export async function runProductionSnapshotPhase(
  context: DiagnosticLoopPhaseContext
): Promise<DiagnosticLoopPhaseResult> {
  if (context.request.snapshotPath !== undefined) {
    return reuseSnapshot(context.request.snapshotPath);
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
  const digest = await sha256File(result.snapshotPath);
  return {
    contentIdentity: digest,
    physicalCalls: 0,
    artifactPaths: { snapshot: result.snapshotPath },
    details: { snapshot_identity: digest }
  };
}

async function reuseSnapshot(snapshotPath: string): Promise<DiagnosticLoopPhaseResult> {
  if (!existsSync(snapshotPath)) {
    throw new DiagnosticLoopFailure({
      phase: "snapshot",
      classification: "infrastructure",
      message: `snapshot does not exist: ${snapshotPath}`,
      resumeCommand: ""
    });
  }
  const digest = await sha256File(snapshotPath);
  return {
    contentIdentity: digest,
    physicalCalls: 0,
    artifactPaths: { snapshot: snapshotPath },
    details: { snapshot_identity: digest }
  };
}
