import { GardenRole, GardenTaskKind, SOURCE_STATEMENT_LIMITS, hostSessionStatementSessionId } from "@do-soul/alaya-protocol";
import { planSourceStatementSession, type LocatedSourceStatementMessage } from "@do-soul/alaya-soul";
import type { GardenTaskEnqueueInput } from "@do-soul/alaya-storage";
import {
  StatementSessionSourceUnavailableError, parseStatementSessionTaskPayload, rootStatementMessages, statementSessionTaskId,
  type StatementSessionMember, type StatementSessionSourcesPort, type StatementSessionTaskPayload
} from "./statement-session-task.js";

/** A container's open tail closes after the same idle interval the host-worker fallback waits. */
export const STATEMENT_SESSION_IDLE_MS = 15 * 60 * 1000;

export type StatementSessionClosurePort = Readonly<{
  statementSessions: StatementSessionSourcesPort;
  enqueue(input: GardenTaskEnqueueInput): { readonly task_id: string };
}>;
type Located = LocatedSourceStatementMessage & Readonly<{ index: number }>;

/** Enqueues every chunk of a container's statement session that a later message has closed, or the open
 * tail too when the container is idle. The plan resumes after the last queued chunk, so a closed chunk never changes.
 */
export function closeStatementSessionChunks(repo: StatementSessionClosurePort, input: Readonly<{
  workspaceId: string; containerKey: string; closeTail: boolean; now: () => string;
}>): number {
  const sources = repo.statementSessions;
  const turns = sources.rounds(input.workspaceId, input.containerKey);
  const lastPayload = sources.lastChunkPayload(input.workspaceId, input.containerKey);
  const last = lastPayload === null ? null : parseStatementSessionTaskPayload(lastPayload);
  const cursor = last === null ? null : last.targets.at(-1)!;
  const at = cursor === null ? 0 : turns.findIndex(turn => turn.root_id === cursor.root_id);
  if (at < 0) throw new TypeError("statement session cursor root left its container");
  const messagesOf = (rootId: string | null): readonly Located[] => {
    if (rootId === null) return [];
    const read = sources.root(input.workspaceId, rootId);
    // An unavailable or role-less turn is a raw-only gap: neither a target nor model-visible context.
    if (read.status === "unavailable") return [];
    try {
      return rootStatementMessages(read.root).map((row, index) => ({ ...row, index }));
    } catch (error) {
      if (error instanceof StatementSessionSourceUnavailableError) return [];
      throw error;
    }
  };
  const cursorMessages = messagesOf(turns[at]?.root_id ?? null), split = cursor?.to ?? 0;
  const context: Located[] = [...cursorMessages.slice(0, split)];
  for (let turn = at - 1; turn >= 0 && context.length < SOURCE_STATEMENT_LIMITS.requestMessages; turn--) {
    context.unshift(...messagesOf(turns[turn]!.root_id));
  }
  const recent = context.slice(-SOURCE_STATEMENT_LIMITS.requestMessages);
  const pending = [...cursorMessages.slice(split), ...turns.slice(at + 1).flatMap(turn => messagesOf(turn.root_id))];
  const located = [...recent, ...pending];
  const plan = planSourceStatementSession(hostSessionStatementSessionId(input.containerKey), located.map(row => row.message),
    { message_index: recent.length, chunk_index: last === null ? 0 : last.chunk_index + 1 });
  const byId = new Map(located.map(row => [row.message.message_id, row]));
  const runOfRoot = new Map(turns.map(turn => [turn.root_id, turn.run_id]));
  let enqueued = 0;
  plan.forEach((chunk, position) => {
    const closed = input.closeTail || position < plan.length - 1;
    if (!closed || !("request" in chunk)) return;
    const targets = members(chunk.request.messages.map(message => byId.get(message.message_id)!));
    const payload: StatementSessionTaskPayload = { task_kind: GardenTaskKind.SOURCE_STATEMENT_SESSION,
      workspace_id: input.workspaceId, container_key: input.containerKey,
      // Signals are attributed to the run that captured the chunk's first target.
      run_id: runOfRoot.get(targets[0]!.root_id)!, session_id: chunk.request.session_id,
      chunk_index: chunk.request.chunk_index,
      context: members(chunk.request.context.map(message => byId.get(message.message_id)!)), targets,
      closes_tail: input.closeTail && !plan.slice(position + 1).some(next => "request" in next) };
    repo.enqueue({ id: statementSessionTaskId(payload), workspace_id: input.workspaceId, role: GardenRole.LIBRARIAN,
      kind: GardenTaskKind.SOURCE_STATEMENT_SESSION, payload, created_at: input.now() });
    enqueued++;
  });
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
