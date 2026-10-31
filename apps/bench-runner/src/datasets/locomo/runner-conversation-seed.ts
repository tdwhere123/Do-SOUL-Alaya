import type { ConversationMessage } from "@do-soul/alaya-protocol";
import {
  benchSessionSurfacesEnabled
} from "../../harness/daemon/daemon-support.js";
import type { BenchWorkspaceHandle } from "../../harness/daemon.js";
import type { CompileSeedRunner, CompileSeedTurnInput } from "../../runs/compile-seed.js";
import { extractSessions, type LocomoSample, type LocomoTurn } from "./dataset.js";
import { buildLocomoSeedContent, buildLocomoSessionMessages } from "./runner-utils.js";
import { isSeededMemoryResult } from
  "../../harness/daemon/seed/daemon-seed-results.js";

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
  const sourceSession = buildLocomoSessionMessages(input.session);
  const sourceSessionRounds = input.session.turns.map((turn, index) => ({ seedIndex: input.seedIndex + index,
    turnContent: buildLocomoSeedContent(turn), turnMessages: [sourceSession[index]!] }));
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
      sourceSession, sourceSessionRounds
    });
    seedIndex += 1;
    recordLocomoSeedResult(input, turn, seedResult);
  }
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
  readonly sourceSession: readonly ConversationMessage[];
  readonly sourceSessionRounds: NonNullable<CompileSeedTurnInput["sourceSessionRounds"]>;
}) {
  const evidenceRef = `${input.conversation.sample_id}-s${input.sessionOrdinal}-r${input.turnOrdinal}`;
  return input.seedRunner.seedTurn({
    daemon: input.workspace,
    turnContent: buildLocomoSeedContent(input.turn),
    turnMessages: [input.sourceSession[input.turnOrdinal]!], sourceSession: input.sourceSession,
    sourceSessionRounds: input.sourceSessionRounds,
    ...(input.sourceSession[input.turnOrdinal]!.created_at === undefined ? {} : {
      sourceObservedAt: input.sourceSession[input.turnOrdinal]!.created_at }),
    evidenceRefBase: evidenceRef,
    seedIndex: input.seedIndex,
    workspaceId: input.workspace.workspaceId,
    runId: input.workspace.runId,
    ...(input.sessionSurfaceId === undefined ? {} : { surfaceId: input.sessionSurfaceId })
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
  seedResult: Awaited<ReturnType<CompileSeedRunner["seedTurn"]>>
): void {
  const seedContent = buildLocomoSeedContent(turn);
  for (const seed of seedResult.seeds) {
    if (!isSeededMemoryResult(seed)) continue;
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
