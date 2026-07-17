import {
  benchSessionSurfacesEnabled
} from "../harness/daemon/daemon-support.js";
import type { BenchWorkspaceHandle } from "../harness/daemon.js";
import {
  computeNextTurnSeedRefs,
  type CompileSeedRunner
} from "../longmemeval/compile-seed.js";
import { extractSessions, type LocomoSample, type LocomoTurn } from "./dataset.js";
import { buildLocomoSeedContent } from "./runner-utils.js";

export interface LocomoSeededConversation {
  readonly diaIdByMemoryId: ReadonlyMap<string, string>;
  readonly memoryIdsByDiaId: ReadonlyMap<string, readonly string[]>;
  readonly contentByMemoryId: ReadonlyMap<string, string>;
  readonly dateByMemoryId: ReadonlyMap<string, string | null>;
  readonly sessionByMemoryId: ReadonlyMap<string, string>;
  readonly allSeededMemoryIds: readonly string[];
  readonly conversationNowDate: string;
}

interface MutableLocomoSeededConversation {
  readonly diaIdByMemoryId: Map<string, string>;
  readonly memoryIdsByDiaId: Map<string, string[]>;
  readonly contentByMemoryId: Map<string, string>;
  readonly dateByMemoryId: Map<string, string | null>;
  readonly sessionByMemoryId: Map<string, string>;
}

export async function seedLocomoConversation(input: {
  readonly workspace: BenchWorkspaceHandle;
  readonly seedRunner: CompileSeedRunner;
  readonly conversation: LocomoSample;
}): Promise<LocomoSeededConversation> {
  const seeded = createMutableLocomoSeededConversation();
  const sessions = extractSessions(input.conversation.conversation);
  let seedIndex = 0;
  for (let sessionOrdinal = 0; sessionOrdinal < sessions.length; sessionOrdinal += 1) {
    const session = sessions[sessionOrdinal];
    if (session === undefined) continue;
    seedIndex = await seedLocomoSession({
      ...input,
      seeded,
      session,
      sessionOrdinal,
      seedIndex
    });
  }
  return freezeSeededConversation(seeded, resolveConversationNowDate(sessions));
}

function createMutableLocomoSeededConversation(): MutableLocomoSeededConversation {
  return {
    diaIdByMemoryId: new Map(),
    memoryIdsByDiaId: new Map(),
    contentByMemoryId: new Map(),
    dateByMemoryId: new Map(),
    sessionByMemoryId: new Map()
  };
}

async function seedLocomoSession(input: {
  readonly workspace: BenchWorkspaceHandle;
  readonly seedRunner: CompileSeedRunner;
  readonly conversation: LocomoSample;
  readonly seeded: MutableLocomoSeededConversation;
  readonly session: ReturnType<typeof extractSessions>[number];
  readonly sessionOrdinal: number;
  readonly seedIndex: number;
}): Promise<number> {
  const sessionSurfaceId = benchSessionSurfacesEnabled()
    ? `${input.conversation.sample_id}-s${input.sessionOrdinal}`
    : undefined;
  const sessionMemberMemoryIds: string[] = [];
  let previousTurnSeedMemoryIds: readonly string[] = [];
  let seedIndex = input.seedIndex;
  for (let turnOrdinal = 0; turnOrdinal < input.session.turns.length; turnOrdinal += 1) {
    const turn = input.session.turns[turnOrdinal];
    if (turn === undefined) continue;
    const seedResult = await seedLocomoTurn({
      ...input,
      turn,
      turnOrdinal,
      seedIndex,
      sessionSurfaceId,
      previousTurnSeedMemoryIds
    });
    seedIndex += 1;
    previousTurnSeedMemoryIds = computeNextTurnSeedRefs(seedResult);
    recordLocomoSeedResult(input, turn, seedResult, sessionMemberMemoryIds);
  }
  await input.workspace.accrueSessionCoRecall(sessionMemberMemoryIds);
  return seedIndex;
}

async function seedLocomoTurn(input: {
  readonly workspace: BenchWorkspaceHandle;
  readonly seedRunner: CompileSeedRunner;
  readonly conversation: LocomoSample;
  readonly sessionOrdinal: number;
  readonly sessionSurfaceId: string | undefined;
  readonly turn: LocomoTurn;
  readonly turnOrdinal: number;
  readonly seedIndex: number;
  readonly previousTurnSeedMemoryIds: readonly string[];
}) {
  const evidenceRef = `${input.conversation.sample_id}-s${input.sessionOrdinal}-r${input.turnOrdinal}`;
  return input.seedRunner.seedTurn({
    daemon: input.workspace,
    turnContent: buildLocomoSeedContent(input.turn),
    evidenceRefBase: evidenceRef,
    seedIndex: input.seedIndex,
    workspaceId: input.workspace.workspaceId,
    runId: input.workspace.runId,
    ...(input.sessionSurfaceId === undefined ? {} : { surfaceId: input.sessionSurfaceId }),
    ...(input.previousTurnSeedMemoryIds.length === 0
      ? {}
      : { sourceMemoryRefs: input.previousTurnSeedMemoryIds })
  });
}

function recordLocomoSeedResult(
  input: {
    readonly conversation: LocomoSample;
    readonly seeded: MutableLocomoSeededConversation;
    readonly session: ReturnType<typeof extractSessions>[number];
    readonly sessionOrdinal: number;
  },
  turn: LocomoTurn,
  seedResult: Awaited<ReturnType<CompileSeedRunner["seedTurn"]>>,
  sessionMemberMemoryIds: string[]
): void {
  const seedContent = buildLocomoSeedContent(turn);
  for (const seed of seedResult.seeds) {
    input.seeded.diaIdByMemoryId.set(seed.memoryId, turn.dia_id);
    const current = input.seeded.memoryIdsByDiaId.get(turn.dia_id) ?? [];
    current.push(seed.memoryId);
    input.seeded.memoryIdsByDiaId.set(turn.dia_id, current);
    input.seeded.contentByMemoryId.set(seed.memoryId, seedContent);
    input.seeded.dateByMemoryId.set(seed.memoryId, input.session.date_time);
    input.seeded.sessionByMemoryId.set(
      seed.memoryId,
      `${input.conversation.sample_id}-s${input.sessionOrdinal}`
    );
    sessionMemberMemoryIds.push(seed.memoryId);
  }
}

function freezeSeededConversation(
  seeded: MutableLocomoSeededConversation,
  conversationNowDate: string
): LocomoSeededConversation {
  return {
    ...seeded,
    allSeededMemoryIds: [...seeded.memoryIdsByDiaId.values()].flat(),
    conversationNowDate
  };
}

function resolveConversationNowDate(
  sessions: ReturnType<typeof extractSessions>
): string {
  return sessions.reduce<string | null>((latest, s) => s.date_time ?? latest, null) ?? "";
}
