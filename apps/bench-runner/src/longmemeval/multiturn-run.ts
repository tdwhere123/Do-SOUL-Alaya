import { resolveBenchRunnerVersion } from "../shared/version.js";
import { EmbeddingReadinessTracker } from "./embedding-readiness.js";
import { loadDataset } from "./fetch.js";
import {
  createCompileSeedRunner,
  EXTRACTION_CACHE_ROOT,
  resolveBenchAllowLiveExtraction
} from "./compile-seed.js";
import { runLongMemEvalMultiturnQuestion } from "./multiturn-question.js";
import { resolveBenchEmbeddingProviderLabel, resolveCommitInfo } from "./runner-helpers.js";
import type {
  LongMemEvalMultiturnRunOptions,
  QuestionResult
} from "./multiturn.js";

type LongMemEvalQuestions = Awaited<ReturnType<typeof loadDataset>>;
type LongMemEvalQuestion = LongMemEvalQuestions[number];

export interface MultiturnRunContext {
  readonly opts: LongMemEvalMultiturnRunOptions;
  readonly questions: LongMemEvalQuestions;
  readonly window: readonly LongMemEvalQuestion[];
  readonly rounds: number;
  readonly alayaVersion: string;
  readonly commitInfo: ReturnType<typeof resolveCommitInfo>;
  readonly commitSha7: string;
  readonly runAt: Date;
  readonly embeddingProviderLabel: string;
  readonly seedRunner: ReturnType<typeof createCompileSeedRunner>;
}

export interface MultiturnExecutionResult {
  readonly collected: readonly QuestionResult[];
}

export async function prepareMultiturnRun(
  opts: LongMemEvalMultiturnRunOptions
): Promise<MultiturnRunContext> {
  const questions = await loadDataset(opts.variant, {
    dataDir: opts.dataDir,
    pinnedMetaRoot: opts.pinnedMetaRoot
  });
  const commitInfo = resolveCommitInfo();
  const window = selectQuestionWindow(questions, opts);
  return {
    opts,
    questions,
    window,
    rounds: Math.max(1, opts.rounds ?? 3),
    alayaVersion: resolveBenchRunnerVersion(),
    commitInfo,
    commitSha7: commitInfo.sha7,
    runAt: new Date(),
    embeddingProviderLabel: resolveBenchEmbeddingProviderLabel(
      opts.embeddingMode ?? "disabled", process.env, opts.embeddingProviderKind
    ),
    seedRunner: createMultiturnSeedRunner(opts.extractionCacheRoot ?? EXTRACTION_CACHE_ROOT)
  };
}

export async function executeMultiturnRun(
  context: MultiturnRunContext
): Promise<MultiturnExecutionResult> {
  const collected: QuestionResult[] = [];
  const embeddingReadiness = new EmbeddingReadinessTracker();
  for (let i = 0; i < context.window.length; i += 1) {
    const question = context.window[i];
    if (question === undefined) continue;
    const result = await runLongMemEvalMultiturnQuestion({
      question,
      opts: context.opts,
      rounds: context.rounds,
      seedRunner: context.seedRunner,
      embeddingReadiness
    });
    collected.push(result);
    writeMultiturnProgress(i, context.window.length, question.question_id, result, context.rounds);
  }
  embeddingReadiness.finalize();
  writeMultiturnSeedStats(context.seedRunner.stats);
  return { collected };
}

function selectQuestionWindow(
  questions: LongMemEvalQuestions,
  opts: LongMemEvalMultiturnRunOptions
): readonly LongMemEvalQuestion[] {
  const filtered = filterQuestionsByIdEnv(questions);
  const offset = Math.max(0, opts.offset ?? 0);
  const sliceEnd = opts.limit !== undefined ? offset + opts.limit : filtered.length;
  return filtered.slice(offset, sliceEnd);
}

// ALAYA_BENCH_QUESTION_IDS: seed only these question_ids (applied before offset/limit); unset = no-op.
function filterQuestionsByIdEnv(
  questions: LongMemEvalQuestions
): readonly LongMemEvalQuestion[] {
  const raw = process.env.ALAYA_BENCH_QUESTION_IDS?.trim();
  if (raw === undefined || raw.length === 0) {
    return questions;
  }
  const ids = new Set(raw.split(",").map((value) => value.trim()).filter(Boolean));
  return questions.filter((question) => ids.has(question.question_id));
}

function createMultiturnSeedRunner(extractionCacheRoot: string) {
  return createCompileSeedRunner({
    cacheRoot: extractionCacheRoot,
    ...(resolveBenchAllowLiveExtraction() ? { allowLiveExtraction: true } : {})
  });
}

function writeMultiturnProgress(
  questionIndex: number,
  totalQuestions: number,
  questionId: string,
  result: QuestionResult,
  rounds: number
): void {
  const finalRound = result.rounds[result.rounds.length - 1];
  process.stdout.write(
    `[${questionIndex + 1}/${totalQuestions}] ${questionId.slice(0, 8)} ` +
      `rounds=${rounds} final_R@5=${finalRound?.hitAt5 ? "✓" : "✗"}\n`
  );
}

function writeMultiturnSeedStats(
  stats: ReturnType<typeof createCompileSeedRunner>["stats"]
): void {
  process.stdout.write(
    `[longmemeval compile-seed] path=${stats.path} ` +
      `cache_hits=${stats.cacheHits} ` +
      `llm_calls=${stats.llmCalls} ` +
      `offline_fallbacks=${stats.offlineFallbacks} ` +
      `facts=${stats.factsProduced} ` +
      `signals_dropped=${stats.signalsDropped}\n`
  );
}
