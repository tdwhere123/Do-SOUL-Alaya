import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs";
import { FSYNC_FILE_OPEN_FLAG } from "../../../fs/open-flags.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import {
  cloneOrCopyFile,
  type CopyFileFn
} from "../../../snapshot/freeze/db-copy.js";
import { removeTempDirectory } from "../../temp-directory-cleanup.js";
import {
  freezePerformanceAttributionReceipt,
  notObserved,
  observedNumber,
  observedVerification,
  type CloneCopyObservation,
  type ObservedFiniteNumber,
  type PerformanceAttributionReceipt
} from "./attribution-receipt.js";
import {
  freezeExactParityReceipt,
  type ExactParityInputIdentity,
  type ExactParityObservedResult,
  type ExactParityReceipt,
  type ProcessExitRecord
} from "./exact-parity.js";

export interface LeakReport {
  readonly liveChildPids: readonly number[];
  readonly remainingTempPaths: readonly string[];
  readonly remainingWalPaths: readonly string[];
  readonly remainingShmPaths: readonly string[];
}

export interface ProviderFreeProofRun {
  readonly receipt: ExactParityReceipt;
  readonly leaks: LeakReport;
  readonly tempRoot: string | null;
}

export interface ProviderFreeProofOptions {
  readonly copyFile?: CopyFileFn;
  readonly clockAMs?: ObservedFiniteNumber;
  readonly childPeakRssBytes?: ObservedFiniteNumber;
}

const CONTROL_IDENTITY: ExactParityInputIdentity = {
  datasetRevision: "p00-provider-free-control",
  questionIds: ["q-control-a", "q-control-b"],
  providerKind: "none",
  providerLabel: "provider-free-fixture",
  cacheKeyAlgo: "none",
  embeddingMode: "none"
};

const SOURCE_BYTES = Buffer.from("p00-sealed-source-v1\n", "utf8");
const OVERLAY_BYTES = Buffer.from("p00-overlay-v1\n", "utf8");
const CHILD_RSS_REASON = "pager/model child RSS was not sampled";
const CLOCK_A_REASON = "provider-free fixture did not execute daemon.recall";
const PHYSICAL_BYTES_REASON = "physical write size was not sampled";

export async function runProviderFreePerformanceProof(
  options: ProviderFreeProofOptions = {}
): Promise<ProviderFreeProofRun> {
  const planned = planProviderFreeRun(options);
  const tempRoot = mkdtempSync(join(tmpdir(), "p00-perf-proof-"));
  try {
    return await finalizeProviderFreeRun(applyProviderFreeRun(planned, tempRoot));
  } catch (error) {
    await removeTempDirectory(tempRoot).catch(() => undefined);
    throw error;
  }
}

export function hasResourceLeak(report: LeakReport): boolean {
  return report.liveChildPids.length > 0 ||
    report.remainingTempPaths.length > 0 ||
    report.remainingWalPaths.length > 0 ||
    report.remainingShmPaths.length > 0;
}

export function scanResourceLeaks(input: {
  readonly liveChildPids: readonly number[];
  readonly tempRoot: string | null;
  readonly walPaths: readonly string[];
  readonly shmPaths: readonly string[];
}): LeakReport {
  return Object.freeze({
    liveChildPids: Object.freeze([...input.liveChildPids]),
    remainingTempPaths: existingPaths(input.tempRoot === null ? [] : [input.tempRoot]),
    remainingWalPaths: existingPaths(input.walPaths),
    remainingShmPaths: existingPaths(input.shmPaths)
  });
}

interface PlannedRun {
  readonly options: ProviderFreeProofOptions;
  readonly identity: ExactParityInputIdentity;
}

interface AppliedRun {
  readonly planned: PlannedRun;
  readonly tempRoot: string;
  readonly walPath: string;
  readonly shmPath: string;
  readonly daemonRestartCount: number;
  readonly clocks: PerformanceAttributionReceipt["clocks"];
  readonly clone: CloneCopyObservation;
  readonly sourceDigestBefore: string;
  readonly sourceDigestAfter: string;
  readonly overlayDigestBefore: string;
  readonly overlayDigestAfter: string;
  readonly archive: ExactParityObservedResult["archiveContents"][number];
  readonly diagnosticsDigest: string;
  readonly deliveryBytes: number;
  readonly captureBytes: number;
  readonly processExits: readonly ProcessExitRecord[];
  readonly liveChildPids: readonly number[];
  readonly parentPeakBytes: ObservedFiniteNumber;
  readonly compactRowCount: number;
  readonly shardPayloadBytes: number;
}

function planProviderFreeRun(options: ProviderFreeProofOptions): PlannedRun {
  return { options, identity: CONTROL_IDENTITY };
}

function applyProviderFreeRun(planned: PlannedRun, tempRoot: string): AppliedRun {
  const startedAt = performance.now();
  const disk = applyWorkspaceDisk(planned, tempRoot);
  const lifecycle = applyStubLifecycle();
  const retained = retainControlArtifacts(planned, tempRoot, disk.targetPath, lifecycle.delivered);
  return {
    planned,
    tempRoot,
    walPath: retained.walPath,
    shmPath: retained.shmPath,
    daemonRestartCount: lifecycle.daemonRestartCount,
    clocks: {
      clockAMs: planned.options.clockAMs ?? notObserved(CLOCK_A_REASON),
      harnessOpenMs: observedNumber(disk.harnessOpenMs),
      harnessRecallMs: observedNumber(lifecycle.harnessRecallMs),
      harnessTotalWallMs: observedNumber(performance.now() - startedAt),
      modelReadinessMs: observedNumber(lifecycle.modelReadinessMs),
      diskPhaseMs: observedNumber(disk.diskPhaseMs)
    },
    clone: disk.clone,
    sourceDigestBefore: disk.sourceDigestBefore,
    sourceDigestAfter: sha256File(disk.sourcePath),
    overlayDigestBefore: disk.overlayDigestBefore,
    overlayDigestAfter: sha256File(disk.overlayPath),
    archive: retained.archive,
    diagnosticsDigest: retained.diagnosticsDigest,
    deliveryBytes: retained.deliveryBytes,
    captureBytes: retained.captureBytes,
    processExits: lifecycle.processExits,
    liveChildPids: lifecycle.liveChildPids,
    parentPeakBytes: observedNumber(process.memoryUsage().rss),
    compactRowCount: retained.compactRowCount,
    shardPayloadBytes: retained.shardPayloadBytes
  };
}

function applyWorkspaceDisk(planned: PlannedRun, tempRoot: string): {
  readonly sourcePath: string;
  readonly overlayPath: string;
  readonly targetPath: string;
  readonly sourceDigestBefore: string;
  readonly overlayDigestBefore: string;
  readonly clone: CloneCopyObservation;
  readonly harnessOpenMs: number;
  readonly diskPhaseMs: number;
} {
  const sourcePath = join(tempRoot, "sealed.db");
  const overlayPath = join(tempRoot, "overlay.bin");
  const targetPath = join(tempRoot, "working", "alaya.db");
  const receiptPath = join(tempRoot, "workspace-receipt.json");
  mkdirSync(join(tempRoot, "working"), { recursive: true });
  mkdirSync(join(tempRoot, "archive"), { recursive: true });
  writeFileSync(sourcePath, SOURCE_BYTES);
  writeFileSync(overlayPath, OVERLAY_BYTES);
  const sourceDigestBefore = sha256(SOURCE_BYTES);
  const overlayDigestBefore = sha256(OVERLAY_BYTES);
  writeFileSync(receiptPath, JSON.stringify({
    sourceSha256: sourceDigestBefore,
    overlaySha256: overlayDigestBefore
  }));
  const openStartedAt = performance.now();
  verifyWorkspaceReceipt(receiptPath, sourceDigestBefore, overlayDigestBefore);
  const diskStartedAt = performance.now();
  const clone = observeCloneOrCopy(
    sourcePath,
    targetPath,
    planned.options.copyFile ?? copyFileSync
  );
  fsyncPath(targetPath);
  const sqlitePath = join(tempRoot, "working", "probe.sqlite");
  writeTinySqlite(sqlitePath);
  reopenTinySqlite(sqlitePath);
  return {
    sourcePath,
    overlayPath,
    targetPath,
    sourceDigestBefore,
    overlayDigestBefore,
    clone,
    harnessOpenMs: performance.now() - openStartedAt,
    diskPhaseMs: performance.now() - diskStartedAt
  };
}

function applyStubLifecycle(): {
  readonly daemonRestartCount: number;
  readonly delivered: readonly string[];
  readonly processExits: readonly ProcessExitRecord[];
  readonly liveChildPids: readonly number[];
  readonly modelReadinessMs: number;
  readonly harnessRecallMs: number;
} {
  const children = new StubChildRegistry();
  const readinessStartedAt = performance.now();
  children.spawn("pager");
  children.markReady(children.spawn("model"));
  const modelReadinessMs = performance.now() - readinessStartedAt;
  const recallStartedAt = performance.now();
  const daemonRestartCount = children.restartDaemon();
  const delivered = executeControlQuestions();
  return {
    daemonRestartCount,
    delivered,
    processExits: children.reapAll(),
    liveChildPids: children.live(),
    modelReadinessMs,
    harnessRecallMs: performance.now() - recallStartedAt
  };
}

function retainControlArtifacts(
  planned: PlannedRun,
  tempRoot: string,
  targetPath: string,
  delivered: readonly string[]
): {
  readonly walPath: string;
  readonly shmPath: string;
  readonly archive: ExactParityObservedResult["archiveContents"][number];
  readonly diagnosticsDigest: string;
  readonly deliveryBytes: number;
  readonly captureBytes: number;
  readonly compactRowCount: number;
  readonly shardPayloadBytes: number;
} {
  const compactRows = [{ id: "row-a" }, { id: "row-b" }, { id: "row-c" }];
  const shardPayload = Buffer.from("p00-shard-payload-v1", "utf8");
  const compactRowCount = compactRows.length;
  const shardPayloadBytes = shardPayload.byteLength;
  compactRows.length = 0;
  const diagnostics = Object.freeze({ questions: planned.identity.questionIds, delivered });
  const diagnosticsDigest = sha256(Buffer.from(JSON.stringify(diagnostics), "utf8"));
  const archiveBytes = Buffer.from(JSON.stringify({ delivered, diagnosticsDigest }), "utf8");
  writeFileSync(join(tempRoot, "archive", "kpi.json"), archiveBytes);
  const walPath = `${targetPath}-wal`;
  const shmPath = `${targetPath}-shm`;
  writeFileSync(walPath, "wal");
  writeFileSync(shmPath, "shm");
  return {
    walPath,
    shmPath,
    archive: {
      path: "kpi.json",
      sha256: sha256(archiveBytes),
      bytes: archiveBytes.byteLength
    },
    diagnosticsDigest,
    deliveryBytes: Buffer.byteLength(JSON.stringify(delivered), "utf8"),
    captureBytes: Buffer.byteLength(JSON.stringify(diagnostics), "utf8"),
    compactRowCount,
    shardPayloadBytes
  };
}

async function finalizeProviderFreeRun(applied: AppliedRun): Promise<ProviderFreeProofRun> {
  const attribution = freezePerformanceAttributionReceipt({
    clocks: applied.clocks,
    pager: {
      childSpawnCount: observedNumber(1),
      modelChildSpawnCount: observedNumber(1),
      modelReadinessCount: observedNumber(1)
    },
    workspace: {
      receiptVerificationCount: observedNumber(1),
      receiptVerification: observedVerification("pass")
    },
    disk: {
      clone: applied.clone,
      fsyncCount: observedNumber(1),
      sqliteReopenCount: observedNumber(1),
      daemonRestartCount: observedNumber(applied.daemonRestartCount),
      questionExecutionCount: observedNumber(applied.planned.identity.questionIds.length)
    },
    rss: {
      parentPeakBytes: applied.parentPeakBytes,
      childPeakBytes: applied.planned.options.childPeakRssBytes ?? notObserved(CHILD_RSS_REASON),
      aggregatePeakBytes: notObserved(CHILD_RSS_REASON)
    },
    retained: {
      compactRowCount: observedNumber(applied.compactRowCount),
      shardPayloadBytes: observedNumber(applied.shardPayloadBytes)
    }
  });
  const receipt = freezeExactParityReceipt({
    identity: applied.planned.identity,
    result: freezeControlResult(applied),
    attribution
  });
  await removeTempDirectory(applied.tempRoot);
  const leaks = scanResourceLeaks({
    liveChildPids: applied.liveChildPids,
    tempRoot: existsSync(applied.tempRoot) ? applied.tempRoot : null,
    walPaths: [applied.walPath],
    shmPaths: [applied.shmPath]
  });
  return {
    receipt,
    leaks,
    tempRoot: existsSync(applied.tempRoot) ? applied.tempRoot : null
  };
}

function freezeControlResult(applied: AppliedRun): ExactParityObservedResult {
  return {
    deliveredObjectIds: ["mem-a", "mem-b"],
    deliveryBytes: applied.deliveryBytes,
    captureBytes: applied.captureBytes,
    diagnosticsDigest: applied.diagnosticsDigest,
    providerCalls: [],
    cacheCalls: [],
    sourceDigestBefore: applied.sourceDigestBefore,
    sourceDigestAfter: applied.sourceDigestAfter,
    overlayDigestBefore: applied.overlayDigestBefore,
    overlayDigestAfter: applied.overlayDigestAfter,
    processExits: applied.processExits,
    archiveContents: [applied.archive]
  };
}

function observeCloneOrCopy(
  sourcePath: string,
  targetPath: string,
  copyFile: CopyFileFn
): Extract<CloneCopyObservation, { status: "observed" }> {
  let mode: "reflink" | "copy_fallback" | undefined;
  cloneOrCopyFile(sourcePath, targetPath, (from, to, flags) => {
    copyFile(from, to, flags);
    mode = flags === constants.COPYFILE_FICLONE_FORCE ? "reflink" : "copy_fallback";
  });
  if (mode === undefined) {
    throw new Error("clone-or-copy completed without an observed copy mode");
  }
  return Object.freeze({
    status: "observed",
    mode,
    logicalBytes: statSync(targetPath).size,
    physicalBytesWritten: notObserved(PHYSICAL_BYTES_REASON)
  });
}

function verifyWorkspaceReceipt(
  receiptPath: string,
  sourceSha256: string,
  overlaySha256: string
): void {
  const parsed = JSON.parse(readFileSync(receiptPath, "utf8")) as {
    readonly sourceSha256?: unknown;
    readonly overlaySha256?: unknown;
  };
  if (parsed.sourceSha256 !== sourceSha256 || parsed.overlaySha256 !== overlaySha256) {
    throw new Error("workspace receipt verification failed");
  }
}

function fsyncPath(path: string): void {
  const fd = openSync(path, FSYNC_FILE_OPEN_FLAG);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeTinySqlite(path: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA journal_mode = DELETE;");
    db.exec("CREATE TABLE p00_probe (id INTEGER PRIMARY KEY);");
    db.exec("INSERT INTO p00_probe (id) VALUES (1);");
  } finally {
    db.close();
  }
}

function reopenTinySqlite(path: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA journal_mode = DELETE;");
    db.exec("PRAGMA user_version = 1;");
  } finally {
    db.close();
  }
}

function executeControlQuestions(): readonly string[] {
  return Object.freeze(["mem-a", "mem-b"]);
}

class StubChildRegistry {
  private nextPid = 9000;
  private readonly livePids = new Set<number>();
  private readonly exits: ProcessExitRecord[] = [];
  private daemonRestarts = 0;

  spawn(_kind: "pager" | "model"): number {
    const pid = this.nextPid;
    this.nextPid += 1;
    this.livePids.add(pid);
    return pid;
  }

  markReady(pid: number): void {
    if (!this.livePids.has(pid)) {
      throw new Error(`cannot mark unreadied child ${pid} ready`);
    }
  }

  restartDaemon(): number {
    this.daemonRestarts += 1;
    return this.daemonRestarts;
  }

  reapAll(): readonly ProcessExitRecord[] {
    for (const pid of this.livePids) {
      this.exits.push(Object.freeze({ pid, code: 0, signal: null }));
    }
    this.livePids.clear();
    return Object.freeze([...this.exits]);
  }

  live(): readonly number[] {
    return Object.freeze([...this.livePids]);
  }
}

function existingPaths(paths: readonly string[]): readonly string[] {
  return Object.freeze(paths.filter((path) => existsSync(path)));
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256File(path: string): string {
  return sha256(readFileSync(path));
}
