import type { BenchDaemonHandle, BenchWorkspaceHandle } from "../harness/daemon.js";
import type { BenchTokenMetrics } from "../harness/token-metrics.js";
import type { BenchRecallTokenEconomy } from "../harness/recall-diagnostics-schema.js";
import type { EdgeProposalKpiEventRow } from "@do-soul/alaya-eval";
import { buildQuestionDiagnostic, type LongMemEvalQuestionDiagnostic, type LongMemEvalReportSideEffectSnapshot } from "./diagnostics.js";
import { isAbstentionQuestionId } from "./abstention.js";
import type { LongMemEvalQuestion } from "./dataset.js";
import { extractRecallTokenEconomy } from "./recall-token-economy.js";
import { scoreLongMemEvalQaIfRequested } from "./runner-question-delivery.js";
import {
  readLongMemEvalReportSideEffectSnapshot,
  resolveLongMemEvalHitVerdict,
  type LongMemEvalBenchRecallResult,
  type LongMemEvalRecallCycleResult,
  type LongMemEvalSidecarEntry
} from "./runner-helpers.js";
import type { QaQuestionVerdict } from "./qa-harness.js";
import type { QaChatFn } from "./qa-chat.js";
import type { LongMemEvalQuestionSeedState } from "./runner-question-seeding.js";
import { writeQuestionDiagnosticDumps } from "./runner-question-dumps.js";
import type { LongMemEvalWorkerResult } from "./runner-question.js";
import { hasLongMemEvalSeedDropReasons } from "./seed-drop-reasons.js";

export async function buildLongMemEvalQuestionResult(input: {
  readonly daemon: BenchDaemonHandle;
  readonly workspace: BenchWorkspaceHandle;
  readonly question: LongMemEvalQuestion;
  readonly seedState: LongMemEvalQuestionSeedState;
  readonly goldMemoryIds: readonly string[];
  readonly recallCycle: LongMemEvalRecallCycleResult;
  readonly embeddingWarmup: LongMemEvalWorkerResult["embeddingWarmup"];
  readonly queryEmbeddingWarmup: LongMemEvalWorkerResult["queryEmbeddingWarmup"];
  readonly captureSnapshot: boolean;
  readonly qaChat?: QaChatFn;
  readonly qaJudgeChat?: QaChatFn;
  readonly embeddingMode: "disabled" | "env";
}): Promise<LongMemEvalWorkerResult> {
  writeQuestionDiagnosticDumps({
    question: input.question,
    goldMemoryIds: input.goldMemoryIds,
    sidecar: input.seedState.sidecar,
    recallResult: input.recallCycle.scoredRecallResult
  });
  const scored = await scoreQuestion(input);
  const kpi = await collectQuestionKpi(input);
  return assembleWorkerResult(input, scored, kpi);
}

async function scoreQuestion(input: Parameters<typeof buildLongMemEvalQuestionResult>[0]) {
  const recallResult = input.recallCycle.scoredRecallResult;
  const isAbstention = isAbstentionQuestionId(input.question.question_id);
  const qaVerdict = await scoreLongMemEvalQaIfRequested({
    question: input.question,
    qaChat: input.qaChat,
    qaJudgeChat: input.qaJudgeChat,
    isAbstention,
    results: recallResult.results,
    goldMemoryIds: input.goldMemoryIds,
    sidecar: input.seedState.sidecar
  });
  const hits = resolveLongMemEvalHitVerdict({
    isAbstention,
    results: recallResult.results,
    sidecar: input.seedState.sidecar,
    answerSessionIds: input.seedState.answerSessionSet
  });
  return { isAbstention, qaVerdict, hits, diagnostics: buildDiagnostics(input, isAbstention, hits) };
}

function buildDiagnostics(
  input: Parameters<typeof buildLongMemEvalQuestionResult>[0],
  isAbstention: boolean,
  hits: ReturnType<typeof resolveLongMemEvalHitVerdict>
): LongMemEvalQuestionDiagnostic {
  const recallResult = input.recallCycle.scoredRecallResult;
  return buildQuestionDiagnostic({
    questionId: input.question.question_id,
    questionType: input.question.question_type,
    goldMemoryIds: input.goldMemoryIds,
    answerSessionIds: input.question.answer_session_ids,
    deliveredResults: deliveredResults(recallResult),
    activeConstraintResults: activeConstraintResults(recallResult),
    hitAt1: hits.hitAt1,
    hitAt5: hits.hitAt5,
    hitAt10: hits.hitAt10,
    isAbstention,
    degradationReason: recallResult.degradation_reason ?? null,
    recallResult,
    embeddingMode: input.embeddingMode,
    seedDropReasons: input.seedState.answerSeedDropReasons
  });
}

function deliveredResults(recallResult: LongMemEvalBenchRecallResult) {
  return recallResult.results.slice(0, 10).map((pointer, index) => ({
    object_id: pointer.object_id,
    object_kind: pointer.object_kind,
    rank: index + 1,
    relevance_score: pointer.relevance_score,
    score_factors: pointer.score_factors ?? null
  }));
}

function activeConstraintResults(recallResult: LongMemEvalBenchRecallResult) {
  return (recallResult.active_constraints ?? []).map((constraint, index) => ({
    object_id: constraint.object_id,
    rank: index + 1
  }));
}

async function collectQuestionKpi(input: Parameters<typeof buildLongMemEvalQuestionResult>[0]): Promise<{
  readonly reportSideEffectSnapshot: LongMemEvalReportSideEffectSnapshot;
  readonly tokenMetrics: BenchTokenMetrics;
  readonly recallTokenEconomy: BenchRecallTokenEconomy | null;
  readonly edgeProposalKpiRows: readonly EdgeProposalKpiEventRow[];
}> {
  const reportSideEffectSnapshot = await readLongMemEvalReportSideEffectSnapshot(
    input.question.question_id,
    input.daemon,
    input.workspace.workspaceId
  );
  return {
    reportSideEffectSnapshot,
    tokenMetrics: await input.workspace.queryTokenMetrics(),
    recallTokenEconomy: extractRecallTokenEconomy(input.recallCycle.scoredRecallResult),
    edgeProposalKpiRows: await input.workspace.queryEdgeProposalKpiRows()
  };
}

function assembleWorkerResult(
  input: Parameters<typeof buildLongMemEvalQuestionResult>[0],
  scored: {
    readonly qaVerdict?: QaQuestionVerdict;
    readonly hits: ReturnType<typeof resolveLongMemEvalHitVerdict>;
    readonly diagnostics: LongMemEvalQuestionDiagnostic;
  },
  kpi: Awaited<ReturnType<typeof collectQuestionKpi>>
): LongMemEvalWorkerResult {
  return {
    questionId: input.question.question_id,
    hitAt1: scored.hits.hitAt1,
    hitAt5: scored.hits.hitAt5,
    hitAt10: scored.hits.hitAt10,
    firstTier: scored.hits.firstTier,
    latencyMs: input.recallCycle.scoredRecallLatencyMs,
    degradationReason: input.recallCycle.scoredRecallResult.degradation_reason ?? null,
    seedTurnsTruncated: input.seedState.seedTurnsTruncated,
    answerTurnsTruncated: input.seedState.answerTurnsTruncated,
    seedCharsClipped: input.seedState.seedCharsClipped,
    diagnostics: scored.diagnostics,
    embeddingWarmup: input.embeddingWarmup,
    queryEmbeddingWarmup: input.queryEmbeddingWarmup,
    reportUsageStats: input.recallCycle.reportUsageStats,
    reportSideEffectSnapshot: kpi.reportSideEffectSnapshot,
    tokenMetrics: kpi.tokenMetrics,
    recallTokenEconomy: kpi.recallTokenEconomy,
    edgeProposalKpiRows: kpi.edgeProposalKpiRows,
    ...(scored.qaVerdict === undefined ? {} : { qaVerdict: scored.qaVerdict }),
    ...snapshotQuestionField(input)
  };
}

function snapshotQuestionField(
  input: Parameters<typeof buildLongMemEvalQuestionResult>[0]
): Pick<LongMemEvalWorkerResult, "snapshotQuestion"> | Record<string, never> {
  if (!input.captureSnapshot) return {};
  return {
    snapshotQuestion: {
      questionId: input.question.question_id,
      question: input.question.question,
      answerSessionIds: [...input.question.answer_session_ids],
      workspaceId: input.workspace.workspaceId,
      runId: input.workspace.runId,
      sidecar: [...input.seedState.sidecar.values()].map(snapshotSidecarEntry),
      ...(hasLongMemEvalSeedDropReasons(input.seedState.answerSeedDropReasons)
        ? { answerSeedDropReasons: { ...input.seedState.answerSeedDropReasons } }
        : {})
    }
  };
}

function snapshotSidecarEntry(entry: LongMemEvalSidecarEntry) {
  return {
    objectId: entry.objectId,
    objectKind: entry.objectKind,
    sessionId: entry.sessionId,
    hasAnswer: entry.hasAnswer
  };
}
