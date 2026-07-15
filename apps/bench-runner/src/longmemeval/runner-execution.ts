import {
  startBenchDaemon,
  type BenchDaemonHandle
} from "../harness/daemon.js";
import { DEFAULT_BENCH_EMBEDDING_PROVIDER_KIND } from "../harness/daemon-types.js";
import { collectBenchSeedFuelInventory } from "./seed-fuel-collector.js";
import { QaChatError } from "./qa-chat.js";
import { selectionContractIdentity } from "./selection/contract.js";
import { writeRecallEvalSnapshot } from "./runner-helpers.js";
import {
  runLongMemEvalQuestion,
  type LongMemEvalWorkerResult
} from "./runner-question.js";
import type { LongMemEvalQuestion } from "./dataset.js";
import type { LongMemEvalSnapshotQuestion } from "./snapshot.js";
import type { LongMemEvalRunOptions } from "./runner.js";
import { finalizeOwnedTempRoot } from "./lifecycle/owned-temp-root.js";
import { buildLongMemEvalRunProvenance } from "./provenance/run.js";
import { throwLifecycleErrors } from "./lifecycle/errors.js";
import { runIsolatedQuestionSequence } from "./lifecycle/question-isolated-execution.js";
import type { LongMemEvalRunContext } from "./runner/prepare-context.js";
import {
  emptySeedFuelInventory,
  mergeSeedFuelInventories,
  type SeedFuelInventory
} from "./seed-fuel-inventory.js";

export interface LongMemEvalExecutionResult {
  readonly collected: readonly LongMemEvalWorkerResult[];
  readonly questionFailures: number;
  readonly failedQuestionIds: readonly string[];
  readonly seedFuelInventory: Awaited<
    ReturnType<typeof collectBenchSeedFuelInventory>
  >;
}

export async function executeLongMemEvalRun(
  context: LongMemEvalRunContext
): Promise<LongMemEvalExecutionResult> {
  return context.captureSnapshot
    ? executeSnapshotCompatibleLongMemEvalRun(context)
    : executeQuestionIsolatedLongMemEvalRun(context);
}

async function executeSnapshotCompatibleLongMemEvalRun(
  context: LongMemEvalRunContext
): Promise<LongMemEvalExecutionResult> {
  let daemon: BenchDaemonHandle | undefined;
  let succeeded = false;
  let result: LongMemEvalExecutionResult | undefined;
  let primaryError: unknown;
  const execution = createExecutionState();
  try {
    daemon = await startLongMemEvalDaemon(context);
    await runLongMemEvalWindow(context, daemon, execution);
    const seedFuelInventory = await collectBenchSeedFuelInventory(daemon.dataDir);
    await writeLongMemEvalSnapshotIfRequested(context, execution.snapshotQuestions);
    result = {
      collected: execution.collected,
      questionFailures: execution.questionFailures,
      failedQuestionIds: execution.failedQuestionIds,
      seedFuelInventory
    };
    succeeded = execution.questionFailures === 0;
  } catch (error) {
    primaryError = error;
  }
  let shutdownError: unknown;
  try {
    if (daemon !== undefined) await daemon.shutdown();
  } catch (error) {
    shutdownError = error;
  }
  let cleanupError: unknown;
  try {
    await cleanupSeedDataDirRoot(
      context,
      succeeded && primaryError === undefined && shutdownError === undefined
    );
  } catch (error) {
    cleanupError = error;
  }
  throwLifecycleErrors("LongMemEval run lifecycle failed", [
    primaryError,
    shutdownError,
    cleanupError
  ]);
  if (result === undefined) throw new Error("LongMemEval run produced no result");
  return result;
}

async function executeQuestionIsolatedLongMemEvalRun(
  context: LongMemEvalRunContext
): Promise<LongMemEvalExecutionResult> {
  const execution = createExecutionState();
  let result: LongMemEvalExecutionResult | undefined;
  let primaryError: unknown;
  let succeeded = false;
  try {
    const isolated = await runIsolatedQuestionSequence<
      LongMemEvalQuestion,
      BenchDaemonHandle,
      boolean,
      SeedFuelInventory,
      SeedFuelInventory
    >({
      questions: context.window,
      rootParent: context.seedDataDirRoot,
      rootPrefix: "question-",
      initialAggregate: emptySeedFuelInventory(),
      mergeAggregate: (aggregate, inventory) =>
        mergeSeedFuelInventories([aggregate, inventory]),
      start: async (root) => startLongMemEvalDaemon({
        ...context,
        seedDataDirRoot: root.path,
        removeSeedDataDirRoot: false
      }),
      run: async (daemon, question, index) =>
        runLongMemEvalQuestionSafely(context, daemon, execution, index, question),
      collect: async (daemon) => collectBenchSeedFuelInventory(daemon.dataDir),
      shutdown: async (daemon) => daemon.shutdown(),
      isSuccessful: (questionSucceeded) => questionSucceeded,
      failureLabel: (question) => question.question_id
    });
    result = buildExecutionResult(execution, isolated.aggregate);
    succeeded = execution.questionFailures === 0;
  } catch (error) {
    primaryError = error;
  }
  const cleanupError = await captureSeedRootCleanupError(context, succeeded);
  throwLifecycleErrors("LongMemEval run lifecycle failed", [primaryError, cleanupError]);
  if (result === undefined) throw new Error("LongMemEval run produced no result");
  return result;
}

function buildExecutionResult(
  execution: ReturnType<typeof createExecutionState>,
  seedFuelInventory: LongMemEvalExecutionResult["seedFuelInventory"]
): LongMemEvalExecutionResult {
  return {
    collected: execution.collected,
    questionFailures: execution.questionFailures,
    failedQuestionIds: execution.failedQuestionIds,
    seedFuelInventory
  };
}

async function captureSeedRootCleanupError(
  context: LongMemEvalRunContext,
  succeeded: boolean
): Promise<unknown> {
  try {
    await cleanupSeedDataDirRoot(context, succeeded);
    return undefined;
  } catch (error) {
    return error;
  }
}

function createExecutionState(): {
  readonly collected: LongMemEvalWorkerResult[];
  readonly snapshotQuestions: LongMemEvalSnapshotQuestion[];
  questionFailures: number;
  readonly failedQuestionIds: string[];
} {
  return {
    collected: [],
    snapshotQuestions: [],
    questionFailures: 0,
    failedQuestionIds: []
  };
}

async function startLongMemEvalDaemon(
  context: LongMemEvalRunContext
): Promise<BenchDaemonHandle> {
  const benchRunId = `lme-bench-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return startBenchDaemon({
    workspaceId: `${benchRunId}-default`,
    runId: `${benchRunId}-default-run`,
    embeddingMode: context.opts.embeddingMode ?? "disabled",
    ...(context.opts.embeddingProviderKind === undefined
      ? {}
      : { embeddingProviderKind: context.opts.embeddingProviderKind }),
    ...(context.seedDataDirRoot === undefined
      ? {}
      : { dataDirRoot: context.seedDataDirRoot }),
    recallWeightOverrides: context.recallWeightOverrides
  });
}

async function runLongMemEvalWindow(
  context: LongMemEvalRunContext,
  daemon: BenchDaemonHandle,
  execution: ReturnType<typeof createExecutionState>
): Promise<void> {
  for (let i = 0; i < context.window.length; i += 1) {
    const question = context.window[i];
    if (question === undefined) continue;
    await runLongMemEvalQuestionSafely(context, daemon, execution, i, question);
  }
  if (execution.questionFailures > 0) {
    process.stdout.write(
      `[longmemeval] ${execution.questionFailures}/${context.window.length} question(s) failed ` +
        `and were skipped; KPIs cover the ${execution.collected.length} completed.\n`
    );
  }
}

async function runLongMemEvalQuestionSafely(
  context: LongMemEvalRunContext,
  daemon: BenchDaemonHandle,
  execution: ReturnType<typeof createExecutionState>,
  questionIndex: number,
  question: LongMemEvalQuestion
): Promise<boolean> {
  try {
    const result = await runLongMemEvalQuestion({
      daemon,
      question,
      turnIndex: questionIndex + 1,
      seedRunner: context.seedRunner,
      recallOptions: context.recallOptions,
      simulateReport: context.simulateReport,
      embeddingMode: context.opts.embeddingMode ?? "disabled",
      embeddingProviderKind: context.opts.embeddingProviderKind ??
        DEFAULT_BENCH_EMBEDDING_PROVIDER_KIND,
      captureSnapshot: context.captureSnapshot,
      ...(context.opts.qa === undefined ? {} : buildQaOptions(context.opts.qa))
    });
    const diagnostics = await context.diagnosticsSpool.append(result.diagnostics);
    execution.collected.push({ ...result, diagnostics });
    if (context.captureSnapshot && result.snapshotQuestion !== undefined) {
      execution.snapshotQuestions.push(result.snapshotQuestion);
    }
    writeLongMemEvalQuestionProgress(questionIndex, context.window.length, question.question_id, result);
    return true;
  } catch (error) {
    if (!(error instanceof QaChatError)) throw error;
    execution.questionFailures += 1;
    execution.failedQuestionIds.push(question.question_id);
    writeLongMemEvalQuestionFailure(questionIndex, context.window.length, question.question_id, error);
    return false;
  }
}

function buildQaOptions(
  qa: NonNullable<LongMemEvalRunOptions["qa"]>
): Pick<
  Parameters<typeof runLongMemEvalQuestion>[0],
  "qaChat" | "qaJudgeChat"
> {
  return {
    qaChat: qa.chat,
    ...(qa.judgeChat === undefined ? {} : { qaJudgeChat: qa.judgeChat })
  };
}

function writeLongMemEvalQuestionProgress(
  questionIndex: number,
  totalQuestions: number,
  questionId: string,
  result: LongMemEvalWorkerResult
): void {
  process.stdout.write(
    `[${questionIndex + 1}/${totalQuestions}] ${questionId.slice(0, 8)} ` +
      `R@5=${result.hitAt5 ? "✓" : "✗"} latency=${result.latencyMs}ms\n`
  );
}

function writeLongMemEvalQuestionFailure(
  questionIndex: number,
  totalQuestions: number,
  questionId: string,
  error: QaChatError
): void {
  process.stderr.write(
    `[${questionIndex + 1}/${totalQuestions}] ${questionId.slice(0, 8)} FAILED — ` +
      `skipped: ${error.message}\n`
  );
}

async function writeLongMemEvalSnapshotIfRequested(
  context: LongMemEvalRunContext,
  snapshotQuestions: readonly LongMemEvalSnapshotQuestion[]
): Promise<void> {
  if (context.opts.snapshotOut === undefined || context.seedDataDirRoot === undefined) {
    return;
  }
  const runProvenance = await buildLongMemEvalRunProvenance({
    opts: context.opts,
    evaluatedCount: snapshotQuestions.length,
    commitSha7: context.commitSha7,
    embeddingProviderLabel: context.embeddingProviderLabel,
    env: process.env,
    recallOptions: context.recallOptions,
    datasetSha256: context.datasetSha256,
    selection: selectionContractIdentity(context.selectionContract)
  });
  await writeRecallEvalSnapshot({
    snapshotOut: context.opts.snapshotOut,
    seedDataDirRoot: context.seedDataDirRoot,
    variant: context.opts.variant,
    commitSha7: context.commitSha7,
    snapshotQuestions,
    extractionCacheRoot: context.extractionCacheRoot,
    datasetSha256: context.datasetSha256,
    runProvenance
  });
  process.stdout.write(
    `[longmemeval snapshot] wrote ${snapshotQuestions.length} questions -> ${context.opts.snapshotOut}\n`
  );
}

async function cleanupSeedDataDirRoot(
  context: LongMemEvalRunContext,
  succeeded: boolean
): Promise<void> {
  if (context.seedDataDirRoot === undefined) return;
  await finalizeOwnedTempRoot(
    { path: context.seedDataDirRoot, owned: context.removeSeedDataDirRoot },
    succeeded
  );
}
