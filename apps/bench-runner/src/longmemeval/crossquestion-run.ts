import {
  startBenchDaemon,
  type BenchTokenMetrics
} from "../harness/daemon.js";
import { DEFAULT_BENCH_EMBEDDING_PROVIDER_KIND } from "../harness/daemon-types.js";
import { aggregateBenchTokenMetrics } from "../harness/token-economy.js";
import { resolveBenchRunnerVersion } from "../shared/version.js";
import type { LongMemEvalQuestion } from "./dataset.js";
import { loadDataset } from "./fetch.js";
import {
  createCompileSeedRunner,
  EXTRACTION_CACHE_ROOT,
  resolveBenchAllowLiveExtraction,
  type CompileSeedExtractionStats,
  type CompileSeedRunner
} from "./compile-seed.js";
import { EmbeddingReadinessTracker } from "./embedding-readiness.js";
import { runLongMemEvalCrossQuestionItem } from "./crossquestion-question.js";
import { resolveBenchEmbeddingProviderLabel } from "./runner.js";
import { resolveCommitInfo } from "./runner-helpers.js";
import type {
  LongMemEvalCrossQuestionRunOptions,
  QuestionResult,
  SidecarEntry
} from "./crossquestion.js";

export interface CrossQuestionRunContext {
  readonly opts: LongMemEvalCrossQuestionRunOptions;
  readonly questions: readonly LongMemEvalQuestion[];
  readonly window: readonly LongMemEvalQuestion[];
  readonly alayaVersion: string;
  readonly commitInfo: ReturnType<typeof resolveCommitInfo>;
  readonly commitSha7: string;
  readonly runAt: Date;
  readonly embeddingProviderLabel: string;
  readonly seedRunner: CompileSeedRunner;
}

export interface CrossQuestionExecutionResult {
  readonly collected: readonly QuestionResult[];
  readonly tokenEconomyInput: BenchTokenMetrics;
  readonly seedStats: CompileSeedExtractionStats;
}

export async function prepareCrossQuestionRun(
  opts: LongMemEvalCrossQuestionRunOptions
): Promise<CrossQuestionRunContext> {
  const questions = await loadDataset(opts.variant, {
    dataDir: opts.dataDir,
    pinnedMetaRoot: opts.pinnedMetaRoot
  });
  const embeddingMode = opts.embeddingMode ?? "disabled";
  const commitInfo = resolveCommitInfo();
  return {
    opts,
    questions,
    window: selectQuestionWindow(questions, opts),
    alayaVersion: resolveBenchRunnerVersion(),
    commitInfo,
    commitSha7: commitInfo.sha7,
    runAt: new Date(),
    embeddingProviderLabel: resolveBenchEmbeddingProviderLabel(
      embeddingMode, process.env, opts.embeddingProviderKind
    ),
    seedRunner: createCrossQuestionSeedRunner(opts)
  };
}

export async function executeCrossQuestionRun(
  context: CrossQuestionRunContext
): Promise<CrossQuestionExecutionResult> {
  const daemon = await startBenchDaemon({
    workspaceId: `lme-cq-shared-${context.commitSha7}`,
    runId: `run-cq-${context.commitSha7}-${context.runAt.getTime()}`,
    embeddingMode: context.opts.embeddingMode ?? "disabled",
    embeddingProviderKind: context.opts.embeddingProviderKind ??
      DEFAULT_BENCH_EMBEDDING_PROVIDER_KIND
  });
  const sidecar = new Map<string, SidecarEntry>();
  const collected: QuestionResult[] = [];
  let tokenEconomyInput: BenchTokenMetrics = aggregateBenchTokenMetrics([]);
  const embeddingReadiness = new EmbeddingReadinessTracker();
  try {
    await runQuestionWindow(context, daemon, sidecar, collected, embeddingReadiness);
    embeddingReadiness.finalize();
    writeCrossQuestionSeedStats(context.seedRunner.stats);
    tokenEconomyInput = await daemon.queryTokenMetrics();
  } finally {
    await daemon.shutdown();
  }
  return { collected, tokenEconomyInput, seedStats: context.seedRunner.stats };
}

function selectQuestionWindow(
  questions: readonly LongMemEvalQuestion[],
  opts: LongMemEvalCrossQuestionRunOptions
): readonly LongMemEvalQuestion[] {
  const offset = Math.max(0, opts.offset ?? 0);
  const sliceEnd = opts.limit !== undefined ? offset + opts.limit : questions.length;
  return questions.slice(offset, sliceEnd);
}

function createCrossQuestionSeedRunner(
  opts: LongMemEvalCrossQuestionRunOptions
): CompileSeedRunner {
  return createCompileSeedRunner({
    cacheRoot: opts.extractionCacheRoot ?? EXTRACTION_CACHE_ROOT,
    ...(resolveBenchAllowLiveExtraction() ? { allowLiveExtraction: true } : {})
  });
}

async function runQuestionWindow(
  context: CrossQuestionRunContext,
  daemon: Awaited<ReturnType<typeof startBenchDaemon>>,
  sidecar: Map<string, SidecarEntry>,
  collected: QuestionResult[],
  embeddingReadiness: EmbeddingReadinessTracker
): Promise<void> {
  for (let qi = 0; qi < context.window.length; qi += 1) {
    const question = context.window[qi];
    if (question === undefined) continue;
    const result = await runLongMemEvalCrossQuestionItem({
      question,
      questionIndex: qi,
      opts: context.opts,
      daemon,
      sidecar,
      seedRunner: context.seedRunner,
      embeddingReadiness
    });
    collected.push(result);
    writeCrossQuestionProgress(
      qi,
      context.window.length,
      question.question_id,
      result,
      sidecar.size
    );
  }
}

function writeCrossQuestionProgress(
  questionIndex: number,
  totalQuestions: number,
  questionId: string,
  result: QuestionResult,
  poolSize: number
): void {
  process.stdout.write(
    `[${questionIndex + 1}/${totalQuestions}] ${questionId.slice(0, 8)} ` +
      `R@5=${result.hitAt5 ? "✓" : "✗"} pool=${poolSize}\n`
  );
}

function writeCrossQuestionSeedStats(stats: CompileSeedExtractionStats): void {
  process.stdout.write(
    `[longmemeval compile-seed] path=${stats.path} ` +
      `cache_hits=${stats.cacheHits} ` +
      `llm_calls=${stats.llmCalls} ` +
      `offline_fallbacks=${stats.offlineFallbacks} ` +
      `facts=${stats.factsProduced} ` +
      `signals_dropped=${stats.signalsDropped}\n`
  );
}
