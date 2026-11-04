import { GardenRole, GardenTaskKind, SOURCE_STATEMENT_LIMITS, hostSessionStatementSessionId } from "@do-soul/alaya-protocol";
import { planSourceStatementSession, type LocatedSourceStatementMessage } from "@do-soul/alaya-soul";
import type { GardenTaskEnqueueInput, HostSessionRound } from "@do-soul/alaya-storage";
import {
  StatementSessionSourceUnavailableError, parseStatementSessionTaskPayload, rootStatementMessages, statementSessionTaskId,
  type StatementSessionMember, type StatementSessionSourcesPort, type StatementSessionTaskPayload
} from "./statement-session-task.js";

export const STATEMENT_SESSION_IDLE_MS = 15 * 60 * 1000;
const ROUND_PAGE_SIZE = 64;

type Input = Readonly<{ workspaceId: string; containerKey: string; closeTail: boolean; now: () => string }>;
export type StatementSessionClosurePort = Readonly<{
  statementSessions: StatementSessionSourcesPort;
  enqueue(input: GardenTaskEnqueueInput): { readonly task_id: string };
}>;
type Located = LocatedSourceStatementMessage & Readonly<{ index: number; roundIndex: number; runId: string }>;
type PendingRef = readonly [roundIndex: number, occurrenceIndex: number];
type PageResult = Readonly<{ enqueued: number; more: boolean; blocked?: true }>;

/** One transaction handles at most one pending round page; later passes resume from durable references. */
export function closeStatementSessionChunks(repo: StatementSessionClosurePort, input: Input): PageResult {
  return repo.statementSessions.transaction(() => planPage(repo, input));
}

function planPage(repo: StatementSessionClosurePort, input: Input): PageResult {
  const sources = repo.statementSessions;
  if (input.closeTail) sources.reserveTailBoundary(input.workspaceId, input.containerKey);
  const boundary = sources.nextTailBoundary(input.workspaceId, input.containerKey);
  const boundaryReady = boundary === null || sources.tailBoundaryReady(input.workspaceId, input.containerKey, boundary);
  const lastPayload = sources.lastChunkPayload(input.workspaceId, input.containerKey);
  const last = lastPayload === null ? null : parseStatementSessionTaskPayload(lastPayload);
  const lastTarget = last?.targets.at(-1) ?? null;
  const saved = sources.planningState(input.workspaceId, input.containerKey);
  const cursorRound = saved === null ? (lastTarget === null ? null : sources.roundForRoot(input.workspaceId, input.containerKey, lastTarget.root_id))
    : saved.round_index < 0 ? null : sources.roundAt(input.workspaceId, input.containerKey, saved.round_index);
  if ((saved !== null && saved.round_index >= 0 || saved === null && lastTarget !== null) && cursorRound === null) {
    throw new TypeError("statement session cursor root left its container");
  }
  const split = saved?.occurrence_end ?? lastTarget?.to ?? 0;
  const read = roundReader(sources, input);
  const cursorMessages = cursorRound === null ? [] : read(cursorRound);
  const pending = saved === null ? cursorMessages.slice(split) : restorePending(sources, input, read, saved.pending_json);
  const scan = saved?.scan_round ?? cursorRound?.round_index ?? -1;
  const contextBefore = saved?.context_before ?? cursorRound?.round_index ?? -1;
  const initialContext = saved?.context_before == null ? cursorMessages.slice(0, split)
    : restorePending(sources, input, read, saved.context_json);
  if (saved?.context_before != null && cursorRound === null) throw new TypeError("statement context cursor is unavailable");
  const context = priorContextPage(sources, input, read, cursorRound, contextBefore, initialContext);
  if (context.more) {
    sources.savePlanningState(input.workspaceId, input.containerKey, { round_index: cursorRound?.round_index ?? -1,
      occurrence_end: split, scan_round: scan, pending_json: references(pending),
      context_before: context.before, context_json: references(context.recent) });
    return { enqueued: 0, more: true, ...(!boundaryReady ? { blocked: true as const } : {}) };
  }
  const recent = context.recent;
  const page = sources.roundPage(input.workspaceId, input.containerKey, scan, ROUND_PAGE_SIZE, boundary ?? undefined);
  const scanned = page.at(-1)?.round_index ?? scan;
  pending.push(...page.flatMap(read));
  const more = !boundaryReady || page.length === ROUND_PAGE_SIZE &&
    sources.roundPage(input.workspaceId, input.containerKey, scanned, 1, boundary ?? undefined).length > 0;
  const closesTail = boundary !== null;
  const located = [...recent, ...pending];
  const plan = planSourceStatementSession(hostSessionStatementSessionId(input.containerKey), located.map(row => row.message),
    { message_index: recent.length, chunk_index: last === null ? 0 : last.chunk_index + 1 });
  const byId = new Map(located.map(row => [row.message.message_id, row]));
  let lastRequest = -1;
  plan.forEach((chunk, position) => { if ("request" in chunk) lastRequest = position; });
  let consumed = 0, enqueued = 0, deferredTargets = 0;
  for (let position = 0; position < plan.length; position++) {
    const chunk = plan[position]!;
    if (!("request" in chunk)) { consumed++; continue; }
    if (closesTail && more && position === lastRequest) {
      deferredTargets = chunk.request.messages.length;
      break;
    }
    if (!(closesTail && !more) && position === plan.length - 1) break;
    const targets = members(chunk.request.messages.map(message => byId.get(message.message_id)!));
    const payload: StatementSessionTaskPayload = { task_kind: GardenTaskKind.SOURCE_STATEMENT_SESSION,
      workspace_id: input.workspaceId, container_key: input.containerKey,
      run_id: byId.get(chunk.request.messages[0]!.message_id)!.runId, session_id: chunk.request.session_id,
      chunk_index: chunk.request.chunk_index,
      context: members(chunk.request.context.map(message => byId.get(message.message_id)!)), targets,
      closes_tail: closesTail && !more && !plan.slice(position + 1).some(item => "request" in item) };
    repo.enqueue({ id: statementSessionTaskId(payload), workspace_id: input.workspaceId, role: GardenRole.LIBRARIAN,
      kind: GardenTaskKind.SOURCE_STATEMENT_SESSION, payload, created_at: input.now() });
    consumed += chunk.request.messages.length;
    enqueued++;
  }
  let remaining = pending.slice(consumed);
  if (deferredTargets > 0 && remaining.length > deferredTargets + SOURCE_STATEMENT_LIMITS.requestMessages) {
    // Only the fixed recent suffix of following raw-only messages can influence a later request's context.
    remaining = [...remaining.slice(0, deferredTargets), ...remaining.slice(-SOURCE_STATEMENT_LIMITS.requestMessages)];
  }
  const consumedLast = consumed === 0 ? undefined : pending[consumed - 1];
  const roundIndex = remaining.length === 0 ? scanned : consumedLast?.roundIndex ?? cursorRound?.round_index ?? -1;
  const occurrenceEnd = remaining.length === 0 ? Number.MAX_SAFE_INTEGER : consumedLast?.index === undefined
    ? split : consumedLast.index + 1;
  sources.savePlanningState(input.workspaceId, input.containerKey, { round_index: roundIndex,
    occurrence_end: occurrenceEnd, scan_round: scanned, pending_json: references(remaining),
    context_before: null, context_json: "[]" });
  if (boundary !== null && !more) {
    sources.completeTailBoundary(input.workspaceId, input.containerKey, boundary);
    const laterBoundary = sources.nextTailBoundary(input.workspaceId, input.containerKey);
    const laterRound = sources.roundPage(input.workspaceId, input.containerKey, scanned, 1).length > 0;
    return { enqueued, more: laterBoundary !== null || laterRound };
  }
  return { enqueued, more, ...(!boundaryReady ? { blocked: true as const } : {}) };
}

function roundReader(sources: StatementSessionSourcesPort, input: Input): (turn: HostSessionRound) => readonly Located[] {
  const cache = new Map<number, readonly Located[]>();
  return turn => {
    const cached = cache.get(turn.round_index);
    if (cached !== undefined) return cached;
    const result = sources.root(input.workspaceId, turn.root_id);
    let rows: readonly Located[] = [];
    if (result.status === "available") {
      try { rows = rootStatementMessages(result.root).map((row, index) => ({ ...row, index, roundIndex: turn.round_index, runId: turn.run_id })); }
      catch (error) { if (!(error instanceof StatementSessionSourceUnavailableError)) throw error; }
    }
    cache.set(turn.round_index, rows);
    return rows;
  };
}

function restorePending(sources: StatementSessionSourcesPort, input: Input, read: (turn: HostSessionRound) => readonly Located[],
  raw: string): Located[] {
  const refs: unknown = JSON.parse(raw);
  if (!Array.isArray(refs) || refs.length > 2 * SOURCE_STATEMENT_LIMITS.requestMessages) {
    throw new TypeError("invalid statement pending references");
  }
  const result: Located[] = [], rounds = new Map<number, HostSessionRound>();
  for (const ref of refs) {
    if (!Array.isArray(ref) || ref.length !== 2 || !ref.every(value => Number.isSafeInteger(value) && value >= 0)) {
      throw new TypeError("invalid statement pending reference");
    }
    const [index, offset] = ref as [number, number];
    let round = rounds.get(index);
    if (round === undefined) {
      round = sources.roundAt(input.workspaceId, input.containerKey, index) ?? undefined;
      if (round === undefined) throw new TypeError("statement pending root left its container");
      rounds.set(index, round);
    }
    const rows = read(round);
    if (rows.length === 0) continue;
    if (rows[offset] === undefined) throw new TypeError("statement pending occurrence changed");
    result.push(rows[offset]!);
  }
  return result;
}

function priorContextPage(sources: StatementSessionSourcesPort, input: Input, read: (turn: HostSessionRound) => readonly Located[],
  cursor: HostSessionRound | null, before: number, initial: readonly Located[]): Readonly<{
    recent: Located[]; before: number; more: boolean;
  }> {
  const recent = [...initial];
  if (cursor === null || recent.length >= SOURCE_STATEMENT_LIMITS.requestMessages) return { recent, before, more: false };
  const page = sources.contextPage(input.workspaceId, input.containerKey, before, ROUND_PAGE_SIZE);
  for (const turn of page) {
    recent.unshift(...read(turn));
    if (recent.length >= SOURCE_STATEMENT_LIMITS.requestMessages) break;
  }
  return { recent: recent.slice(-SOURCE_STATEMENT_LIMITS.requestMessages), before: page.at(-1)?.round_index ?? before,
    more: page.length === ROUND_PAGE_SIZE && recent.length < SOURCE_STATEMENT_LIMITS.requestMessages };
}

function references(rows: readonly Located[]): string {
  const refs: PendingRef[] = rows.map(row => [row.roundIndex, row.index]);
  return JSON.stringify(refs);
}

function members(rows: readonly Located[]): readonly StatementSessionMember[] {
  const result: { root_id: string; source_id: string; from: number; to: number }[] = [];
  for (const row of rows) {
    const previous = result.at(-1);
    if (previous !== undefined && previous.root_id === row.root.root_id && previous.to === row.index) previous.to++;
    else result.push({ root_id: row.root.root_id, source_id: row.root.source_id, from: row.index, to: row.index + 1 });
  }
  return result;
}
