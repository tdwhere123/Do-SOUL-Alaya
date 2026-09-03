import { throwLifecycleErrors } from "../errors.js";
import { assertRecallZeroLiveExtraction } from "@do-soul/alaya-core";
import { writeRecallEvalProgress } from "./recall-eval-progress.js";
import {
  RecallEvalDiagnosticsSpool
} from "../../provenance/recall-eval/recall-eval-diagnostics-spool.js";
import type { RecallEvalRunContext } from "./recall-eval-run-context.js";
import type { RecallEvalQuestionResult } from "./recall-eval-contract.js";
import {
  disposeRecallEvalSelectionBoundaryArtifact,
  type RecallEvalSelectionBoundaryArtifact
} from "./recall-eval-selection-replay.js";
import { recallOptionsForQuestion } from "./recall-eval-question-options.js";
import {
  RecallEvalPagerChildExitedError,
  createRecallEvalPagerSession,
  type RecallEvalPagerIpcSession
} from "./recall-eval-process/ipc-client.js";
import {
  formatRecallEvalPagerMapsHint,
  readRecallEvalPagerMapsHint
} from "./recall-eval-process/maps-hint.js";
import type {
  RecallEvalPagerOpenPayload,
  RecallEvalPagerRecallPayload
} from "./recall-eval-process/payload.js";
import type { EmbeddingCacheOverlayExpectedSourceBinding } from
  "../../snapshot/recall-eval/embedding-cache-overlay/contract.js";

export async function executeRecallEvalRun(
  context: RecallEvalRunContext,
  diagnosticsSpool: RecallEvalDiagnosticsSpool
): Promise<Readonly<{
  collected: readonly RecallEvalQuestionResult[];
  selectionArtifact: RecallEvalSelectionBoundaryArtifact | null;
  evidenceProjectionRebuild: unknown;
}>> {
  assertRecallZeroLiveExtraction();
  const session = createRecallEvalPagerSession();
  let collected: readonly RecallEvalQuestionResult[] = [];
  let selectionArtifact: RecallEvalSelectionBoundaryArtifact | null = null;
  let evidenceProjectionRebuild: unknown = null;
  let primaryError: unknown;
  try {
    evidenceProjectionRebuild = await openPager(session, context);
    collected = await executeRecallEvalQuestions(context, session, diagnosticsSpool);
    selectionArtifact = await closePager(session);
    await context.memoryProfile?.sample({ phase: "daemon_stopped" });
  } catch (error) {
    primaryError = error;
    logPagerFailClosed(error);
    await closePagerQuietly(session);
  }
  throwLifecycleErrors("recall-eval daemon lifecycle failed", [primaryError]);
  return { collected, selectionArtifact, evidenceProjectionRebuild };
}

async function openPager(
  session: RecallEvalPagerIpcSession,
  context: RecallEvalRunContext
): Promise<unknown> {
  const opened = await session.open(buildPagerOpenPayload(context));
  const childHint = opened.mapsHint ?? session.lastMapsHint;
  process.stdout.write(
    `[recall-eval pager] child ${
      childHint === null || childHint === undefined
        ? `pid=${session.pid ?? "unknown"}`
        : formatRecallEvalPagerMapsHint(childHint)
    }\n`
  );
  process.stdout.write(
    `[recall-eval pager] parent ${formatRecallEvalPagerMapsHint(
      readRecallEvalPagerMapsHint(process.pid)
    )}\n`
  );
  await context.memoryProfile?.sample({ phase: "daemon_started" });
  return opened.evidenceProjectionRebuild ?? null;
}

async function closePager(
  session: RecallEvalPagerIpcSession
): Promise<RecallEvalSelectionBoundaryArtifact | null> {
  const artifact = await session.close();
  return (artifact ?? null) as RecallEvalSelectionBoundaryArtifact | null;
}

async function closePagerQuietly(session: RecallEvalPagerIpcSession): Promise<void> {
  try {
    const artifact = await closePager(session);
    await disposeRecallEvalSelectionBoundaryArtifact(artifact);
  } catch {
    // Primary failure already owns the arm; close is best-effort reap.
  }
}

function logPagerFailClosed(error: unknown): void {
  if (!(error instanceof RecallEvalPagerChildExitedError)) return;
  process.stderr.write(`[recall-eval pager] fail-closed ${error.message}\n`);
}

async function executeRecallEvalQuestions(
  context: RecallEvalRunContext,
  session: RecallEvalPagerIpcSession,
  diagnosticsSpool: RecallEvalDiagnosticsSpool
): Promise<readonly RecallEvalQuestionResult[]> {
  const collected: RecallEvalQuestionResult[] = [];
  let warmupProfiled = false;
  for (let i = 0; i < context.window.length; i += 1) {
    const question = context.window[i];
    if (question === undefined) continue;
    const result = await diagnosticsSpool.append(
      await session.recall(buildPagerRecallPayload(context, question, i + 1)) as
        RecallEvalQuestionResult
    );
    collected.push(result);
    if (!warmupProfiled && (result.embeddingWarmup?.pass_count ?? 0) > 0) {
      await context.memoryProfile?.sample({ phase: "first_embedding_warmup_complete" });
      warmupProfiled = true;
    }
    await context.memoryProfile?.sample({
      phase: "question_complete",
      questionId: question.questionId,
      questionIndex: i
    });
    writeRecallEvalProgress(i, context.window.length, question.questionId, result);
    await session.recycle();
  }
  return collected;
}

function buildPagerOpenPayload(context: RecallEvalRunContext): RecallEvalPagerOpenPayload {
  return {
    dataDirRoot: context.dataDirRoot,
    daemonLaunch: context.daemonLaunch,
    recallWeightOverrides: context.recallWeightOverrides,
    options: context.options,
    manifest: context.manifest,
    overlayExpected: overlayExpectedFromAttribution(context),
    sourceExtractionSystemPromptSha256: context.sourceExtractionSystemPromptSha256,
    embeddingMode: context.daemonLaunch.embeddingMode,
    simulateReport: context.simulateReport,
    captureOpenSemanticFactorCandidateActivations:
      context.options.captureOpenSemanticFactorCandidateActivations === true
  };
}

function buildPagerRecallPayload(
  context: RecallEvalRunContext,
  question: RecallEvalRunContext["window"][number],
  turnIndex: number
): RecallEvalPagerRecallPayload {
  const { selectionBoundaryObserver: _observer, ...recallOptions } =
    recallOptionsForQuestion(context, question.question, undefined);
  return {
    question,
    turnIndex,
    recallOptions,
    measurement: context.measurementForQuestion?.(question.questionId)
  };
}

function overlayExpectedFromAttribution(
  context: RecallEvalRunContext
): EmbeddingCacheOverlayExpectedSourceBinding | undefined {
  const overlay = context.runtimeAttribution.embedding_cache_overlay;
  if (overlay === undefined) return undefined;
  return {
    source_snapshot_db_sha256: overlay.source_snapshot_db_sha256,
    source_snapshot_manifest_sha256: overlay.source_snapshot_manifest_sha256,
    source_schema_version: overlay.source_schema_version,
    recall_pipeline_version: overlay.recall_pipeline_version,
    vector_space: overlay.vector_space
  };
}
