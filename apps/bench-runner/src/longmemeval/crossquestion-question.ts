import { monotonicElapsedMs, monotonicNowNs } from "../shared/monotonic.js";
import type { BenchDaemonHandle } from "../harness/daemon.js";
import { extractRecallTokenEconomy } from "./recall-token-economy.js";
import { buildQuestionDiagnostic } from "./diagnostics.js";
import { isAbstentionQuestionId } from "./abstention.js";
import {
  pairSessionIntoRounds,
  type LongMemEvalQuestion,
  type LongMemEvalTurn
} from "./dataset.js";
import { computeNextTurnSeedRefs, type CompileSeedRunner } from "./compile-seed.js";
import { runEmbeddingReadinessPass, type EmbeddingReadinessTracker } from "./embedding-readiness.js";
import {
  buildLongMemEvalSidecarKey,
  resolveLongMemEvalHitVerdict,
  type LongMemEvalSidecarEntry
} from "./runner-helpers.js";
import {
  buildDeliveredResults,
  buildGoldUsageReport,
  collectDeliveredGoldObjectIds
} from "./question-recall-support.js";
import type {
  LongMemEvalCrossQuestionRunOptions,
  QuestionResult,
  SidecarEntry
} from "./crossquestion.js";

interface CrossQuestionSeedStats {
  seedTurnsTruncated: number;
  answerTurnsTruncated: number;
  seedCharsClipped: number;
  seedIndex: number;
}

export async function runLongMemEvalCrossQuestionItem(input: {
  readonly question: LongMemEvalQuestion;
  readonly questionIndex: number;
  readonly opts: LongMemEvalCrossQuestionRunOptions;
  readonly daemon: BenchDaemonHandle;
  readonly sidecar: Map<string, SidecarEntry>;
  readonly seedRunner: CompileSeedRunner;
  readonly embeddingReadiness: EmbeddingReadinessTracker;
}): Promise<QuestionResult> {
  const stats = createCrossQuestionSeedStats();
  await seedCrossQuestion(input, stats);
  await runCrossQuestionReadiness(input);
  return runCrossQuestionRecall(input, stats);
}

function createCrossQuestionSeedStats(): CrossQuestionSeedStats {
  return {
    seedTurnsTruncated: 0,
    answerTurnsTruncated: 0,
    seedCharsClipped: 0,
    seedIndex: 0
  };
}

async function seedCrossQuestion(
  input: Parameters<typeof runLongMemEvalCrossQuestionItem>[0],
  stats: CrossQuestionSeedStats
): Promise<void> {
  for (let sessionIndex = 0; sessionIndex < input.question.haystack_sessions.length; sessionIndex += 1) {
    const session = input.question.haystack_sessions[sessionIndex];
    if (session === undefined) continue;
    await seedCrossQuestionSession(input, stats, sessionIndex, session);
  }
}

async function seedCrossQuestionSession(
  input: Parameters<typeof runLongMemEvalCrossQuestionItem>[0],
  stats: CrossQuestionSeedStats,
  sessionIndex: number,
  session: readonly LongMemEvalTurn[]
): Promise<void> {
  const sessionId =
    input.question.haystack_session_ids[sessionIndex] ??
    `${input.question.question_id}-session-${sessionIndex}`;
  const rounds = pairSessionIntoRounds(session);
  let previousTurnSeedMemoryIds: readonly string[] = [];
  for (let roundIndex = 0; roundIndex < rounds.length; roundIndex += 1) {
    const round = rounds[roundIndex];
    if (round === undefined) continue;
    previousTurnSeedMemoryIds = await seedCrossQuestionRound(
      input,
      stats,
      sessionIndex,
      roundIndex,
      sessionId,
      round,
      previousTurnSeedMemoryIds
    );
  }
}

async function seedCrossQuestionRound(
  input: Parameters<typeof runLongMemEvalCrossQuestionItem>[0],
  stats: CrossQuestionSeedStats,
  sessionIndex: number,
  roundIndex: number,
  sessionId: string,
  round: ReturnType<typeof pairSessionIntoRounds>[number],
  previousTurnSeedMemoryIds: readonly string[]
): Promise<readonly string[]> {
  const seedResult = await input.seedRunner.seedTurn({
    daemon: input.daemon,
    turnContent: round.content,
    evidenceRefBase: `${input.question.question_id}-cq-s${sessionIndex}-r${roundIndex}`,
    seedIndex: stats.seedIndex,
    workspaceId: input.daemon.workspaceId,
    runId: input.daemon.runId,
    ...(previousTurnSeedMemoryIds.length === 0
      ? {}
      : { sourceMemoryRefs: previousTurnSeedMemoryIds })
  });
  stats.seedIndex += 1;
  recordCrossQuestionTruncation(stats, seedResult, round.hasAnswer);
  addCrossQuestionSeedEntries(input.sidecar, input.question.question_id, sessionId, round.hasAnswer, seedResult);
  return computeNextTurnSeedRefs(seedResult);
}

function recordCrossQuestionTruncation(
  stats: CrossQuestionSeedStats,
  seedResult: Awaited<ReturnType<CompileSeedRunner["seedTurn"]>>,
  roundHasAnswer: boolean
): void {
  if (!seedResult.turnTruncated) return;
  stats.seedTurnsTruncated += 1;
  stats.seedCharsClipped += seedResult.charsClipped;
  if (roundHasAnswer) {
    stats.answerTurnsTruncated += 1;
  }
}

function addCrossQuestionSeedEntries(
  sidecar: Map<string, SidecarEntry>,
  questionId: string,
  sessionId: string,
  hasAnswer: boolean,
  seedResult: Awaited<ReturnType<CompileSeedRunner["seedTurn"]>>
): void {
  for (const seed of seedResult.seeds) {
    sidecar.set(seed.memoryId, { questionId, sessionId, hasAnswer });
  }
}

async function runCrossQuestionReadiness(
  input: Parameters<typeof runLongMemEvalCrossQuestionItem>[0]
): Promise<void> {
  await maybeRunCrossQuestionEmbeddingReadiness(input);
  await input.daemon.runEdgePlanePassIfConfigured();
}

async function maybeRunCrossQuestionEmbeddingReadiness(
  input: Parameters<typeof runLongMemEvalCrossQuestionItem>[0]
): Promise<void> {
  if (input.opts.embeddingMode !== "env") return;
  input.embeddingReadiness.record(
    await runEmbeddingReadinessPass({
      runPass: () => input.daemon.runtime.runGardenEmbeddingBackfillPass(input.daemon.workspaceId),
      workspaceId: input.daemon.workspaceId,
      questionId: input.question.question_id
    })
  );
}

async function runCrossQuestionRecall(
  input: Parameters<typeof runLongMemEvalCrossQuestionItem>[0],
  stats: CrossQuestionSeedStats
): Promise<QuestionResult> {
  const scoreSidecar = buildCrossQuestionScoreSidecar(input.sidecar, input.question.question_id);
  const answerSessionSet = new Set(input.question.answer_session_ids);
  const goldMemoryIds = collectCrossQuestionGoldMemoryIds(input.sidecar, input.question.question_id, answerSessionSet);
  const recallStart = monotonicNowNs();
  const recallResult = await input.daemon.recall(input.question.question, { maxResults: 10 });
  const recallOutcome = resolveCrossQuestionRecallOutcome(
    input,
    recallResult,
    scoreSidecar,
    answerSessionSet
  );
  await input.daemon.reportContextUsage(recallOutcome.reportInput);
  return buildCrossQuestionResult(
    input,
    stats,
    recallResult,
    recallOutcome,
    goldMemoryIds,
    monotonicElapsedMs(recallStart)
  );
}

function resolveCrossQuestionRecallOutcome(
  input: Parameters<typeof runLongMemEvalCrossQuestionItem>[0],
  recallResult: Awaited<ReturnType<BenchDaemonHandle["recall"]>>,
  scoreSidecar: ReadonlyMap<string, LongMemEvalSidecarEntry>,
  answerSessionSet: ReadonlySet<string>
) {
  const usedGoldObjectIds = collectDeliveredGoldObjectIds({
    results: recallResult.results,
    sidecar: scoreSidecar,
    answerSessionIds: answerSessionSet
  });
  return {
    verdict: resolveLongMemEvalHitVerdict({
      isAbstention: isAbstentionQuestionId(input.question.question_id),
      results: recallResult.results,
      sidecar: scoreSidecar,
      answerSessionIds: answerSessionSet
    }),
    deliveredResults: buildDeliveredResults(recallResult.results),
    reportInput: buildGoldUsageReport({
      deliveryId: recallResult.delivery_id,
      results: recallResult.results,
      usedGoldObjectIds,
      turnIndex: input.questionIndex + 1,
      questionText: input.question.question,
      successReason: `LongMemEval cross-question #${input.questionIndex + 1}: gold pointer delivered.`,
      failureReason: `LongMemEval cross-question #${input.questionIndex + 1}: gold pointer not delivered.`
    })
  };
}

function buildCrossQuestionResult(
  input: Parameters<typeof runLongMemEvalCrossQuestionItem>[0],
  stats: CrossQuestionSeedStats,
  recallResult: Awaited<ReturnType<BenchDaemonHandle["recall"]>>,
  recallOutcome: ReturnType<typeof resolveCrossQuestionRecallOutcome>,
  goldMemoryIds: readonly string[],
  latencyMs: number
): QuestionResult {
  return {
    questionId: input.question.question_id,
    questionIndex: input.questionIndex + 1,
    hitAt1: recallOutcome.verdict.hitAt1,
    hitAt5: recallOutcome.verdict.hitAt5,
    hitAt10: recallOutcome.verdict.hitAt10,
    firstTier: recallOutcome.verdict.firstTier,
    latencyMs,
    degradationReason: recallResult.degradation_reason ?? null,
    seedTurnsTruncated: stats.seedTurnsTruncated,
    answerTurnsTruncated: stats.answerTurnsTruncated,
    seedCharsClipped: stats.seedCharsClipped,
    diagnostics: buildQuestionDiagnostic({
      questionId: input.question.question_id,
      goldMemoryIds,
      answerSessionIds: input.question.answer_session_ids,
      deliveredResults: recallOutcome.deliveredResults,
      hitAt1: recallOutcome.verdict.hitAt1,
      hitAt5: recallOutcome.verdict.hitAt5,
      hitAt10: recallOutcome.verdict.hitAt10,
      isAbstention: isAbstentionQuestionId(input.question.question_id),
      degradationReason: recallResult.degradation_reason ?? null,
      recallResult,
      embeddingMode: input.opts.embeddingMode ?? "disabled"
    }),
    recallTokenEconomy: extractRecallTokenEconomy(recallResult)
  };
}

function buildCrossQuestionScoreSidecar(
  sidecar: ReadonlyMap<string, SidecarEntry>,
  questionId: string
): Map<string, LongMemEvalSidecarEntry> {
  const scoreSidecar = new Map<string, LongMemEvalSidecarEntry>();
  for (const [memoryId, meta] of sidecar.entries()) {
    if (meta.questionId !== questionId) continue;
    scoreSidecar.set(buildLongMemEvalSidecarKey("memory_entry", memoryId), {
      objectId: memoryId,
      objectKind: "memory_entry",
      sessionId: meta.sessionId,
      hasAnswer: meta.hasAnswer
    });
  }
  return scoreSidecar;
}

function collectCrossQuestionGoldMemoryIds(
  sidecar: ReadonlyMap<string, SidecarEntry>,
  questionId: string,
  answerSessionSet: ReadonlySet<string>
): readonly string[] {
  return [...sidecar.entries()]
    .filter(
      ([, meta]) =>
        meta.questionId === questionId &&
        meta.hasAnswer &&
        answerSessionSet.has(meta.sessionId)
    )
    .map(([memoryId]) => memoryId);
}
