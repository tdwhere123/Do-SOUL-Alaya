import { GardenRole, GardenTaskKind, SOURCE_STATEMENT_LIMITS, hostSessionStatementSessionId } from "@do-soul/alaya-protocol";
import { planSourceStatementSession, type LocatedSourceStatementMessage } from "@do-soul/alaya-soul";
import type { GardenTaskEnqueueInput, HostSessionRound } from "@do-soul/alaya-storage";
import {
  StatementSessionSourceUnavailableError, parseStatementSessionTaskPayload, rootStatementMessages, statementSessionTaskId,
  type StatementSessionMember, type StatementSessionSourcesPort, type StatementSessionTaskPayload
} from "./statement-session-task.js";

export const STATEMENT_SESSION_IDLE_MS = 15 * 60 * 1000;
const ROUND_PAGE_SIZE = 64;

export type StatementSessionClosurePort = Readonly<{
  statementSessions: StatementSessionSourcesPort;
  enqueue(input: GardenTaskEnqueueInput): { readonly task_id: string };
}>;
type Located = LocatedSourceStatementMessage & Readonly<{ index: number; roundIndex: number; runId: string }>;

/** Resume at the last chunk's logical round, with bounded context and paged pending rounds. */
export function closeStatementSessionChunks(repo: StatementSessionClosurePort, input: Readonly<{
  workspaceId: string; containerKey: string; closeTail: boolean; now: () => string;
}>): number {
  return repo.statementSessions.transaction(() => planChunks(repo, input));
}

function planChunks(repo: StatementSessionClosurePort, input: Readonly<{
  workspaceId: string; containerKey: string; closeTail: boolean; now: () => string;
}>): number {
  const sources = repo.statementSessions;
  const lastPayload = sources.lastChunkPayload(input.workspaceId, input.containerKey);
  const last = lastPayload === null ? null : parseStatementSessionTaskPayload(lastPayload);
  const cursor = last?.targets.at(-1) ?? null;
  const saved = sources.planningCursor(input.workspaceId, input.containerKey);
  const cursorRound = saved !== null ? sources.roundAt(input.workspaceId, input.containerKey, saved.round_index)
    : cursor === null ? null : sources.roundForRoot(input.workspaceId, input.containerKey, cursor.root_id);
  if ((saved !== null || cursor !== null) && cursorRound === null) {
    throw new TypeError("statement session cursor root left its container");
  }
  const split = saved?.occurrence_end ?? cursor?.to ?? 0;
  const read = (turn: HostSessionRound): readonly Located[] => {
    const result = sources.root(input.workspaceId, turn.root_id);
    if (result.status === "unavailable") return [];
    try { return rootStatementMessages(result.root).map((row, index) => ({ ...row, index, roundIndex: turn.round_index, runId: turn.run_id })); }
    catch (error) { if (error instanceof StatementSessionSourceUnavailableError) return []; throw error; }
  };
  const cursorMessages = cursorRound === null ? [] : read(cursorRound);
  let recent = cursorMessages.slice(0, split);
  let before = cursorRound?.round_index ?? -1;
  while (cursorRound !== null && recent.length < SOURCE_STATEMENT_LIMITS.requestMessages) {
    const page = sources.contextPage(input.workspaceId, input.containerKey, before, ROUND_PAGE_SIZE);
    if (page.length === 0) break;
    for (const turn of page) {
      recent.unshift(...read(turn));
      if (recent.length >= SOURCE_STATEMENT_LIMITS.requestMessages) break;
    }
    before = page.at(-1)!.round_index;
    if (page.length < ROUND_PAGE_SIZE) break;
  }
  recent = recent.slice(-SOURCE_STATEMENT_LIMITS.requestMessages);
  let pending = cursorMessages.slice(split);
  let after = cursorRound?.round_index ?? -1;
  let chunkIndex = last === null ? 0 : last.chunk_index + 1;
  let enqueued = 0;
  let page = sources.roundPage(input.workspaceId, input.containerKey, after, ROUND_PAGE_SIZE);
  do {
    if (page.length > 0) {
      pending.push(...page.flatMap(read));
      after = page.at(-1)!.round_index;
    }
    const next = page.length === ROUND_PAGE_SIZE
      ? sources.roundPage(input.workspaceId, input.containerKey, after, ROUND_PAGE_SIZE) : [];
    const located = [...recent, ...pending];
    const plan = planSourceStatementSession(hostSessionStatementSessionId(input.containerKey), located.map(row => row.message),
      { message_index: recent.length, chunk_index: chunkIndex });
    const byId = new Map(located.map(row => [row.message.message_id, row]));
    let consumed = 0;
    for (let position = 0; position < plan.length; position++) {
      const chunk = plan[position]!;
      if (!("request" in chunk)) { consumed++; continue; }
      const closed = (input.closeTail && next.length === 0) || position < plan.length - 1;
      if (!closed) break;
      const targets = members(chunk.request.messages.map(message => byId.get(message.message_id)!));
      const payload: StatementSessionTaskPayload = { task_kind: GardenTaskKind.SOURCE_STATEMENT_SESSION,
        workspace_id: input.workspaceId, container_key: input.containerKey,
        run_id: byId.get(chunk.request.messages[0]!.message_id)!.runId, session_id: chunk.request.session_id,
        chunk_index: chunk.request.chunk_index,
        context: members(chunk.request.context.map(message => byId.get(message.message_id)!)), targets,
        closes_tail: input.closeTail && next.length === 0 && !plan.slice(position + 1).some(item => "request" in item) };
      repo.enqueue({ id: statementSessionTaskId(payload), workspace_id: input.workspaceId, role: GardenRole.LIBRARIAN,
        kind: GardenTaskKind.SOURCE_STATEMENT_SESSION, payload, created_at: input.now() });
      consumed += chunk.request.messages.length;
      chunkIndex++;
      enqueued++;
    }
    const consumedLast = consumed === 0 ? undefined : located[recent.length + consumed - 1];
    recent = located.slice(0, recent.length + consumed).slice(-SOURCE_STATEMENT_LIMITS.requestMessages);
    pending = pending.slice(consumed);
    if (pending.length === 0 && page.length > 0) {
      sources.savePlanningCursor(input.workspaceId, input.containerKey, page.at(-1)!.round_index, Number.MAX_SAFE_INTEGER);
    } else if (consumedLast !== undefined) {
      sources.savePlanningCursor(input.workspaceId, input.containerKey, consumedLast.roundIndex, consumedLast.index + 1);
    }
    page = next;
  } while (page.length > 0);
  return enqueued;
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
