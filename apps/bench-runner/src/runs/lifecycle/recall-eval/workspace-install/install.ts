import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { FSYNC_FILE_OPEN_FLAG } from "../../../fs/open-flags.js";
import {
  hashRegularFileNoFollow,
  withRegularFileNoFollow
} from "../../../snapshot/bound-file.js";
import {
  cloneOrCopyFile,
  type CopyFileFn
} from "../../../snapshot/freeze/db-copy.js";
import {
  notObserved,
  type CloneCopyObservation,
  type ObservedFiniteNumber
} from "../performance-proof/attribution-receipt.js";
import {
  observedPhase,
  notObservedPhase,
  type WorkspaceInstallPhaseTiming
} from "./phases.js";

export {
  P02_WORKSPACE_INSTALL_CONTRACT,
  WORKSPACE_INSTALL_PHASES,
  decideWorkspaceInstallOptimization,
  phaseByName,
  selectDominantPhase,
  type WorkspaceInstallIoReceipt,
  type WorkspaceInstallOptimizationDecision,
  type WorkspaceInstallPhaseName,
  type WorkspaceInstallPhaseTiming
} from "./phases.js";

export const CLOCK_A_REASON = "workspace install does not execute daemon.recall";
export const PHYSICAL_BYTES_REASON = "physical write size was not sampled";
// SQLite/WAL reset is not independently proved in this write set.
export const CLONE_REUSE_PROVED = false;

export type WorkspaceInstallFailClosedReason =
  | "stale-receipt"
  | "source-drift"
  | "partial-copy"
  | "inode-replacement"
  | "fsync-failure"
  | "reopen-failure"
  | "reload-failure"
  | "shared-mutable"
  | "symlink-source";

export class WorkspaceInstallFailClosedError extends Error {
  public readonly reason: WorkspaceInstallFailClosedReason;

  public constructor(reason: WorkspaceInstallFailClosedReason, message?: string) {
    super(message ?? `workspace install fail-closed (${reason})`);
    this.name = "WorkspaceInstallFailClosedError";
    this.reason = reason;
  }
}

export interface WorkspaceInstallHooks {
  readonly copyFile?: CopyFileFn;
  readonly fsync?: (path: string) => void;
  readonly reopenSqlite?: (path: string) => void;
  readonly reloadDaemon?: (dataDir: string) => void;
}

export interface WorkspaceInstallInput extends WorkspaceInstallHooks {
  readonly workerId: string;
  readonly questionId: string;
  readonly sourcePath: string;
  readonly overlayPath: string;
  readonly receiptPath: string;
  readonly targetDir: string;
  readonly clockAMs?: ObservedFiniteNumber;
}

export interface AppliedWorkspaceInstall {
  readonly workerId: string;
  readonly questionId: string;
  readonly sourcePath: string;
  readonly overlayPath: string;
  readonly targetPath: string;
  readonly walPath: string;
  readonly shmPath: string;
  readonly sqlitePath: string;
  readonly clockAMs: ObservedFiniteNumber;
  readonly diskPhaseMs: number;
  readonly clone: CloneCopyObservation;
  readonly phases: readonly WorkspaceInstallPhaseTiming[];
  readonly sourceDigestBefore: string;
  readonly overlayDigestBefore: string;
  readonly sourceIno: number;
  readonly targetIno: number;
}

export function workspaceInstallTargetPath(
  targetDir: string,
  workerId: string,
  questionId: string
): string {
  return join(targetDir, workerId, questionId, "alaya.db");
}

export function forceReflinkCopyFile(inner: CopyFileFn = copyFileSync): CopyFileFn {
  return (source, dest, mode) => {
    inner(source, dest, mode);
  };
}

export function forceCopyFallbackCopyFile(inner: CopyFileFn = copyFileSync): CopyFileFn {
  return (source, dest, mode) => {
    if (mode === constants.COPYFILE_FICLONE_FORCE) {
      const error = new Error("clone unsupported") as NodeJS.ErrnoException;
      error.code = "ENOTSUP";
      throw error;
    }
    inner(source, dest, mode);
  };
}

export function applyMeasuredWorkspaceInstall(
  input: WorkspaceInstallInput
): AppliedWorkspaceInstall {
  const planned = planInstall(input);
  const tmpPath = `${planned.targetPath}.${randomUUID()}.tmp`;
  try {
    assertPrivateTarget(planned.targetPath);
    const receipt = applyReceiptRead(planned);
    const clone = applyCloneCopy(planned, tmpPath, receipt.sourceSha256);
    applyFsync(planned, tmpPath);
    assertSealedSourceUnchanged(planned, receipt);
    renameSync(tmpPath, planned.targetPath);
    applySqliteReopen(planned);
    applyDaemonReload(planned);
    writePrivateSidecars(planned);
    return finishApply(planned, receipt, clone);
  } catch (error) {
    discardPrivateState(planned, tmpPath);
    throw classifyFailClosed(error);
  }
}

interface PlannedInstall extends WorkspaceInstallInput {
  readonly targetPath: string;
  readonly sqlitePath: string;
  readonly walPath: string;
  readonly shmPath: string;
  readonly copyFile: CopyFileFn;
  readonly fsync: (path: string) => void;
  readonly reopenSqlite: (path: string) => void;
  readonly reloadDaemon: (dataDir: string) => void;
  readonly timings: PhaseTimings;
}

interface PhaseTimings {
  receiptReadMs: number;
  cloneMs: number;
  fsyncMs: number;
  reopenMs: number;
  reloadMs: number;
  receiptReadCount: number;
  cloneCount: number;
  fsyncCount: number;
  reopenCount: number;
  reloadCount: number;
}

interface ReceiptContents {
  readonly sourceSha256: string;
  readonly overlaySha256: string;
}

function planInstall(input: WorkspaceInstallInput): PlannedInstall {
  const targetPath = workspaceInstallTargetPath(
    input.targetDir, input.workerId, input.questionId
  );
  return {
    ...input,
    targetPath,
    sqlitePath: join(dirname(targetPath), "probe.sqlite"),
    walPath: `${targetPath}-wal`,
    shmPath: `${targetPath}-shm`,
    copyFile: input.copyFile ?? copyFileSync,
    fsync: input.fsync ?? fsyncPath,
    reopenSqlite: input.reopenSqlite ?? reopenTinySqlite,
    reloadDaemon: input.reloadDaemon ?? noopReload,
    timings: emptyTimings()
  };
}

function applyReceiptRead(planned: PlannedInstall): ReceiptContents {
  const timed = timeCall(() => {
    const receipt = readWorkspaceReceipt(planned.receiptPath);
    const sourceSha256 = hashRegularFileNoFollow(planned.sourcePath);
    const overlaySha256 = hashRegularFileNoFollow(planned.overlayPath);
    if (receipt.sourceSha256 !== sourceSha256 || receipt.overlaySha256 !== overlaySha256) {
      throw failClosed("stale-receipt", "workspace receipt verification failed");
    }
    return { sourceSha256, overlaySha256 };
  });
  planned.timings.receiptReadMs = timed.durationMs;
  planned.timings.receiptReadCount = 1;
  return timed.value;
}

function applyCloneCopy(
  planned: PlannedInstall,
  tmpPath: string,
  expectedSha256: string
): Extract<CloneCopyObservation, { status: "observed" }> {
  mkdirSync(dirname(tmpPath), { recursive: true });
  const sourceBefore = sourceIdentity(planned.sourcePath);
  let mode: "reflink" | "copy_fallback" | undefined;
  const timed = timeCall(() => {
    try {
      copyOpenedSource(planned, tmpPath, (next) => {
        mode = next;
      });
    } catch (error) {
      throwIfSourceInodeReplaced(planned.sourcePath, sourceBefore, error);
      throw error;
    }
  });
  assertCloneSourceStable(planned, sourceBefore, expectedSha256);
  if (mode === undefined) {
    throw new Error("clone-or-copy completed without an observed copy mode");
  }
  planned.timings.cloneMs = timed.durationMs;
  planned.timings.cloneCount = 1;
  return Object.freeze({
    status: "observed",
    mode,
    logicalBytes: statSync(tmpPath).size,
    physicalBytesWritten: notObserved(PHYSICAL_BYTES_REASON)
  });
}

function copyOpenedSource(
  planned: PlannedInstall,
  tmpPath: string,
  observeMode: (mode: "reflink" | "copy_fallback") => void
): void {
  withRegularFileNoFollow(planned.sourcePath, (openedPath) => {
    cloneOrCopyFile(openedPath, tmpPath, (from, to, flags) => {
      planned.copyFile(from, to, flags);
      observeMode(flags === constants.COPYFILE_FICLONE_FORCE ? "reflink" : "copy_fallback");
    });
  });
}

function assertCloneSourceStable(
  planned: PlannedInstall,
  sourceBefore: SourceIdentity,
  expectedSha256: string
): void {
  throwIfSourceInodeReplaced(planned.sourcePath, sourceBefore, undefined);
  if (hashRegularFileNoFollow(planned.sourcePath) !== expectedSha256) {
    throw failClosed("source-drift", "sealed source digest drifted during clone");
  }
}

interface SourceIdentity {
  readonly ino: number;
  readonly dev: number;
}

function sourceIdentity(path: string): SourceIdentity {
  const stats = lstatSync(path);
  return { ino: stats.ino, dev: stats.dev };
}

function throwIfSourceInodeReplaced(
  sourcePath: string,
  sourceBefore: SourceIdentity,
  cause: unknown
): void {
  if (!existsSync(sourcePath)) {
    throw failClosed("inode-replacement", "sealed source path vanished during clone");
  }
  const sourceAfter = sourceIdentity(sourcePath);
  if (sourceAfter.ino === sourceBefore.ino && sourceAfter.dev === sourceBefore.dev) {
    if (cause !== undefined) throw cause;
    return;
  }
  throw failClosed("inode-replacement", "sealed source inode was replaced during clone");
}

function applyFsync(planned: PlannedInstall, tmpPath: string): void {
  const timed = timeCall(() => runHook("fsync-failure", () => planned.fsync(tmpPath)));
  planned.timings.fsyncMs = timed.durationMs;
  planned.timings.fsyncCount = 1;
}

function applySqliteReopen(planned: PlannedInstall): void {
  const timed = timeCall(() => runHook("reopen-failure", () => {
    writeTinySqlite(planned.sqlitePath);
    planned.reopenSqlite(planned.sqlitePath);
  }));
  planned.timings.reopenMs = timed.durationMs;
  planned.timings.reopenCount = 1;
}

function applyDaemonReload(planned: PlannedInstall): void {
  const timed = timeCall(() => {
    runHook("reload-failure", () => planned.reloadDaemon(dirname(planned.targetPath)));
  });
  planned.timings.reloadMs = timed.durationMs;
  planned.timings.reloadCount = 1;
}

function runHook(reason: WorkspaceInstallFailClosedReason, hook: () => void): void {
  try {
    hook();
  } catch (error) {
    if (error instanceof WorkspaceInstallFailClosedError) throw error;
    throw failClosed(reason, error instanceof Error ? error.message : String(error));
  }
}

function finishApply(
  planned: PlannedInstall,
  receipt: ReceiptContents,
  clone: Extract<CloneCopyObservation, { status: "observed" }>
): AppliedWorkspaceInstall {
  const timings = planned.timings;
  return {
    workerId: planned.workerId,
    questionId: planned.questionId,
    sourcePath: planned.sourcePath,
    overlayPath: planned.overlayPath,
    targetPath: planned.targetPath,
    walPath: planned.walPath,
    shmPath: planned.shmPath,
    sqlitePath: planned.sqlitePath,
    clockAMs: planned.clockAMs ?? notObserved(CLOCK_A_REASON),
    diskPhaseMs: timings.cloneMs + timings.fsyncMs + timings.reopenMs + timings.reloadMs,
    clone,
    phases: Object.freeze([
      observedPhase("receipt_read", timings.receiptReadMs, timings.receiptReadCount),
      observedPhase("clone_copy", timings.cloneMs, timings.cloneCount),
      observedPhase("fsync", timings.fsyncMs, timings.fsyncCount),
      observedPhase("sqlite_reopen", timings.reopenMs, timings.reopenCount),
      observedPhase("daemon_reload", timings.reloadMs, timings.reloadCount),
      notObservedPhase("cleanup", "workspace install temp root was not finalized")
    ]),
    sourceDigestBefore: receipt.sourceSha256,
    overlayDigestBefore: receipt.overlaySha256,
    sourceIno: lstatSync(planned.sourcePath).ino,
    targetIno: lstatSync(planned.targetPath).ino
  };
}

function assertPrivateTarget(targetPath: string): void {
  if (existsSync(targetPath) || existsSync(`${targetPath}-wal`) || existsSync(`${targetPath}-shm`)) {
    throw failClosed(
      "shared-mutable",
      "workspace install refuses to reuse a private copy without proved SQLite/WAL reset"
    );
  }
}

function assertSealedSourceUnchanged(
  planned: PlannedInstall,
  receipt: ReceiptContents
): void {
  if (hashRegularFileNoFollow(planned.sourcePath) !== receipt.sourceSha256) {
    throw failClosed("source-drift", "sealed source changed before publish");
  }
  if (hashRegularFileNoFollow(planned.overlayPath) !== receipt.overlaySha256) {
    throw failClosed("source-drift", "overlay changed before publish");
  }
}

function writePrivateSidecars(planned: PlannedInstall): void {
  writeFileSync(planned.walPath, "wal");
  writeFileSync(planned.shmPath, "shm");
}

function discardPrivateState(planned: PlannedInstall, tmpPath: string): void {
  rmSync(tmpPath, { force: true });
  rmSync(planned.targetPath, { force: true });
  rmSync(planned.walPath, { force: true });
  rmSync(planned.shmPath, { force: true });
  rmSync(planned.sqlitePath, { force: true });
}

function classifyFailClosed(error: unknown): WorkspaceInstallFailClosedError {
  if (error instanceof WorkspaceInstallFailClosedError) return error;
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  if (/ELOOP|symlink|not a regular file/iu.test(message) || code === "ELOOP") {
    return failClosed("symlink-source", message);
  }
  if (/changed while copying|changed after cached digest/iu.test(message)) {
    return failClosed("source-drift", message);
  }
  return failClosed("partial-copy", message);
}

function readWorkspaceReceipt(receiptPath: string): ReceiptContents {
  const parsed = JSON.parse(readFileSync(receiptPath, "utf8")) as {
    readonly sourceSha256?: unknown;
    readonly overlaySha256?: unknown;
  };
  if (typeof parsed.sourceSha256 !== "string" || typeof parsed.overlaySha256 !== "string") {
    throw failClosed("stale-receipt", "workspace receipt is missing digests");
  }
  return { sourceSha256: parsed.sourceSha256, overlaySha256: parsed.overlaySha256 };
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
    db.exec("CREATE TABLE p02_probe (id INTEGER PRIMARY KEY);");
    db.exec("INSERT INTO p02_probe (id) VALUES (1);");
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

function noopReload(_dataDir: string): void {}

function emptyTimings(): PhaseTimings {
  return {
    receiptReadMs: 0,
    cloneMs: 0,
    fsyncMs: 0,
    reopenMs: 0,
    reloadMs: 0,
    receiptReadCount: 0,
    cloneCount: 0,
    fsyncCount: 0,
    reopenCount: 0,
    reloadCount: 0
  };
}

function timeCall<T>(fn: () => T): { readonly value: T; readonly durationMs: number } {
  const startedAt = performance.now();
  const value = fn();
  return { value, durationMs: performance.now() - startedAt };
}

function failClosed(
  reason: WorkspaceInstallFailClosedReason,
  message?: string
): WorkspaceInstallFailClosedError {
  return new WorkspaceInstallFailClosedError(reason, message);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}
