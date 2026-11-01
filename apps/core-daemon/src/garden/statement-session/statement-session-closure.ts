import { GardenRole, GardenTaskKind, SOURCE_STATEMENT_LIMITS } from "@do-soul/alaya-protocol";
import { planSourceStatementSession, type LocatedSourceStatementMessage } from "@do-soul/alaya-soul";
import type { GardenTaskEnqueueInput } from "@do-soul/alaya-storage";
import {
  StatementSessionSourceUnavailableError, parseStatementSessionTaskPayload, rootStatementMessages, statementSessionTaskId,
  type StatementSessionMember, type StatementSessionSourcesPort, type StatementSessionTaskPayload
} from "./statement-session-task.js";

/** A run's open tail closes after the same idle interval the host-worker fallback waits. */
export const STATEMENT_SESSION_IDLE_MS = 15 * 60 * 1000;
const STATEMENT_SESSION_SWEEP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const STATEMENT_SESSION_SWEEP_RUNS_PER_PASS = 32;

export type StatementSessionClosurePort = Readonly<{
  statementSessions: StatementSessionSourcesPort;
  enqueue(input: GardenTaskEnqueueInput): { readonly task_id: string };
}>;
type Located = LocatedSourceStatementMessage & Readonly<{ index: number }>;

/** Enqueues every chunk of a run's statement session that a later message has closed, or the open tail
 * too when the run is idle. The plan resumes after the last queued chunk, so a closed chunk never changes.
 */
export function closeStatementSessionChunks(repo: StatementSessionClosurePort, input: Readonly<{
  workspaceId: string; runId: string; closeTail: boolean; now: () => string;
}>): number {
  const sources = repo.statementSessions;
  const turns = sources.turns(input.workspaceId, input.runId);
  const lastPayload = sources.lastChunkPayload(input.workspaceId, input.runId);
  const last = lastPayload === null ? null : parseStatementSessionTaskPayload(lastPayload);
  const cursor = last === null ? null : last.targets.at(-1)!;
  const at = cursor === null ? 0 : turns.findIndex(turn => turn.root_id === cursor.root_id);
  if (at < 0) throw new TypeError("statement session cursor root left its run");
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
  const plan = planSourceStatementSession(input.runId, located.map(row => row.message),
    { message_index: recent.length, chunk_index: last === null ? 0 : last.chunk_index + 1 });
  const byId = new Map(located.map(row => [row.message.message_id, row]));
  let enqueued = 0;
  plan.forEach((chunk, position) => {
    const closed = input.closeTail || position < plan.length - 1;
    if (!closed || !("request" in chunk)) return;
    const payload: StatementSessionTaskPayload = { task_kind: GardenTaskKind.SOURCE_STATEMENT_SESSION,
      workspace_id: input.workspaceId, run_id: input.runId, session_id: chunk.request.session_id,
      chunk_index: chunk.request.chunk_index,
      context: members(chunk.request.context.map(message => byId.get(message.message_id)!)),
      targets: members(chunk.request.messages.map(message => byId.get(message.message_id)!)),
      closes_tail: input.closeTail && !plan.slice(position + 1).some(next => "request" in next) };
    repo.enqueue({ id: statementSessionTaskId(payload), workspace_id: input.workspaceId, role: GardenRole.LIBRARIAN,
      kind: GardenTaskKind.SOURCE_STATEMENT_SESSION, payload, created_at: input.now() });
    enqueued++;
  });
  return enqueued;
}

/** Closes the open tail of runs whose newest admitted turn has been idle for the fallback interval. */
export function sweepIdleStatementSessions(repo: StatementSessionClosurePort, input: Readonly<{
  now: () => string; warn: (message: string, meta: Record<string, unknown>) => void;
}>): void {
  const nowMs = Date.parse(input.now());
  const runs = repo.statementSessions.idleOpenRuns(new Date(nowMs - STATEMENT_SESSION_IDLE_MS).toISOString(),
    new Date(nowMs - STATEMENT_SESSION_SWEEP_WINDOW_MS).toISOString(), STATEMENT_SESSION_SWEEP_RUNS_PER_PASS);
  for (const run of runs) {
    try {
      closeStatementSessionChunks(repo, { workspaceId: run.workspace_id, runId: run.run_id, closeTail: true, now: input.now });
    } catch (error) {
      // One run's failure must not stop other idle runs from closing.
      input.warn("statement session tail closure failed", { workspace_id: run.workspace_id, run_id: run.run_id,
        error: error instanceof Error ? error.message : String(error) });
    }
    // A tail with nothing to close stops qualifying until a newer turn arrives.
    repo.statementSessions.markSwept(run.workspace_id, run.run_id, run.newest_turn);
  }
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
