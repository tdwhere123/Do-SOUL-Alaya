import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBenchRunnerVersion } from "../shared/version.js";
import {
  startBenchDaemon,
  type BenchDaemonHandle
} from "../harness/daemon.js";
import type { BenchRecallWeightOverrides } from "../harness/recall-weight-overrides.js";
import { collectDistinctTurnContents } from "./extraction-fill.js";
import { loadDataset } from "./fetch.js";
import {
  createCompileSeedRunner,
  EXTRACTION_CACHE_ROOT,
  resolveBenchAllowLiveExtraction
} from "./compile-seed.js";
import { QaChatError } from "./qa-chat.js";
import {
  recallOptionsForPolicyShape,
  resolveBenchEmbeddingProviderLabel,
  resolveCommitInfo,
  writeRecallEvalSnapshot
} from "./runner-helpers.js";
import {
  runLongMemEvalQuestion,
  type LongMemEvalWorkerResult
} from "./runner-question.js";
import type { LongMemEvalSnapshotQuestion } from "./snapshot.js";
import type { LongMemEvalRunOptions } from "./runner.js";

type LongMemEvalQuestions = Awaited<ReturnType<typeof loadDataset>>;
type LongMemEvalQuestion = LongMemEvalQuestions[number];

export interface LongMemEvalRunContext {
  readonly opts: LongMemEvalRunOptions;
  readonly questions: LongMemEvalQuestions;
  readonly window: readonly LongMemEvalQuestion[];
  readonly alayaVersion: string;
  readonly commitInfo: ReturnType<typeof resolveCommitInfo>;
  readonly commitSha7: string;
  readonly runAt: Date;
  readonly embeddingProviderLabel: string;
  readonly policyShape: NonNullable<LongMemEvalRunOptions["policyShape"]>;
  readonly simulateReport: NonNullable<LongMemEvalRunOptions["simulateReport"]>;
  readonly recallOptions: ReturnType<typeof recallOptionsForPolicyShape>;
  readonly seedRunner: ReturnType<typeof createCompileSeedRunner>;
  readonly captureSnapshot: boolean;
  readonly extractionCacheRoot: string;
  readonly recallWeightOverrides: BenchRecallWeightOverrides | undefined;
  readonly seedDataDirRoot?: string;
  readonly removeSeedDataDirRoot: boolean;
}

export interface LongMemEvalExecutionResult {
  readonly collected: readonly LongMemEvalWorkerResult[];
  readonly questionFailures: number;
  readonly failedQuestionIds: readonly string[];
}

export async function prepareLongMemEvalRun(
  opts: LongMemEvalRunOptions,
  recallWeightOverrides: BenchRecallWeightOverrides | undefined
): Promise<LongMemEvalRunContext> {
  const questions = await loadDataset(opts.variant, {
    dataDir: opts.dataDir,
    pinnedMetaRoot: opts.pinnedMetaRoot
  });
  const commitInfo = resolveCommitInfo();
  const extractionCacheRoot = opts.extractionCacheRoot ?? EXTRACTION_CACHE_ROOT;
  return {
    opts,
    questions,
    window: selectQuestionWindow(questions, opts),
    alayaVersion: resolveBenchRunnerVersion(),
    commitInfo,
    commitSha7: commitInfo.sha7,
    runAt: new Date(),
    embeddingProviderLabel: resolveBenchEmbeddingProviderLabel(
      opts.embeddingMode ?? "disabled",
      process.env,
      opts.embeddingProviderKind ?? "openai"
    ),
    policyShape: opts.policyShape ?? "stress",
    simulateReport: opts.simulateReport ?? "none",
    recallOptions: recallOptionsForPolicyShape(opts.policyShape ?? "stress"),
    seedRunner: createLongMemEvalSeedRunner(
      selectQuestionWindow(questions, opts),
      extractionCacheRoot
    ),
    captureSnapshot: opts.snapshotOut !== undefined,
    extractionCacheRoot,
    recallWeightOverrides,
    ...(await resolveSeedDataDirRoot(opts))
  };
}

export async function executeLongMemEvalRun(
  context: LongMemEvalRunContext
): Promise<LongMemEvalExecutionResult> {
  let daemon: BenchDaemonHandle | undefined;
  const execution = createExecutionState();
  try {
    daemon = await startLongMemEvalDaemon(context);
    await runLongMemEvalWindow(context, daemon, execution);
    await writeLongMemEvalSnapshotIfRequested(context, execution.snapshotQuestions);
    return {
      collected: execution.collected,
      questionFailures: execution.questionFailures,
      failedQuestionIds: execution.failedQuestionIds
    };
  } finally {
    try {
      await daemon?.shutdown();
    } finally {
      await cleanupSeedDataDirRoot(context);
    }
  }
}

function selectQuestionWindow(
  questions: LongMemEvalQuestions,
  opts: LongMemEvalRunOptions
) {
  const offset = Math.max(0, opts.offset ?? 0);
  const sliceEnd = opts.limit !== undefined ? offset + opts.limit : questions.length;
  return questions.slice(offset, sliceEnd);
}

function createLongMemEvalSeedRunner(
  window: readonly LongMemEvalQuestion[],
  extractionCacheRoot: string
) {
  const requiredTurnContents = collectDistinctTurnContents(window);
  return createCompileSeedRunner({
    requiredTurnContents,
    cacheRoot: extractionCacheRoot,
    ...(resolveBenchAllowLiveExtraction() ? { allowLiveExtraction: true } : {})
  });
}

async function resolveSeedDataDirRoot(
  opts: LongMemEvalRunOptions
): Promise<{
  readonly seedDataDirRoot?: string;
  readonly removeSeedDataDirRoot: boolean;
}> {
  if (opts.dataDirRoot !== undefined) {
    return { seedDataDirRoot: opts.dataDirRoot, removeSeedDataDirRoot: false };
  }
  if (opts.snapshotOut === undefined) {
    return { removeSeedDataDirRoot: false };
  }
  return {
    seedDataDirRoot: await mkdtemp(join(tmpdir(), "alaya-bench-seed-")),
    removeSeedDataDirRoot: true
  };
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
): Promise<void> {
  try {
    const result = await runLongMemEvalQuestion({
      daemon,
      question,
      turnIndex: questionIndex + 1,
      seedRunner: context.seedRunner,
      recallOptions: context.recallOptions,
      simulateReport: context.simulateReport,
      embeddingMode: context.opts.embeddingMode ?? "disabled",
      embeddingProviderKind: context.opts.embeddingProviderKind ?? "openai",
      captureSnapshot: context.captureSnapshot,
      ...(context.opts.qa === undefined ? {} : buildQaOptions(context.opts.qa))
    });
    execution.collected.push(result);
    if (context.captureSnapshot && result.snapshotQuestion !== undefined) {
      execution.snapshotQuestions.push(result.snapshotQuestion);
    }
    writeLongMemEvalQuestionProgress(questionIndex, context.window.length, question.question_id, result);
  } catch (error) {
    if (!(error instanceof QaChatError)) throw error;
    execution.questionFailures += 1;
    execution.failedQuestionIds.push(question.question_id);
    writeLongMemEvalQuestionFailure(questionIndex, context.window.length, question.question_id, error);
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
  writeRecallEvalSnapshot({
    snapshotOut: context.opts.snapshotOut,
    seedDataDirRoot: context.seedDataDirRoot,
    variant: context.opts.variant,
    commitSha7: context.commitSha7,
    snapshotQuestions,
    extractionCacheRoot: context.extractionCacheRoot
  });
  process.stdout.write(
    `[longmemeval snapshot] wrote ${snapshotQuestions.length} questions -> ${context.opts.snapshotOut}\n`
  );
}

async function cleanupSeedDataDirRoot(context: LongMemEvalRunContext): Promise<void> {
  if (!context.removeSeedDataDirRoot || context.seedDataDirRoot === undefined) {
    return;
  }
  await rm(context.seedDataDirRoot, { recursive: true, force: true });
}
