import { mkdirSync, rmSync } from "node:fs";
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
  isSealedSliceRestore,
  workingAlayaDbPath,
  type ExplodedWorkspaceSlices,
  type WorkspaceSliceProgress
} from "../../../snapshot/recall-eval/workspace-slice/index.js";
import {
  readWarmDerivedSnapshotReceipt,
  type WarmDerivedSnapshotReceipt
} from "../../../snapshot/recall-eval/warm-derived/warm-derived-snapshot-receipt.js";
import {
  captureRecallEvalQuestion,
  createRecallEvalSelectionBoundarySpool,
  finalizeRecallEvalSelectionBoundarySpool
} from "../recall-eval-selection-replay.js";
import { recallEvalOneQuestion } from "../question/recall-eval-question.js";
import {
  combineSelectionBoundaryObservers,
  createCandidateActivationCapture
} from "../recall-eval-candidate-activation.js";
import { resolveWorkspaceSliceSnapshotDigest } from "./child-snapshot-digest.js";
import { readRecallEvalPagerMapsHint } from "./maps-hint.js";
import { seedParentOpenedFileProofs } from "./parent-opened-file-proofs.js";
import type {
  RecallEvalPagerCloseResult,
  RecallEvalPagerOpenPayload,
  RecallEvalPagerOpenResult,
  RecallEvalPagerRecallPayload
} from "./payload.js";
import type { RecallEvalQuestionResult } from "../recall-eval-contract.js";
import type { LongMemEvalSelectionBoundarySpool } from
  "../../../selection-replay/selection-boundary-spool.js";

interface PagerRuntime {
  daemon: BenchDaemonHandle | null;
  readonly spool: LongMemEvalSelectionBoundarySpool | null;
  readonly open: RecallEvalPagerOpenPayload;
  readonly slices: ExplodedWorkspaceSlices | null;
  installedWorkspaceId: string | null;
  workingDbPath: string | null;
  switchIndex: number;
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
  const spool = await createRecallEvalSelectionBoundarySpool(process.env);
  runtime = {
    daemon: null,
    spool,
    open: payload,
    slices: working.slices,
    installedWorkspaceId: working.slices?.workspaceIds[0] ?? null,
    workingDbPath: workingAlayaDbPath(payload.dataDirRoot),
    switchIndex: 0
  };
  return { ...working.sqlite, selectionSpoolRootPath: spool?.rootPath ?? null };
}

export async function recallRecallEvalPagerChild(
  payload: RecallEvalPagerRecallPayload
): Promise<RecallEvalQuestionResult> {
  const current = requireRuntime();
  await ensurePagerDaemonForQuestion(current, payload.question.workspaceId);
  const daemon = current.daemon;
  if (daemon === null) {
    throw new Error("recall-eval pager daemon is not running");
  }
  const activation = createCandidateActivationCapture(
    current.open.captureOpenSemanticFactorCandidateActivations
  );
  const snapshotDigest = resolveWorkspaceSliceSnapshotDigest(
    current.slices,
    payload.question.workspaceId
  );
  const result = await captureRecallEvalQuestion(
    current.spool,
    payload.question.questionId,
    (observer) => recallEvalOneQuestion({
      daemon,
      question: payload.question,
      turnIndex: payload.turnIndex,
      embeddingMode: current.open.embeddingMode,
      recallOptions: {
        ...payload.recallOptions,
        ...observerFields(observer, activation.observer),
        ...(snapshotDigest === undefined ? {} : { snapshotDigest })
      },
      simulateReport: current.open.simulateReport,
      measurement: payload.measurement
    })
  );
  return activation.attach(result);
}

async function ensurePagerDaemonForQuestion(
  current: PagerRuntime,
  workspaceId: string
): Promise<void> {
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

export async function closeRecallEvalPagerChild(): Promise<RecallEvalPagerCloseResult> {
  const current = runtime;
  runtime = null;
  if (current === null) return { selectionArtifact: null };
  let selectionArtifact = null;
  let primaryError: unknown;
  try {
    selectionArtifact = await finalizeRecallEvalSelectionBoundarySpool(current.spool);
  } catch (error) {
    primaryError = error;
  }
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
  if (primaryError !== undefined) {
    try {
      await current.spool?.dispose();
    } catch (error) {
      primaryError = new AggregateError(
        [primaryError, error],
        "recall-eval pager child cleanup failed"
      );
    }
    throw primaryError;
  }
  return { selectionArtifact };
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

function observerFields(
  selection: Parameters<typeof combineSelectionBoundaryObservers>[0],
  diagnostic: ReturnType<typeof createCandidateActivationCapture>["observer"]
) {
  return {
    ...(selection === undefined ? {} : { selectionBoundaryObserver: selection }),
    ...(diagnostic === undefined ? {} : { diagnosticObserver: diagnostic })
  };
}
