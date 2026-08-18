import type {
  EffectiveReconciliationBasis,
  ReconciliationBasisStatus
} from "@do-soul/alaya";
import {
  startBenchDaemon,
  type BenchDaemonHandle
} from "../../harness/daemon.js";
import { DEFAULT_BENCH_EMBEDDING_PROVIDER_KIND } from "../../harness/daemon/daemon-types.js";
import { collectBenchSeedFuelInventory } from "../../bench/extraction/seed-fuel/seed-fuel-collector.js";
import { toSeedExtractionPathKpi } from "../../bench/compile-seed.js";
import { QaChatError } from "../../bench/qa/qa-chat.js";
import { selectionContractIdentity } from "../../bench/selection/contract.js";
import { writeRecallEvalSnapshot } from "./runner-helpers.js";
import {
  prepareLongMemEvalSnapshotQuestion,
  runLongMemEvalQuestion,
  type LongMemEvalQuestionRunInput,
  type LongMemEvalWorkerResult
} from "./question/runner-question.js";
import type { LongMemEvalQuestion } from "../ingestion/dataset.js";
import type { LongMemEvalSnapshotQuestion } from "../../bench/snapshot/materialize.js";
import type { LongMemEvalRunOptions } from "../runner.js";
import { finalizeOwnedTempRoot } from "../../bench/lifecycle/owned-temp-root.js";
import { buildLongMemEvalRunProvenance } from "../../bench/provenance/run.js";
import { throwLifecycleErrors } from "../../bench/lifecycle/errors.js";
import { runIsolatedQuestionSequence } from "../../bench/lifecycle/question-isolated-execution.js";
import type { LongMemEvalRunContext } from "./prepare-context.js";
import {
  emptySeedFuelInventory,
  mergeSeedFuelInventories,
  type SeedFuelInventory
} from "../../bench/extraction/seed-fuel/seed-fuel-inventory.js";
import { awaitLongMemEvalSnapshotQuiescence } from
  "../../bench/snapshot/quiescence.js";
import { inspectTurnContentKeySpace } from
  "../../bench/extraction/turn-contents.js";
import { assertCurrentPostFillCacheAuthorityProof } from
  "../../bench/snapshot/current/current-substrate-authority.js";
import { assertSnapshotProducerStaticPolicy } from
  "./policy/snapshot-producer-policy.js";

export interface LongMemEvalExecutionResult {
  readonly collected: readonly LongMemEvalWorkerResult[];
  readonly questionFailures: number;
  readonly failedQuestionIds: readonly string[];
  readonly reconciliationBasis?: EffectiveReconciliationBasis;
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
    assertSnapshotProducerExecutionPolicy(context);
    daemon = await startObservedLongMemEvalDaemon(context, execution);
    result = await runSnapshotCompatiblePhases(context, daemon, execution);
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

async function runSnapshotCompatiblePhases(
  context: LongMemEvalRunContext,
  daemon: BenchDaemonHandle,
  execution: ReturnType<typeof createExecutionState>
): Promise<LongMemEvalExecutionResult> {
  // Snapshot producer is materialize-only: scores come from recall-eval /
  // matrix cells on the sealed DB, not a stress/embedding-off A-like pass.
  const prepared = await prepareSnapshotWindow(context, daemon);
  await awaitLongMemEvalSnapshotQuiescence();
  await daemon.checkpointFieldProjection();
  await daemon.checkpointRelationProjection();
  await writeLongMemEvalSnapshotIfRequested(
    context,
    prepared,
    enabledReconciliationBasis(execution.reconciliationBasisStatus)
  );
  return buildExecutionResult(execution, emptySeedFuelInventory());
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
      retainSuccessfulRoots: context.opts.materializeQuestionDbs === true,
      initialAggregate: emptySeedFuelInventory(),
      mergeAggregate: (aggregate, inventory) =>
        mergeSeedFuelInventories([aggregate, inventory]),
      start: async (root) => startObservedLongMemEvalDaemon({
        ...context,
        seedDataDirRoot: root.path,
        removeSeedDataDirRoot: false
      }, execution),
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
    ...(enabledReconciliationBasis(execution.reconciliationBasisStatus) === undefined
      ? {}
      : { reconciliationBasis: enabledReconciliationBasis(execution.reconciliationBasisStatus) }),
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
  questionFailures: number;
  readonly failedQuestionIds: string[];
  reconciliationBasisStatus?: ReconciliationBasisStatus;
} {
  return {
    collected: [],
    questionFailures: 0,
    failedQuestionIds: []
  };
}

async function startObservedLongMemEvalDaemon(
  context: LongMemEvalRunContext,
  execution: ReturnType<typeof createExecutionState>
): Promise<BenchDaemonHandle> {
  const daemon = await startLongMemEvalDaemon(context);
  try {
    observeReconciliationBasis(execution, daemon);
    return daemon;
  } catch (error) {
    await daemon.shutdown();
    throw error;
  }
}

function observeReconciliationBasis(
  execution: ReturnType<typeof createExecutionState>,
  daemon: BenchDaemonHandle
): void {
  const observed = daemon.runtime.services.reconciliationBasisStatus;
  const previous = execution.reconciliationBasisStatus;
  if (previous !== undefined && !sameReconciliationStatus(previous, observed)) {
    throw new Error("reconciliation basis changed across isolated daemons");
  }
  execution.reconciliationBasisStatus = observed;
}

function sameReconciliationStatus(
  left: ReconciliationBasisStatus,
  right: ReconciliationBasisStatus
): boolean {
  if (left.enabled !== right.enabled) return false;
  return !left.enabled || (right.enabled && left.basis === right.basis);
}

function enabledReconciliationBasis(
  status: ReconciliationBasisStatus | undefined
): EffectiveReconciliationBasis | undefined {
  return status?.enabled === true ? status.basis : undefined;
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
    recallWeightOverrides: context.recallWeightOverrides,
    ...(context.captureSnapshot
      ? {
          relationProjectionAdmissionMode: "explicit_checkpoint" as const,
          fieldProjectionAdmissionMode: "explicit_checkpoint" as const
        }
      : {}),
    ...(context.opts.expectedReconciliationBasis === undefined
      ? {}
      : { expectedReconciliationBasis: context.opts.expectedReconciliationBasis })
  });
}

async function prepareSnapshotWindow(
  context: LongMemEvalRunContext,
  daemon: BenchDaemonHandle
): Promise<readonly LongMemEvalSnapshotQuestion[]> {
  const prepared: LongMemEvalSnapshotQuestion[] = [];
  const totalQuestions = context.window.length;
  for (let i = 0; i < totalQuestions; i += 1) {
    const question = context.window[i];
    if (question === undefined) continue;
    const value = await prepareLongMemEvalSnapshotQuestion(
      buildQuestionRunInput(context, daemon, i, question)
    );
    prepared.push(value);
    writeLongMemEvalSeedProgress(i, totalQuestions, question.question_id);
  }
  return prepared;
}

async function runLongMemEvalQuestionSafely(
  context: LongMemEvalRunContext,
  daemon: BenchDaemonHandle,
  execution: ReturnType<typeof createExecutionState>,
  questionIndex: number,
  question: LongMemEvalQuestion
): Promise<boolean> {
  return collectLongMemEvalQuestionSafely(
    context,
    execution,
    questionIndex,
    question,
    () => runLongMemEvalQuestion(
      buildQuestionRunInput(context, daemon, questionIndex, question)
    )
  );
}

async function collectLongMemEvalQuestionSafely(
  context: LongMemEvalRunContext,
  execution: ReturnType<typeof createExecutionState>,
  questionIndex: number,
  question: LongMemEvalQuestion,
  run: () => Promise<LongMemEvalWorkerResult>
): Promise<boolean> {
  try {
    const result = await run();
    const diagnostics = await context.diagnosticsSpool.append(result.diagnostics);
    execution.collected.push({ ...result, diagnostics });
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

function buildQuestionRunInput(
  context: LongMemEvalRunContext,
  daemon: BenchDaemonHandle,
  questionIndex: number,
  question: LongMemEvalQuestion
): LongMemEvalQuestionRunInput {
  return {
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
    seedFormationMode: context.captureSnapshot || context.opts.materializeQuestionDbs === true
      ? "treatment_neutral"
      : "diagnostic_warmup",
    ...(context.opts.qa === undefined ? {} : buildQaOptions(context.opts.qa))
  };
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

function assertSnapshotProducerExecutionPolicy(context: LongMemEvalRunContext): void {
  assertSnapshotProducerStaticPolicy(context, process.env);
  const proof = requireSnapshotPreflightProof(context);
  const requiredTurns = inspectTurnContentKeySpace(context.window);
  assertCurrentPostFillCacheAuthorityProof({
    proof,
    cacheRoot: context.extractionCacheRoot,
    datasetSha256: context.datasetSha256,
    requiredTurnContents: requiredTurns.distinctTurnContents,
    requiredExtractionTurns: requiredTurns.distinctExtractionTurns,
    requiredQuestionWindow: {
      offset: Math.max(0, context.opts.offset ?? 0),
      limit: context.window.length
    },
    env: process.env
  });
}

function writeLongMemEvalSeedProgress(
  questionIndex: number,
  totalQuestions: number,
  questionId: string
): void {
  process.stdout.write(
    `[${questionIndex + 1}/${totalQuestions}] ${questionId.slice(0, 8)} seeded\n`
  );
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
  snapshotQuestions: readonly LongMemEvalSnapshotQuestion[],
  reconciliationBasis: EffectiveReconciliationBasis | undefined
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
    selection: selectionContractIdentity(context.selectionContract),
    ...(context.seedRunner.semanticSupplementBinding === undefined
      ? {}
      : { semanticSupplement: context.seedRunner.semanticSupplementBinding }),
    ...(reconciliationBasis === undefined ? {} : { reconciliationBasis })
  });
  await writeRecallEvalSnapshot({
    snapshotOut: context.opts.snapshotOut,
    seedDataDirRoot: context.seedDataDirRoot,
    variant: context.opts.variant,
    commitSha7: context.commitSha7,
    canonicalQuestions: context.questions,
    snapshotQuestions,
    extractionCacheRoot: context.extractionCacheRoot,
    extractionCachePreflightProof: requireSnapshotPreflightProof(context),
    datasetSha256: context.datasetSha256,
    seedExtractionPath: toSeedExtractionPathKpi(context.seedRunner.stats),
    ...(context.seedRunner.semanticSupplementBinding === undefined
      ? {}
      : { semanticSupplementBinding: context.seedRunner.semanticSupplementBinding }),
    runProvenance
  });
  process.stdout.write(
    `[longmemeval snapshot] wrote ${snapshotQuestions.length} questions -> ${context.opts.snapshotOut}\n`
  );
}

function requireSnapshotPreflightProof(context: LongMemEvalRunContext) {
  const proof = context.seedRunner.extractionCachePreflightProof;
  if (proof === undefined) {
    throw new Error("snapshot production requires a verified cache preflight proof");
  }
  return proof;
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
