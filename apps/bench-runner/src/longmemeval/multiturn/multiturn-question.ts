import { monotonicElapsedMs, monotonicNowNs } from "../../shared/monotonic.js";
import { startBenchDaemon } from "../../harness/daemon.js";
import { DEFAULT_BENCH_EMBEDDING_PROVIDER_KIND } from "../../harness/daemon/daemon-types.js";
import { extractRecallTokenEconomy } from "../qa/recall-token-economy.js";
import { buildQuestionDiagnostic } from "../diagnostics.js";
import { isAbstentionQuestionId } from "../diagnostics/abstention.js";
import {
  pairSessionIntoRounds,
  type LongMemEvalQuestion,
  type LongMemEvalTurn
} from "../ingestion/dataset.js";
import {
  buildSessionSynthesisInput,
  computeNextTurnSeedRefs,
  type CompileSeedRunner,
  type SessionSeededTurn
} from "../compile-seed.js";
import { runEmbeddingReadinessPass, type EmbeddingReadinessTracker } from "../provenance/embedding/embedding-readiness.js";
import {
  buildLongMemEvalSidecarKey,
  deriveLongMemEvalGoldMemoryIds,
  resolveLongMemEvalHitVerdict,
  type LongMemEvalSidecarEntry
} from "../runner/runner-helpers.js";
import {
  buildDeliveredResults,
  buildGoldUsageReport,
  collectDeliveredGoldObjectIds
} from "../qa/question-recall-support.js";
import type {
  LongMemEvalMultiturnRunOptions,
  QuestionResult,
  RoundResult,
  SidecarEntry
} from "../multiturn.js";
import { requireLongMemEvalTimestamp } from "../ingestion/source-time.js";

interface MultiturnQuestionState {
  readonly sidecar: Map<string, SidecarEntry>;
  readonly answerSessionSet: Set<string>;
  seedTurnsTruncated: number;
  answerTurnsTruncated: number;
  seedCharsClipped: number;
  seedIndex: number;
}

export async function runLongMemEvalMultiturnQuestion(input: {
  readonly question: LongMemEvalQuestion;
  readonly opts: LongMemEvalMultiturnRunOptions;
  readonly rounds: number;
  readonly seedRunner: CompileSeedRunner;
  readonly embeddingReadiness: EmbeddingReadinessTracker;
}): Promise<QuestionResult> {
  const daemon = await startBenchDaemon({
    workspaceId: `lme-mt-${input.question.question_id.slice(0, 8)}`,
    runId: `run-mt-${input.question.question_id.slice(0, 8)}`,
    embeddingMode: input.opts.embeddingMode ?? "disabled",
    embeddingProviderKind: input.opts.embeddingProviderKind ??
      DEFAULT_BENCH_EMBEDDING_PROVIDER_KIND
  });
  try {
    const state = createMultiturnQuestionState(input.question);
    await seedMultiturnQuestion(daemon, input, state);
    await runMultiturnReadinessPasses(daemon, input);
    const rounds = await runMultiturnRounds(daemon, input, state);
    return {
      questionId: input.question.question_id,
      rounds,
      seedTurnsTruncated: state.seedTurnsTruncated,
      answerTurnsTruncated: state.answerTurnsTruncated,
      seedCharsClipped: state.seedCharsClipped,
      tokenMetrics: await daemon.queryTokenMetrics()
    };
  } finally {
    await daemon.shutdown();
  }
}

function createMultiturnQuestionState(
  question: LongMemEvalQuestion
): MultiturnQuestionState {
  return {
    sidecar: new Map(),
    answerSessionSet: new Set(question.answer_session_ids),
    seedTurnsTruncated: 0,
    answerTurnsTruncated: 0,
    seedCharsClipped: 0,
    seedIndex: 0
  };
}

async function seedMultiturnQuestion(
  daemon: Awaited<ReturnType<typeof startBenchDaemon>>,
  input: Parameters<typeof runLongMemEvalMultiturnQuestion>[0],
  state: MultiturnQuestionState
): Promise<void> {
  for (let sessionIndex = 0; sessionIndex < input.question.haystack_sessions.length; sessionIndex += 1) {
    const session = input.question.haystack_sessions[sessionIndex];
    if (session === undefined) continue;
    await seedMultiturnSession(daemon, input, state, sessionIndex, session);
  }
}

async function seedMultiturnSession(
  daemon: Awaited<ReturnType<typeof startBenchDaemon>>,
  input: Parameters<typeof runLongMemEvalMultiturnQuestion>[0],
  state: MultiturnQuestionState,
  sessionIndex: number,
  session: readonly LongMemEvalTurn[]
): Promise<void> {
  const sessionId = input.question.haystack_session_ids[sessionIndex] ?? `session-${sessionIndex}`;
  const sessionTurns: SessionSeededTurn[] = [];
  const rounds = pairSessionIntoRounds(session);
  let sessionHasAnswer = false;
  let previousTurnSeedMemoryIds: readonly string[] = [];
  for (let roundIndex = 0; roundIndex < rounds.length; roundIndex += 1) {
    const round = rounds[roundIndex];
    if (round === undefined) continue;
    previousTurnSeedMemoryIds = await seedMultiturnRound(
      daemon,
      input,
      state,
      sessionIndex,
      roundIndex,
      sessionId,
      round,
      sessionTurns,
      previousTurnSeedMemoryIds
    );
    sessionHasAnswer = sessionHasAnswer || round.hasAnswer;
  }
  await seedMultiturnSynthesis(daemon, input.question.question_id, sessionIndex, sessionId, sessionTurns, sessionHasAnswer, state.sidecar);
}

async function seedMultiturnRound(
  daemon: Awaited<ReturnType<typeof startBenchDaemon>>,
  input: Parameters<typeof runLongMemEvalMultiturnQuestion>[0],
  state: MultiturnQuestionState,
  sessionIndex: number,
  roundIndex: number,
  sessionId: string,
  round: ReturnType<typeof pairSessionIntoRounds>[number],
  sessionTurns: SessionSeededTurn[],
  previousTurnSeedMemoryIds: readonly string[]
): Promise<readonly string[]> {
  const seedResult = await input.seedRunner.seedTurn({
    daemon,
    turnContent: round.content,
    evidenceRefBase: `${input.question.question_id}-mt-s${sessionIndex}-r${roundIndex}`,
    seedIndex: state.seedIndex,
    workspaceId: daemon.workspaceId,
    runId: daemon.runId,
    ...(previousTurnSeedMemoryIds.length === 0
      ? {}
      : { sourceMemoryRefs: previousTurnSeedMemoryIds })
  });
  state.seedIndex += 1;
  recordMultiturnTruncation(state, seedResult, round.hasAnswer);
  addMultiturnSeedEntries(state.sidecar, sessionId, round.content, round.hasAnswer, sessionTurns, seedResult);
  return computeNextTurnSeedRefs(seedResult);
}

function recordMultiturnTruncation(
  state: MultiturnQuestionState,
  seedResult: Awaited<ReturnType<CompileSeedRunner["seedTurn"]>>,
  roundHasAnswer: boolean
): void {
  if (!seedResult.turnTruncated) return;
  state.seedTurnsTruncated += 1;
  state.seedCharsClipped += seedResult.charsClipped;
  if (roundHasAnswer) {
    state.answerTurnsTruncated += 1;
  }
}

function addMultiturnSeedEntries(
  sidecar: Map<string, LongMemEvalSidecarEntry>,
  sessionId: string,
  turnContent: string,
  hasAnswer: boolean,
  sessionTurns: SessionSeededTurn[],
  seedResult: Awaited<ReturnType<CompileSeedRunner["seedTurn"]>>
): void {
  for (const seed of seedResult.seeds) {
    sidecar.set(buildLongMemEvalSidecarKey("memory_entry", seed.memoryId), {
      objectId: seed.memoryId,
      objectKind: "memory_entry",
      sessionId,
      hasAnswer
    });
    sessionTurns.push({ turnContent, evidenceId: seed.evidenceId });
  }
}

async function seedMultiturnSynthesis(
  daemon: Awaited<ReturnType<typeof startBenchDaemon>>,
  questionId: string,
  sessionIndex: number,
  sessionId: string,
  sessionTurns: readonly SessionSeededTurn[],
  sessionHasAnswer: boolean,
  sidecar: Map<string, LongMemEvalSidecarEntry>
): Promise<void> {
  const synthesisInput = buildSessionSynthesisInput({
    topicKey: `${questionId}-mt-s${sessionIndex}`,
    turns: sessionTurns
  });
  if (synthesisInput === null) return;
  const synthesisResult = await daemon.proposeSynthesis(synthesisInput);
  if (synthesisResult.synthesisId === null) return;
  sidecar.set(buildLongMemEvalSidecarKey("synthesis_capsule", synthesisResult.synthesisId), {
    objectId: synthesisResult.synthesisId,
    objectKind: "synthesis_capsule",
    sessionId,
    hasAnswer: sessionHasAnswer
  });
}

async function runMultiturnReadinessPasses(
  daemon: Awaited<ReturnType<typeof startBenchDaemon>>,
  input: Parameters<typeof runLongMemEvalMultiturnQuestion>[0]
): Promise<void> {
  await maybeRunMultiturnEmbeddingReadiness(daemon, input);
  await daemon.runEdgePlanePassIfConfigured();
}

async function maybeRunMultiturnEmbeddingReadiness(
  daemon: Awaited<ReturnType<typeof startBenchDaemon>>,
  input: Parameters<typeof runLongMemEvalMultiturnQuestion>[0]
): Promise<void> {
  if (input.opts.embeddingMode !== "env") return;
  input.embeddingReadiness.record(
    await runEmbeddingReadinessPass({
      runPass: () => daemon.runtime.runGardenEmbeddingBackfillPass(daemon.workspaceId),
      workspaceId: daemon.workspaceId,
      questionId: input.question.question_id
    })
  );
}

async function runMultiturnRounds(
  daemon: Awaited<ReturnType<typeof startBenchDaemon>>,
  input: Parameters<typeof runLongMemEvalMultiturnQuestion>[0],
  state: MultiturnQuestionState
): Promise<readonly RoundResult[]> {
  const goldMemoryIds = deriveLongMemEvalGoldMemoryIds(state.sidecar, state.answerSessionSet);
  const rounds: RoundResult[] = [];
  for (let roundIndex = 1; roundIndex <= input.rounds; roundIndex += 1) {
    rounds.push(
      await runMultiturnRecallRound(daemon, input.question, roundIndex, state.sidecar, state.answerSessionSet, goldMemoryIds, input.opts.embeddingMode ?? "disabled")
    );
  }
  return rounds;
}

async function runMultiturnRecallRound(
  daemon: Awaited<ReturnType<typeof startBenchDaemon>>,
  question: LongMemEvalQuestion,
  roundIndex: number,
  sidecar: ReadonlyMap<string, LongMemEvalSidecarEntry>,
  answerSessionSet: ReadonlySet<string>,
  goldMemoryIds: readonly string[],
  embeddingMode: NonNullable<LongMemEvalMultiturnRunOptions["embeddingMode"]>
): Promise<RoundResult> {
  const recallStart = monotonicNowNs();
  const recallResult = await daemon.recall(question.question, {
    maxResults: 10,
    referenceTime: requireLongMemEvalTimestamp(question.question_date)
  });
  const recallOutcome = resolveMultiturnRecallOutcome(
    question,
    roundIndex,
    recallResult,
    sidecar,
    answerSessionSet
  );
  await daemon.reportContextUsage(recallOutcome.reportInput);
  return buildMultiturnRoundResult(
    question,
    roundIndex,
    recallResult,
    recallOutcome,
    goldMemoryIds,
    embeddingMode,
    monotonicElapsedMs(recallStart)
  );
}

function resolveMultiturnRecallOutcome(
  question: LongMemEvalQuestion,
  roundIndex: number,
  recallResult: Awaited<ReturnType<Awaited<ReturnType<typeof startBenchDaemon>>["recall"]>>,
  sidecar: ReadonlyMap<string, LongMemEvalSidecarEntry>,
  answerSessionSet: ReadonlySet<string>
) {
  const usedGoldObjectIds = collectDeliveredGoldObjectIds({
    results: recallResult.results,
    sidecar,
    answerSessionIds: answerSessionSet
  });
  return {
    deliveredResults: buildDeliveredResults(recallResult.results),
    verdict: resolveLongMemEvalHitVerdict({
      isAbstention: isAbstentionQuestionId(question.question_id),
      results: recallResult.results,
      sidecar,
      answerSessionIds: answerSessionSet
    }),
    reportInput: buildGoldUsageReport({
      deliveryId: recallResult.delivery_id,
      results: recallResult.results,
      usedGoldObjectIds,
      turnIndex: roundIndex,
      questionText: question.question,
      successReason: `LongMemEval multi-turn round ${roundIndex}: gold pointer delivered.`,
      failureReason: `LongMemEval multi-turn round ${roundIndex}: gold pointer not delivered.`
    })
  };
}

function buildMultiturnRoundResult(
  question: LongMemEvalQuestion,
  roundIndex: number,
  recallResult: Awaited<ReturnType<Awaited<ReturnType<typeof startBenchDaemon>>["recall"]>>,
  recallOutcome: ReturnType<typeof resolveMultiturnRecallOutcome>,
  goldMemoryIds: readonly string[],
  embeddingMode: NonNullable<LongMemEvalMultiturnRunOptions["embeddingMode"]>,
  latencyMs: number
): RoundResult {
  return {
    roundIndex,
    hitAt1: recallOutcome.verdict.hitAt1,
    hitAt5: recallOutcome.verdict.hitAt5,
    hitAt10: recallOutcome.verdict.hitAt10,
    firstTier: recallOutcome.verdict.firstTier,
    latencyMs,
    degradationReason: recallResult.degradation_reason ?? null,
    diagnostics: buildQuestionDiagnostic({
      questionId: question.question_id,
      questionType: question.question_type,
      roundIndex,
      goldMemoryIds,
      answerSessionIds: question.answer_session_ids,
      deliveredResults: recallOutcome.deliveredResults,
      hitAt1: recallOutcome.verdict.hitAt1,
      hitAt5: recallOutcome.verdict.hitAt5,
      hitAt10: recallOutcome.verdict.hitAt10,
      isAbstention: isAbstentionQuestionId(question.question_id),
      degradationReason: recallResult.degradation_reason ?? null,
      recallResult,
      embeddingMode
    }),
    recallTokenEconomy: extractRecallTokenEconomy(recallResult)
  };
}
