import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import {
  isLongMemEvalSnapshotMaterializationResult,
  runLongMemEval
} from "../runner.js";
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
      : { extractionCacheRoot: context.request.extractionCacheRoot })
  });
  if (!isLongMemEvalSnapshotMaterializationResult(result)) {
    throw new DiagnosticLoopFailure({
      phase: "snapshot",
      classification: "infrastructure",
      message: "longmemeval snapshot materialization did not return a snapshot",
      resumeCommand: ""
    });
  }
  return {
    contentIdentity: await sha256File(result.snapshotPath),
    physicalCalls: 0,
    artifactPaths: { snapshot: result.snapshotPath },
    details: { snapshot_identity: await sha256File(result.snapshotPath) }
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

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}
