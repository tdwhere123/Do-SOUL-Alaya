import {
  startBenchDaemon,
  type BenchDaemonHandle
} from "../../../../harness/daemon.js";
import { openRecallEvalWorkingSqlite, recallEvalWorkingDbPath } from
  "../../../snapshot/recall-eval/recall-eval-working-sqlite.js";
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
import { readRecallEvalPagerMapsHint } from "./maps-hint.js";
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
  readonly daemon: BenchDaemonHandle;
  readonly spool: LongMemEvalSelectionBoundarySpool | null;
  readonly open: RecallEvalPagerOpenPayload;
}

let runtime: PagerRuntime | null = null;

export async function openRecallEvalPagerChild(
  payload: RecallEvalPagerOpenPayload
): Promise<RecallEvalPagerOpenResult> {
  if (runtime !== null) throw new Error("recall-eval pager child is already open");
  const sqlite = await openRecallEvalWorkingSqlite({
    restoredDbPath: recallEvalWorkingDbPath(payload.dataDirRoot),
    options: payload.options,
    manifest: payload.manifest,
    warm: readWarmReceipt(payload),
    ...(payload.sourceExtractionSystemPromptSha256 === undefined
      ? {}
      : { sourceExtractionSystemPromptSha256: payload.sourceExtractionSystemPromptSha256 }),
    ...(payload.overlayExpected === undefined
      ? {}
      : { overlayExpected: payload.overlayExpected })
  });
  const daemon = await startBenchDaemon({
    dataDirRoot: payload.dataDirRoot,
    embeddingMode: payload.daemonLaunch.embeddingMode,
    embeddingProviderKind: payload.daemonLaunch.embeddingProviderKind,
    recallWeightOverrides: payload.recallWeightOverrides
  }, payload.daemonLaunch);
  runtime = {
    daemon,
    spool: await createRecallEvalSelectionBoundarySpool(process.env),
    open: payload
  };
  return sqlite;
}

export async function recallRecallEvalPagerChild(
  payload: RecallEvalPagerRecallPayload
): Promise<RecallEvalQuestionResult> {
  const current = requireRuntime();
  const activation = createCandidateActivationCapture(
    current.open.captureOpenSemanticFactorCandidateActivations
  );
  const result = await captureRecallEvalQuestion(
    current.spool,
    payload.question.questionId,
    (observer) => recallEvalOneQuestion({
      daemon: current.daemon,
      question: payload.question,
      turnIndex: payload.turnIndex,
      embeddingMode: current.open.embeddingMode,
      recallOptions: {
        ...payload.recallOptions,
        ...observerFields(observer, activation.observer)
      },
      simulateReport: current.open.simulateReport,
      measurement: payload.measurement
    })
  );
  return activation.attach(result);
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
  try {
    await current.daemon.shutdown();
  } catch (error) {
    primaryError ??= error;
  }
  if (primaryError !== undefined) throw primaryError;
  return { selectionArtifact };
}

export function childMapsHint() {
  return readRecallEvalPagerMapsHint(process.pid);
}

function requireRuntime(): PagerRuntime {
  if (runtime === null) throw new Error("recall-eval pager child is not open");
  return runtime;
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
  first: Parameters<typeof combineSelectionBoundaryObservers>[0],
  second: Parameters<typeof combineSelectionBoundaryObservers>[1]
) {
  const observer = combineSelectionBoundaryObservers(first, second);
  return observer === undefined ? {} : { selectionBoundaryObserver: observer };
}
