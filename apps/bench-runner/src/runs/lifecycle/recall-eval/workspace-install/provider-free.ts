import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  scanResourceLeaks,
  type LeakReport
} from "../performance-proof/provider-free-run.js";
import { removeTempDirectory } from "../../temp-directory-cleanup.js";
import { observedNumber } from "../performance-proof/attribution-receipt.js";
import {
  freezeWorkspaceInstallIoReceipt,
  observedPhase,
  type WorkspaceInstallIoReceipt,
  type WorkspaceInstallOptimizationDecision,
  type WorkspaceInstallPhaseTiming
} from "./phases.js";
import {
  applyMeasuredWorkspaceInstall,
  CLONE_REUSE_PROVED,
  decideWorkspaceInstallOptimization,
  forceCopyFallbackCopyFile,
  forceReflinkCopyFile,
  type AppliedWorkspaceInstall,
  type WorkspaceInstallHooks
} from "./install.js";

const SOURCE_BYTES = Buffer.from("p00-sealed-source-v1\n", "utf8");
const OVERLAY_BYTES = Buffer.from("p00-overlay-v1\n", "utf8");

export interface ProviderFreeWorkspaceInstallOptions extends WorkspaceInstallHooks {
  readonly workerId?: string;
  readonly questionId?: string;
  readonly clockAMs?: AppliedWorkspaceInstall["clockAMs"];
  readonly finalize?: boolean;
}

export interface PlantedFixture {
  readonly sourcePath: string;
  readonly overlayPath: string;
  readonly receiptPath: string;
  readonly sourceDigest: string;
  readonly overlayDigest: string;
  readonly sourceIno: number;
}

export interface WorkspaceInstallProofRun {
  readonly io: WorkspaceInstallIoReceipt;
  readonly leaks: LeakReport;
  readonly tempRoot: string | null;
  readonly sourcePath: string;
  readonly overlayPath: string;
  readonly targetPath: string;
  readonly walPath: string;
  readonly shmPath: string;
  readonly sqlitePath: string;
  readonly sourceDigestBefore: string;
  readonly sourceDigestAfter: string;
  readonly overlayDigestBefore: string;
  readonly overlayDigestAfter: string;
  readonly sourceIno: number;
  readonly targetIno: number;
}

export async function measureProviderFreeWorkspaceInstallBothModes(): Promise<{
  readonly reflink: WorkspaceInstallProofRun;
  readonly copyFallback: WorkspaceInstallProofRun;
  readonly decision: WorkspaceInstallOptimizationDecision;
}> {
  const reflink = await runProviderFreeWorkspaceInstall({
    copyFile: forceReflinkCopyFile(),
    workerId: "worker-reflink",
    questionId: "q-control-a"
  });
  const copyFallback = await runProviderFreeWorkspaceInstall({
    copyFile: forceCopyFallbackCopyFile(),
    workerId: "worker-copy",
    questionId: "q-control-a"
  });
  return {
    reflink,
    copyFallback,
    decision: decideWorkspaceInstallOptimization({
      reflink: reflink.io,
      copyFallback: copyFallback.io,
      cloneReuseProved: CLONE_REUSE_PROVED
    })
  };
}

export async function runProviderFreeWorkspaceInstall(
  options: ProviderFreeWorkspaceInstallOptions = {}
): Promise<WorkspaceInstallProofRun> {
  const tempRoot = mkdtempSync(join(tmpdir(), "p02-workspace-install-"));
  try {
    const planted = plantProviderFreeWorkspaceFixture(tempRoot);
    const applied = applyMeasuredWorkspaceInstall({
      workerId: options.workerId ?? "worker-a",
      questionId: options.questionId ?? "q-control-a",
      sourcePath: planted.sourcePath,
      overlayPath: planted.overlayPath,
      receiptPath: planted.receiptPath,
      targetDir: join(tempRoot, "working"),
      copyFile: options.copyFile,
      fsync: options.fsync,
      reopenSqlite: options.reopenSqlite,
      reloadDaemon: options.reloadDaemon,
      clockAMs: options.clockAMs
    });
    if (options.finalize === false) {
      return proofFromApplied(
        applied,
        tempRoot,
        planted,
        null,
        sha256File(planted.sourcePath),
        sha256File(planted.overlayPath)
      );
    }
    return await finalizeMeasuredWorkspaceInstall(applied, tempRoot, planted);
  } catch (error) {
    await removeTempDirectory(tempRoot).catch(() => undefined);
    throw error;
  }
}

export function plantProviderFreeWorkspaceFixture(root: string): PlantedFixture {
  const sourcePath = join(root, "sealed.db");
  const overlayPath = join(root, "overlay.bin");
  const receiptPath = join(root, "workspace-receipt.json");
  mkdirSync(join(root, "working"), { recursive: true });
  writeFileSync(sourcePath, SOURCE_BYTES);
  writeFileSync(overlayPath, OVERLAY_BYTES);
  const sourceDigest = sha256(SOURCE_BYTES);
  const overlayDigest = sha256(OVERLAY_BYTES);
  writeFileSync(receiptPath, JSON.stringify({
    sourceSha256: sourceDigest,
    overlaySha256: overlayDigest
  }));
  return {
    sourcePath,
    overlayPath,
    receiptPath,
    sourceDigest,
    overlayDigest,
    sourceIno: lstatSync(sourcePath).ino
  };
}

export async function finalizeMeasuredWorkspaceInstall(
  applied: AppliedWorkspaceInstall,
  tempRoot: string,
  planted: PlantedFixture
): Promise<WorkspaceInstallProofRun> {
  const sourceDigestAfter = sha256File(planted.sourcePath);
  const overlayDigestAfter = sha256File(planted.overlayPath);
  const startedAt = performance.now();
  await removeTempDirectory(tempRoot);
  const io = freezeWorkspaceInstallIoReceipt({
    workerId: applied.workerId,
    questionId: applied.questionId,
    clockAMs: applied.clockAMs,
    diskPhaseMs: observedNumber(applied.diskPhaseMs),
    clone: applied.clone,
    phases: withCleanup(applied.phases, performance.now() - startedAt, 1)
  });
  return proofFromApplied(
    applied,
    tempRoot,
    planted,
    io,
    sourceDigestAfter,
    overlayDigestAfter
  );
}

function proofFromApplied(
  applied: AppliedWorkspaceInstall,
  tempRoot: string,
  planted: PlantedFixture,
  io: WorkspaceInstallIoReceipt | null,
  sourceDigestAfter?: string,
  overlayDigestAfter?: string
): WorkspaceInstallProofRun {
  const remaining = existsSync(tempRoot) ? tempRoot : null;
  const leaks = scanResourceLeaks({
    liveChildPids: [],
    tempRoot: remaining,
    walPaths: [applied.walPath],
    shmPaths: [applied.shmPath]
  });
  const hashedAfterSource = sourceDigestAfter ??
    (remaining === null ? undefined : sha256File(planted.sourcePath));
  const hashedAfterOverlay = overlayDigestAfter ??
    (remaining === null ? undefined : sha256File(planted.overlayPath));
  if (hashedAfterSource === undefined || hashedAfterOverlay === undefined) {
    throw new Error("workspace install after-digests must be captured before teardown");
  }
  return {
    io: io ?? freezeWorkspaceInstallIoReceipt({
      workerId: applied.workerId,
      questionId: applied.questionId,
      clockAMs: applied.clockAMs,
      diskPhaseMs: observedNumber(applied.diskPhaseMs),
      clone: applied.clone,
      phases: applied.phases
    }),
    leaks,
    tempRoot: remaining,
    sourcePath: planted.sourcePath,
    overlayPath: planted.overlayPath,
    targetPath: applied.targetPath,
    walPath: applied.walPath,
    shmPath: applied.shmPath,
    sqlitePath: applied.sqlitePath,
    sourceDigestBefore: applied.sourceDigestBefore,
    sourceDigestAfter: hashedAfterSource,
    overlayDigestBefore: applied.overlayDigestBefore,
    overlayDigestAfter: hashedAfterOverlay,
    sourceIno: applied.sourceIno,
    targetIno: applied.targetIno
  };
}

function withCleanup(
  phases: readonly WorkspaceInstallPhaseTiming[],
  durationMs: number,
  count: number
): readonly WorkspaceInstallPhaseTiming[] {
  return Object.freeze(phases.map((phase) =>
    phase.name === "cleanup" ? observedPhase("cleanup", durationMs, count) : phase
  ));
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256File(path: string): string {
  return sha256(readFileSync(path));
}
