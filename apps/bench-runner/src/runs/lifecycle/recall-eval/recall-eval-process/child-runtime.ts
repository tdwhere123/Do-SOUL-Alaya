import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { stableStringify } from "@do-soul/alaya-core";
import { relative, resolve } from "node:path";
import { closeCachedDatabase } from "@do-soul/alaya-storage";
import {
  startBenchDaemon,
  type BenchDaemonHandle
} from "../../../../harness/daemon.js";
import { openRecallEvalWorkingSqlite, recallEvalWorkingDbPath } from
  "../../../snapshot/recall-eval/recall-eval-working-sqlite.js";
import {
  explodeRecallEvalWorkingCopyIfNeeded,
  installRecallEvalWorkspaceSlice,
  installWorkspaceSlice,
  isSealedSliceRestore,
  workingAlayaDbPath,
  type ExplodedWorkspaceSlices,
  type WorkspaceSliceProgress
} from "../../../snapshot/recall-eval/workspace-slice/index.js";
import {
  readWarmDerivedSnapshotReceipt,
  type WarmDerivedSnapshotReceipt
} from "../../../snapshot/recall-eval/warm-derived/warm-derived-snapshot-receipt.js";
import { recallEvalOneQuestion } from "../question/recall-eval-question.js";
import { resolveWorkspaceSliceSnapshotDigest } from "./child-snapshot-digest.js";
import { readRecallEvalPagerMapsHint } from "./maps-hint.js";
import { seedParentOpenedFileProofs } from "./parent-opened-file-proofs.js";
import type {
  RecallEvalPagerOpenPayload,
  RecallEvalPagerOpenResult,
  RecallEvalPagerRecallPayload
} from "./payload.js";
import type { RecallEvalQuestionResult } from "../recall-eval-contract.js";

interface PagerRuntime {
  daemon: BenchDaemonHandle | null;
  readonly open: RecallEvalPagerOpenPayload;
  readonly slices: ExplodedWorkspaceSlices | null;
  installedWorkspaceId: string | null;
  workingDbPath: string | null;
  switchIndex: number;
  continuationBinding: PagerContinuationBinding | null;
}

export interface PagerContinuationBinding {
  readonly requestIdentity: string;
  readonly workingFileIdentity: string;
}

export function assertPagerContinuationBinding(
  active: PagerContinuationBinding | null,
  requested: PagerContinuationBinding
): void {
  if (active === null || requested.workingFileIdentity === "unavailable"
    || active.requestIdentity !== requested.requestIdentity
    || active.workingFileIdentity !== requested.workingFileIdentity) {
    throw new Error("recall continuation invalidated: active question or source snapshot is unavailable");
  }
}

export function pagerSwitchWorkingDataDir(
  dataDirRoot: string,
  switchIndex: number,
  workspaceId: string
): string {
  return resolve(dataDirRoot, "pager-working", `${switchIndex}-${workspaceId}`);
}

function removeClosedPagerWorkingDir(
  dataDirRoot: string,
  workingDbPath: string | null
): void {
  if (workingDbPath === null) return;
  const workingDir = resolve(workingDbPath, "..");
  const switchRoot = resolve(dataDirRoot, "pager-working");
  const rel = relative(switchRoot, workingDir);
  if (rel === "" || rel.startsWith("..")) return;
  rmSync(workingDir, { recursive: true, force: true });
}

let runtime: PagerRuntime | null = null;

export async function openRecallEvalPagerChild(
  payload: RecallEvalPagerOpenPayload,
  onProgress?: (progress: WorkspaceSliceProgress) => void
): Promise<RecallEvalPagerOpenResult> {
  if (runtime !== null) throw new Error("recall-eval pager child is already open");
  seedParentOpenedFileProofs(payload);
  const working = await openRecallEvalPagerWorkingCopy(payload, onProgress);
  runtime = {
    daemon: null,
    open: payload,
    slices: working.slices,
    installedWorkspaceId: working.slices?.workspaceIds[0] ?? null,
    workingDbPath: workingAlayaDbPath(payload.dataDirRoot),
    switchIndex: 0,
    continuationBinding: null
  };
  return working.sqlite;
}

export async function recallRecallEvalPagerChild(
  payload: RecallEvalPagerRecallPayload
): Promise<RecallEvalQuestionResult> {
  const current = requireRuntime();
  const snapshotDigest = resolveWorkspaceSliceSnapshotDigest(current.slices, payload.question.workspaceId);
  const requestIdentity = createHash("sha256").update(stableStringify({
    question: payload.question,
    turnIndex: payload.turnIndex,
    sourceDigest: snapshotDigest ?? current.open.manifest.artifact_integrity?.db_sha256 ?? null
  })).digest("hex");
  if (payload.recallOptions.continuation != null) {
    assertPagerContinuationBinding(current.daemon === null ? null : current.continuationBinding, {
      requestIdentity,
      workingFileIdentity: workingFileIdentity(current.workingDbPath)
    });
  } else {
    current.continuationBinding = null;
    await ensurePagerDaemonForQuestion(current, payload.question.workspaceId);
  }
  const daemon = current.daemon;
  if (daemon === null) {
    throw new Error("recall-eval pager daemon is not running");
  }
  const result = await recallEvalOneQuestion({
    daemon,
    question: payload.question,
    turnIndex: payload.turnIndex,
    embeddingMode: current.open.embeddingMode,
    recallOptions: {
      ...payload.recallOptions,
      ...(snapshotDigest === undefined ? {} : { snapshotDigest })
    },
    simulateReport: current.open.simulateReport,
    measurement: payload.measurement
  });
  current.continuationBinding = {
    requestIdentity,
    workingFileIdentity: workingFileIdentity(current.workingDbPath)
  };
  return result;
}

function workingFileIdentity(path: string | null): string {
  if (path === null || !existsSync(path)) return "unavailable";
  const stat = statSync(path, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
}

async function ensurePagerDaemonForQuestion(
  current: PagerRuntime,
  workspaceId: string
): Promise<void> {
  // New working-copy inode each question: WSL2 SIGBUS'd a long-lived mmap of
  // the multi-GB snapshot. mmap_size=0 is the pragma; path-switch drops the
  // mapping. Restarting the daemon is what reloads MiniLM.
  current.switchIndex += 1;
  const nextDir = pagerSwitchWorkingDataDir(
    current.open.dataDirRoot, current.switchIndex, workspaceId
  );
  mkdirSync(nextDir, { recursive: true });

  if (current.daemon !== null) {
    await current.daemon.shutdown();
    current.daemon = null;
  }
  const previousWorking = current.workingDbPath;
  if (previousWorking !== null) {
    closeCachedDatabase(previousWorking);
  }

  if (current.slices !== null) {
    installRecallEvalWorkspaceSlice({
      dataDirRoot: nextDir,
      workspaceId,
      slices: current.slices
    });
  } else {
    // Skip-slice/single-workspace has no sealed slice cache; path-switch
    // still cannot start the pager on an empty directory.
    const source = workingAlayaDbPath(current.open.dataDirRoot);
    if (!existsSync(source)) {
      throw new Error(`recall-eval pager working copy is missing at ${source}`);
    }
    installWorkspaceSlice({
      dataDir: nextDir,
      sliceDbPath: source
    });
  }
  current.installedWorkspaceId = workspaceId;
  current.workingDbPath = workingAlayaDbPath(nextDir);

  current.daemon = await startBenchDaemon({
    dataDirRoot: nextDir,
    embeddingMode: current.open.daemonLaunch.embeddingMode,
    embeddingProviderKind: current.open.daemonLaunch.embeddingProviderKind,
    recallWeightOverrides: current.open.recallWeightOverrides
  });
  current.daemon.reloadWorkingDatabase();

  removeClosedPagerWorkingDir(current.open.dataDirRoot, previousWorking);
}

export async function closeRecallEvalPagerChild(): Promise<void> {
  const current = runtime;
  runtime = null;
  if (current === null) return;
  let primaryError: unknown;
  if (current.daemon !== null) {
    try {
      await current.daemon.shutdown();
    } catch (error) {
      primaryError ??= error;
    }
  }
  closeCachedDatabase(
    current.workingDbPath ?? workingAlayaDbPath(current.open.dataDirRoot)
  );
  if (primaryError !== undefined) throw primaryError;
}

export function childMapsHint() {
  return readRecallEvalPagerMapsHint(process.pid);
}

function requireRuntime(): PagerRuntime {
  if (runtime === null) throw new Error("recall-eval pager child is not open");
  return runtime;
}

async function openRecallEvalPagerWorkingCopy(
  payload: RecallEvalPagerOpenPayload,
  onProgress?: (progress: WorkspaceSliceProgress) => void
): Promise<{
  readonly sqlite: Awaited<ReturnType<typeof openRecallEvalWorkingSqlite>>;
  readonly slices: ExplodedWorkspaceSlices | null;
}> {
  if (isSealedSliceRestore()) {
    return openSealedSlicePagerWorkingCopy(payload, onProgress);
  }
  return openPackedPagerWorkingCopy(payload, onProgress);
}

async function openSealedSlicePagerWorkingCopy(
  payload: RecallEvalPagerOpenPayload,
  onProgress?: (progress: WorkspaceSliceProgress) => void
): Promise<{
  readonly sqlite: Awaited<ReturnType<typeof openRecallEvalWorkingSqlite>>;
  readonly slices: ExplodedWorkspaceSlices;
}> {
  const slices = await explodeRecallEvalWorkingCopyIfNeeded({
    dataDirRoot: payload.dataDirRoot,
    snapshotDbPath: payload.options.snapshotDbPath,
    onProgress
  });
  if (slices === null || slices.workspaceIds[0] === undefined) {
    throw new Error(
      "[recall-eval] sealed workspace-slice reuse is required and the cache is missing or drifted"
    );
  }
  const working = workingAlayaDbPath(payload.dataDirRoot);
  closeCachedDatabase(working);
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${working}${suffix}`, { force: true });
  }
  installRecallEvalWorkspaceSlice({
    dataDirRoot: payload.dataDirRoot,
    workspaceId: slices.workspaceIds[0],
    slices
  });
  const sqlite = await openPagerSqlite(payload, payload.options.snapshotDbPath);
  return { sqlite, slices };
}

async function openPackedPagerWorkingCopy(
  payload: RecallEvalPagerOpenPayload,
  onProgress?: (progress: WorkspaceSliceProgress) => void
): Promise<{
  readonly sqlite: Awaited<ReturnType<typeof openRecallEvalWorkingSqlite>>;
  readonly slices: ExplodedWorkspaceSlices | null;
}> {
  // Recycle respawns this child against the same dataDir. Q1 explode replaces
  // alaya.db with a workspace slice; integrity must keep hashing the sealed
  // snapshot, not the working copy.
  const sqlite = await openPagerSqlite(payload, payload.options.snapshotDbPath);
  const slices = await explodeRecallEvalWorkingCopyIfNeeded({
    dataDirRoot: payload.dataDirRoot,
    snapshotDbPath: payload.options.snapshotDbPath,
    onProgress
  });
  if (slices !== null && slices.workspaceIds[0] !== undefined) {
    const working = workingAlayaDbPath(payload.dataDirRoot);
    closeCachedDatabase(working);
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${working}${suffix}`, { force: true });
    }
    installRecallEvalWorkspaceSlice({
      dataDirRoot: payload.dataDirRoot,
      workspaceId: slices.workspaceIds[0],
      slices
    });
  }
  return { sqlite, slices };
}

async function openPagerSqlite(
  payload: RecallEvalPagerOpenPayload,
  snapshotBytePath?: string
): ReturnType<typeof openRecallEvalWorkingSqlite> {
  return openRecallEvalWorkingSqlite({
    restoredDbPath: recallEvalWorkingDbPath(payload.dataDirRoot),
    options: payload.options,
    manifest: payload.manifest,
    warm: readWarmReceipt(payload),
    ...(payload.sourceExtractionSystemPromptSha256 === undefined
      ? {}
      : { sourceExtractionSystemPromptSha256: payload.sourceExtractionSystemPromptSha256 }),
    ...(payload.overlayExpected === undefined
      ? {}
      : { overlayExpected: payload.overlayExpected }),
    ...(snapshotBytePath === undefined ? {} : { snapshotBytePath })
  });
}

function readWarmReceipt(
  payload: RecallEvalPagerOpenPayload
): WarmDerivedSnapshotReceipt | null {
  if (payload.options.warmDerivedSnapshotReceiptPath === undefined) return null;
  const sourceSnapshotDbSha256 = payload.manifest.artifact_integrity?.db_sha256;
  if (sourceSnapshotDbSha256 === undefined) {
    throw new Error("warm derived snapshot requires source DB artifact integrity");
  }
  return readWarmDerivedSnapshotReceipt({
    receiptPath: payload.options.warmDerivedSnapshotReceiptPath,
    sourceSnapshotDbSha256,
    sourceSchemaVersion: payload.manifest.schema_migration_version
  });
}
