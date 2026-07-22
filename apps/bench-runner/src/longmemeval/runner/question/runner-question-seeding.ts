import { createHash } from "node:crypto";
import type {
  BenchEdgeFormationMember,
  BenchWorkspaceHandle
} from "../../../harness/daemon.js";
import { benchSessionSurfacesEnabled } from "../../../harness/daemon/daemon-support.js";
import {
  buildLongMemEvalRoundMessages,
  pairSessionIntoRounds,
  type LongMemEvalQuestion
} from "../../ingestion/dataset.js";
import {
  buildSessionSynthesisInput,
  computeNextTurnSeedRefs,
  type CompileSeedExtractionStats,
  type CompileSeedRunner,
  type SessionSeededTurn
} from "../../compile-seed.js";
import {
  buildLongMemEvalSidecarKey,
  type LongMemEvalSidecarEntry
} from "../runner-helpers.js";
import type { QaChatFn } from "../../qa/qa-chat.js";
import {
  createEmptyLongMemEvalSeedDropReasons,
  type LongMemEvalSeedDropReasons
} from "../../extraction/seed-fuel/seed-drop-reasons.js";
import {
  assertLongMemEvalTimeline,
  requireLongMemEvalTimestamp
} from "../../ingestion/source-time.js";
import type {
  LongMemEvalSnapshotSeedRound
} from "../../snapshot/materialize.js";
import {
  mergeLongMemEvalSourceRounds,
  type LongMemEvalSourceRound
} from "../../provenance/source-rounds.js";
import {
  isVerifiedEmptyAnswerWipe,
  recordAnswerSeedDrops,
  snapshotSeedCounters,
  type SeedCounterSnapshot
} from "./seeding/answer-seed-drop-accounting.js";

export interface LongMemEvalQuestionSeedState {
  readonly sidecar: Map<string, LongMemEvalSidecarEntry>;
  readonly answerSessionSet: Set<string>;
  answerSeedDropReasons: LongMemEvalSeedDropReasons;
  readonly coherenceMembers: BenchEdgeFormationMember[];
  readonly seedRounds: LongMemEvalSnapshotSeedRound[];
  seedTurnsTruncated: number;
  answerTurnsTruncated: number;
  seedCharsClipped: number;
}

export async function seedLongMemEvalQuestion(input: {
  readonly workspace: BenchWorkspaceHandle;
  readonly question: LongMemEvalQuestion;
  readonly seedRunner: CompileSeedRunner;
  readonly qaChat?: QaChatFn;
  readonly seedFormationMode: "treatment_neutral" | "diagnostic_warmup";
}): Promise<LongMemEvalQuestionSeedState> {
  assertLongMemEvalTimeline(input.question);
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
    seedRounds: [],
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
  if (input.seedFormationMode === "diagnostic_warmup") {
    await input.workspace.accrueSessionCoRecall(sessionMemberMemoryIds);
  }
  await seedSessionSynthesis(input.workspace, state, {
    questionId: input.question.question_id,
    sessionIndex,
    sessionId,
    sessionTurns,
    sessionHasAnswer
  });
  return seedIndex;
}

interface SeedRoundContext {
  readonly sessionIndex: number;
  readonly roundIndex: number;
  readonly sessionId: string;
  readonly seedIndex: number;
  readonly previousTurnSeedMemoryIds: readonly string[];
  readonly sessionTurns: SessionSeededTurn[];
  readonly sessionMemberMemoryIds: string[];
}

async function seedQuestionRound(
  input: Parameters<typeof seedLongMemEvalQuestion>[0],
  state: LongMemEvalQuestionSeedState,
  context: SeedRoundContext
): Promise<{ readonly nextTurnSeedMemoryIds: readonly string[] }> {
  const round = pairSessionIntoRounds(input.question.haystack_sessions[context.sessionIndex]!)[context.roundIndex]!;
  const evidenceRef = buildLongMemEvalRoundEvidenceRef(
    input.question.question_id,
    context.sessionIndex,
    context.roundIndex
  );
  const beforeDropReasons = { ...input.seedRunner.stats.signalsDroppedByReason };
  const beforeCounters = snapshotSeedCounters(input.seedRunner.stats);
  const sourceObservedAt = requireLongMemEvalTimestamp(
    input.question.haystack_dates[context.sessionIndex]);
  const seedResult = await input.seedRunner.seedTurn({
    daemon: input.workspace,
    turnContent: round.content,
    turnMessages: buildLongMemEvalRoundMessages(
      input.question.haystack_sessions[context.sessionIndex]!,
      round,
      `${input.question.question_id}-s${context.sessionIndex}-r${context.roundIndex}`
    ),
    evidenceRefBase: evidenceRef,
    seedIndex: context.seedIndex,
    workspaceId: input.workspace.workspaceId,
    runId: input.workspace.runId,
    sourceObservedAt,
    ...(benchSessionSurfacesEnabled() ? { surfaceId: context.sessionId } : {}),
    ...(context.previousTurnSeedMemoryIds.length === 0 ? {} : { sourceMemoryRefs: context.previousTurnSeedMemoryIds })
  });
  recordTruncation(state, seedResult, round.hasAnswer);
  recordAnswerSeedDrops(
    state,
    round.hasAnswer,
    beforeDropReasons,
    input.seedRunner.stats.signalsDroppedByReason,
    isVerifiedEmptyAnswerWipe(input.seedRunner.stats, beforeCounters)
  );
  addSeedSidecarEntries(input, state, context, round, seedResult);
  state.seedRounds.push(buildSeedRoundLedger({
    stats: input.seedRunner.stats,
    before: beforeCounters,
    context,
    round,
    seeds: seedResult.seeds
  }));
  return { nextTurnSeedMemoryIds: computeNextTurnSeedRefs(seedResult) };
}

function buildSeedRoundLedger(input: {
  readonly stats: CompileSeedExtractionStats;
  readonly before: SeedCounterSnapshot;
  readonly context: SeedRoundContext;
  readonly round: ReturnType<typeof pairSessionIntoRounds>[number];
  readonly seeds: Awaited<ReturnType<CompileSeedRunner["seedTurn"]>>["seeds"];
}): LongMemEvalSnapshotSeedRound {
  const official = input.stats.lastExtractionSource !== null;
  return {
    sessionIndex: input.context.sessionIndex,
    roundIndex: input.context.roundIndex,
    sessionId: input.context.sessionId,
    contentSha256: sha256(input.round.content.trim()),
    hasAnswer: input.round.hasAnswer,
    extractionSource: input.stats.lastExtractionSource ?? "fallback",
    cacheKey: official ? input.stats.lastCacheKey ?? null : null,
    rawJsonSha256: official ? input.stats.lastRawJsonSha256 : null,
    rawSignalCount: official ? input.stats.lastTurnRawSignalCount : null,
    draftCount: official ? input.stats.lastTurnDraftCount : null,
    factsProduced: delta(input.stats.factsProduced, input.before.factsProduced),
    parseDropped: delta(input.stats.parseDropped, input.before.parseDropped),
    compileOverflowDropped: delta(
      input.stats.compileOverflowDropped, input.before.compileOverflowDropped
    ),
    candidateAbsent: delta(
      input.stats.signalsDroppedByReason.candidate_absent,
      input.before.candidateAbsent
    ),
    materializationDrop: delta(
      input.stats.signalsDroppedByReason.materialization_drop,
      input.before.materializationDrop
    ),
    memoryObjectIds: uniqueSurvivorSeeds(input.seeds).map(({ seed }) => seed.memoryId),
    memoryBindings: input.seeds.map((seed) => ({
      objectId: seed.memoryId,
      signalId: seed.signalId,
      evidenceId: seed.evidenceId
    }))
  };
}

function delta(after: number, before: number): number {
  if (after < before) {
    throw new Error("seed extraction counters must be monotonic");
  }
  return after - before;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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
  context: SeedRoundContext,
  round: ReturnType<typeof pairSessionIntoRounds>[number],
  seedResult: Awaited<ReturnType<CompileSeedRunner["seedTurn"]>>
): void {
  for (const { seed, seedOrdinal } of uniqueSurvivorSeeds(seedResult.seeds)) {
    addSidecarEntry(state, {
      objectId: seed.memoryId,
      objectKind: "memory_entry",
      sessionId: context.sessionId,
      hasAnswer: round.hasAnswer,
      sourceRounds: [sourceRound(context, round)],
      ...optionalSeedContent(input, context.sessionIndex, round.content)
    });
    context.sessionTurns.push({ turnContent: round.content, evidenceId: seed.evidenceId });
    if (!context.sessionMemberMemoryIds.includes(seed.memoryId)) {
      context.sessionMemberMemoryIds.push(seed.memoryId);
    }
    if (!state.coherenceMembers.some((member) => member.memoryId === seed.memoryId)) {
      state.coherenceMembers.push({
        memoryId: seed.memoryId,
        sessionId: context.sessionId,
        formationKey: buildBenchFormationKey(context, seedOrdinal)
      });
    }
  }
}

type SeededTurnMemory = Awaited<ReturnType<CompileSeedRunner["seedTurn"]>>["seeds"][number];

function uniqueSurvivorSeeds(
  seeds: readonly SeededTurnMemory[]
): readonly { readonly seed: SeededTurnMemory; readonly seedOrdinal: number }[] {
  const survivors = new Map<string, { seed: SeededTurnMemory; seedOrdinal: number }>();
  for (const [seedOrdinal, seed] of seeds.entries()) {
    const prior = survivors.get(seed.memoryId);
    if (prior === undefined || (prior.seed.evidenceId === null && seed.evidenceId !== null)) {
      survivors.set(seed.memoryId, { seed, seedOrdinal: prior?.seedOrdinal ?? seedOrdinal });
    }
  }
  return [...survivors.values()];
}

function buildBenchFormationKey(
  context: Pick<SeedRoundContext, "sessionId" | "sessionIndex" | "roundIndex">,
  seedOrdinal: number
): string {
  // Fixed-width ordinals preserve numeric formation order under the core's
  // opaque lexical-key comparison, including sessions with 10+ rounds.
  const ordinal = (value: number) => String(value).padStart(12, "0");
  return JSON.stringify([
    ordinal(context.sessionIndex),
    ordinal(context.roundIndex),
    ordinal(seedOrdinal),
    context.sessionId
  ]);
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
  addSidecarEntry(state, {
    objectId: synthesisResult.synthesisId,
    objectKind: "synthesis_capsule",
    sessionId: input.sessionId,
    hasAnswer: input.sessionHasAnswer,
    content: synthesisInput.summary
  });
}

function addSidecarEntry(
  state: LongMemEvalQuestionSeedState,
  entry: LongMemEvalSidecarEntry
): void {
  const key = buildLongMemEvalSidecarKey(entry.objectKind, entry.objectId);
  const prior = state.sidecar.get(key);
  if (prior === undefined) {
    state.sidecar.set(key, entry);
    return;
  }
  if (entry.objectKind !== "memory_entry" || prior.objectKind !== "memory_entry") {
    throw new Error(`duplicate LongMemEval sidecar object identity ${key}`);
  }
  const sources = mergeLongMemEvalSourceRounds(
    requireSourceRounds(prior),
    requireSourceRounds(entry)
  );
  state.sidecar.set(key, {
    ...prior,
    sourceRounds: sources
  });
}

function sourceRound(
  context: Pick<SeedRoundContext, "sessionIndex" | "roundIndex" | "sessionId">,
  round: ReturnType<typeof pairSessionIntoRounds>[number]
): LongMemEvalSourceRound {
  return {
    sessionIndex: context.sessionIndex,
    roundIndex: context.roundIndex,
    sessionId: context.sessionId,
    hasAnswer: round.hasAnswer
  };
}

function requireSourceRounds(entry: LongMemEvalSidecarEntry): readonly LongMemEvalSourceRound[] {
  if (entry.sourceRounds === undefined || entry.sourceRounds.length === 0) {
    throw new Error("current LongMemEval memory sidecar requires source rounds");
  }
  return entry.sourceRounds;
}

export interface LongMemEvalSeedRoundIdentity {
  readonly sessionIndex: number;
  readonly roundIndex: number;
  readonly sessionId: string;
  readonly hasAnswer: boolean;
}

export function buildLongMemEvalRoundEvidenceRef(
  questionId: string,
  sessionIndex: number,
  roundIndex: number
): string {
  return `${questionId}-s${sessionIndex}-r${roundIndex}`;
}

export function resolveLongMemEvalSeedRoundIdentity(
  value: unknown,
  question: LongMemEvalQuestion
): LongMemEvalSeedRoundIdentity {
  const prefix = `${question.question_id}-s`;
  if (typeof value !== "string" || !value.startsWith(prefix)) {
    throw new Error("legacy sidecar evidence round identity mismatch");
  }
  const match = /^(\d+)-r(\d+)(?:-f\d+)?$/u.exec(value.slice(prefix.length));
  const sessionIndex = Number(match?.[1]);
  const roundIndex = Number(match?.[2]);
  if (match === null || match[1] !== String(sessionIndex) ||
      match[2] !== String(roundIndex)) {
    throw new Error("legacy sidecar evidence round identity mismatch");
  }
  const sessionId = question.haystack_session_ids[sessionIndex];
  const session = question.haystack_sessions[sessionIndex];
  const round = session === undefined ? undefined : pairSessionIntoRounds(session)[roundIndex];
  if (sessionId === undefined || round === undefined) {
    throw new Error("legacy sidecar evidence round identity mismatch");
  }
  return { sessionIndex, roundIndex, sessionId, hasAnswer: round.hasAnswer };
}

export function resolveLongMemEvalSeedSessionIndex(
  value: unknown,
  question: LongMemEvalQuestion
): number {
  const prefix = `${question.question_id}-s`;
  const ordinal = typeof value === "string" && value.startsWith(prefix)
    ? value.slice(prefix.length)
    : "";
  const sessionIndex = Number(ordinal);
  if (!/^\d+$/u.test(ordinal) || ordinal !== String(sessionIndex) ||
      question.haystack_sessions[sessionIndex] === undefined ||
      question.haystack_session_ids[sessionIndex] === undefined) {
    throw new Error("legacy sidecar synthesis session identity mismatch");
  }
  return sessionIndex;
}
