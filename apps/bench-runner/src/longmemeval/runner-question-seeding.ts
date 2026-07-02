import type {
  BenchWorkspaceHandle
} from "../harness/daemon.js";
import { benchSessionSurfacesEnabled } from "../harness/daemon-support.js";
import { pairSessionIntoRounds, type LongMemEvalQuestion } from "./dataset.js";
import {
  buildSessionSynthesisInput,
  computeNextTurnSeedRefs,
  type CompileSeedRunner,
  type SessionSeededTurn
} from "./compile-seed.js";
import {
  buildLongMemEvalSidecarKey,
  type LongMemEvalSidecarEntry
} from "./runner-helpers.js";
import type { QaChatFn } from "./qa-chat.js";
import {
  createEmptyLongMemEvalSeedDropReasons,
  type LongMemEvalSeedDropReasons
} from "./seed-drop-reasons.js";

export interface LongMemEvalQuestionSeedState {
  readonly sidecar: Map<string, LongMemEvalSidecarEntry>;
  readonly answerSessionSet: Set<string>;
  answerSeedDropReasons: LongMemEvalSeedDropReasons;
  readonly coherenceMembers: { readonly memoryId: string; readonly sessionId: string }[];
  seedTurnsTruncated: number;
  answerTurnsTruncated: number;
  seedCharsClipped: number;
}

export async function seedLongMemEvalQuestion(input: {
  readonly workspace: BenchWorkspaceHandle;
  readonly question: LongMemEvalQuestion;
  readonly seedRunner: CompileSeedRunner;
  readonly qaChat?: QaChatFn;
}): Promise<LongMemEvalQuestionSeedState> {
  const state = createSeedState(input.question);
  let seedIndex = 0;
  for (let si = 0; si < input.question.haystack_sessions.length; si++) {
    const session = input.question.haystack_sessions[si];
    if (session === undefined) continue;
    seedIndex = await seedQuestionSession(input, state, si, seedIndex);
  }
  return state;
}

function createSeedState(question: LongMemEvalQuestion): LongMemEvalQuestionSeedState {
  return {
    sidecar: new Map(),
    answerSessionSet: new Set(question.answer_session_ids),
    answerSeedDropReasons: createEmptyLongMemEvalSeedDropReasons(),
    coherenceMembers: [],
    seedTurnsTruncated: 0,
    answerTurnsTruncated: 0,
    seedCharsClipped: 0
  };
}

async function seedQuestionSession(
  input: Parameters<typeof seedLongMemEvalQuestion>[0],
  state: LongMemEvalQuestionSeedState,
  sessionIndex: number,
  seedIndex: number
): Promise<number> {
  const session = input.question.haystack_sessions[sessionIndex];
  if (session === undefined) return seedIndex;
  const sessionId = input.question.haystack_session_ids[sessionIndex] ?? `session-${sessionIndex}`;
  const sessionTurns: SessionSeededTurn[] = [];
  const sessionMemberMemoryIds: string[] = [];
  let sessionHasAnswer = false;
  let previousTurnSeedMemoryIds: readonly string[] = [];
  for (let ri = 0; ri < pairSessionIntoRounds(session).length; ri++) {
    const round = pairSessionIntoRounds(session)[ri];
    if (round === undefined) continue;
    const result = await seedQuestionRound(input, state, {
      sessionIndex,
      roundIndex: ri,
      sessionId,
      seedIndex,
      previousTurnSeedMemoryIds,
      sessionTurns,
      sessionMemberMemoryIds
    });
    seedIndex += 1;
    sessionHasAnswer = sessionHasAnswer || round.hasAnswer;
    previousTurnSeedMemoryIds = result.nextTurnSeedMemoryIds;
  }
  await input.workspace.accrueSessionCoRecall(sessionMemberMemoryIds);
  await seedSessionSynthesis(input.workspace, state, {
    questionId: input.question.question_id,
    sessionIndex,
    sessionId,
    sessionTurns,
    sessionHasAnswer
  });
  return seedIndex;
}

async function seedQuestionRound(
  input: Parameters<typeof seedLongMemEvalQuestion>[0],
  state: LongMemEvalQuestionSeedState,
  context: {
    readonly sessionIndex: number;
    readonly roundIndex: number;
    readonly sessionId: string;
    readonly seedIndex: number;
    readonly previousTurnSeedMemoryIds: readonly string[];
    readonly sessionTurns: SessionSeededTurn[];
    readonly sessionMemberMemoryIds: string[];
  }
): Promise<{ readonly nextTurnSeedMemoryIds: readonly string[] }> {
  const round = pairSessionIntoRounds(input.question.haystack_sessions[context.sessionIndex]!)[context.roundIndex]!;
  const evidenceRef = `${input.question.question_id}-s${context.sessionIndex}-r${context.roundIndex}`;
  const beforeDropReasons = {
    ...input.seedRunner.stats.signalsDroppedByReason
  };
  const seedResult = await input.seedRunner.seedTurn({
    daemon: input.workspace,
    turnContent: round.content,
    evidenceRefBase: evidenceRef,
    seedIndex: context.seedIndex,
    workspaceId: input.workspace.workspaceId,
    runId: input.workspace.runId,
    ...(benchSessionSurfacesEnabled() ? { surfaceId: context.sessionId } : {}),
    ...(context.previousTurnSeedMemoryIds.length === 0 ? {} : { sourceMemoryRefs: context.previousTurnSeedMemoryIds })
  });
  recordTruncation(state, seedResult, round.hasAnswer);
  recordAnswerSeedDrops(
    state,
    round.hasAnswer,
    beforeDropReasons,
    input.seedRunner.stats.signalsDroppedByReason
  );
  addSeedSidecarEntries(input, state, context, round, seedResult);
  return { nextTurnSeedMemoryIds: computeNextTurnSeedRefs(seedResult) };
}

function recordAnswerSeedDrops(
  state: LongMemEvalQuestionSeedState,
  roundHasAnswer: boolean,
  before: Readonly<Record<keyof LongMemEvalSeedDropReasons, number>>,
  after: Readonly<Record<keyof LongMemEvalSeedDropReasons, number>>
): void {
  if (!roundHasAnswer) {
    return;
  }
  state.answerSeedDropReasons = {
    candidate_absent:
      state.answerSeedDropReasons.candidate_absent +
      Math.max(0, after.candidate_absent - before.candidate_absent),
    materialization_drop:
      state.answerSeedDropReasons.materialization_drop +
      Math.max(0, after.materialization_drop - before.materialization_drop)
  };
}

function recordTruncation(
  state: LongMemEvalQuestionSeedState,
  seedResult: Awaited<ReturnType<CompileSeedRunner["seedTurn"]>>,
  roundHasAnswer: boolean
): void {
  if (!seedResult.turnTruncated) return;
  state.seedTurnsTruncated += 1;
  state.seedCharsClipped += seedResult.charsClipped;
  if (roundHasAnswer) state.answerTurnsTruncated += 1;
}

function addSeedSidecarEntries(
  input: Parameters<typeof seedLongMemEvalQuestion>[0],
  state: LongMemEvalQuestionSeedState,
  context: Parameters<typeof seedQuestionRound>[2],
  round: ReturnType<typeof pairSessionIntoRounds>[number],
  seedResult: Awaited<ReturnType<CompileSeedRunner["seedTurn"]>>
): void {
  for (const seed of seedResult.seeds) {
    state.sidecar.set(buildLongMemEvalSidecarKey("memory_entry", seed.memoryId), {
      objectId: seed.memoryId,
      objectKind: "memory_entry",
      sessionId: context.sessionId,
      hasAnswer: round.hasAnswer,
      ...optionalSeedContent(input, context.sessionIndex, round.content)
    });
    context.sessionTurns.push({ turnContent: round.content, evidenceId: seed.evidenceId });
    context.sessionMemberMemoryIds.push(seed.memoryId);
    state.coherenceMembers.push({ memoryId: seed.memoryId, sessionId: context.sessionId });
  }
}

function optionalSeedContent(
  input: Parameters<typeof seedLongMemEvalQuestion>[0],
  sessionIndex: number,
  content: string
): Partial<LongMemEvalSidecarEntry> {
  if (input.qaChat === undefined && process.env.ALAYA_BENCH_POOL_DUMP === undefined) {
    return {};
  }
  return {
    content,
    ...(input.question.haystack_dates[sessionIndex] === undefined
      ? {}
      : { eventDate: input.question.haystack_dates[sessionIndex] })
  };
}

async function seedSessionSynthesis(
  workspace: BenchWorkspaceHandle,
  state: LongMemEvalQuestionSeedState,
  input: {
    readonly questionId: string;
    readonly sessionIndex: number;
    readonly sessionId: string;
    readonly sessionTurns: readonly SessionSeededTurn[];
    readonly sessionHasAnswer: boolean;
  }
): Promise<void> {
  const synthesisInput = buildSessionSynthesisInput({
    topicKey: `${input.questionId}-s${input.sessionIndex}`,
    turns: input.sessionTurns
  });
  if (synthesisInput === null) return;
  const synthesisResult = await workspace.proposeSynthesis(synthesisInput);
  if (synthesisResult.synthesisId === null) return;
  state.sidecar.set(
    buildLongMemEvalSidecarKey("synthesis_capsule", synthesisResult.synthesisId),
    {
      objectId: synthesisResult.synthesisId,
      objectKind: "synthesis_capsule",
      sessionId: input.sessionId,
      hasAnswer: input.sessionHasAnswer,
      content: synthesisInput.summary
    }
  );
}
