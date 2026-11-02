import { GardenTaskKind } from "@do-soul/alaya-protocol";
import { STATEMENT_SESSION_IDLE_MS } from "../statement-session/statement-session-closure.js";

export const RECENT_STATEMENT_SESSION_LIMIT = 50;

/** Host-session capture and statement outcomes of one workspace, as doctor reports them. */
export type GardenCaptureHealth = Readonly<{
  // `overdue_unbound_messages` were captured but formed no round within twice the idle window.
  host_session: Readonly<{
    captured_messages: number; excerpt_messages: number; last_captured_at: string | null;
    unbound_messages: number; overdue_unbound_messages: number;
  }>;
  // Failed chunks among the most recent `recent_window` statement sessions; their rounds have no statements.
  statement_sessions: Readonly<{ recent_window: number; failed: number; latest_error: string | null }>;
  // Retired post-turn captures that never produced statements (pending or failed); informational.
  legacy_post_turn_unprocessed: number;
}>;

export type CaptureHealthRepo = Readonly<{
  countByKind(taskKind: string, staleBefore: string, workspaceId?: string, recentFailedLimit?: number):
    Readonly<{ readonly pending: number; readonly stale: number; readonly failed: number }>;
  latestFailureText(taskKind: string, workspaceId: string): string | null;
  readonly hostSessions: Readonly<{
    captureHealth(workspaceId: string, overdueBefore: string): GardenCaptureHealth["host_session"];
  }>;
}>;

export function readCaptureHealth(repo: CaptureHealthRepo, workspaceId: string, now: string): GardenCaptureHealth {
  const statements = repo.countByKind(
    GardenTaskKind.SOURCE_STATEMENT_SESSION, now, workspaceId, RECENT_STATEMENT_SESSION_LIMIT);
  const legacy = repo.countByKind(GardenTaskKind.POST_TURN_EXTRACT, now, workspaceId);
  return {
    host_session: repo.hostSessions.captureHealth(
      workspaceId, new Date(Date.parse(now) - 2 * STATEMENT_SESSION_IDLE_MS).toISOString()),
    statement_sessions: {
      recent_window: RECENT_STATEMENT_SESSION_LIMIT,
      failed: statements.failed,
      latest_error: statements.failed === 0
        ? null : repo.latestFailureText(GardenTaskKind.SOURCE_STATEMENT_SESSION, workspaceId)
    },
    legacy_post_turn_unprocessed: legacy.pending + legacy.failed
  };
}
