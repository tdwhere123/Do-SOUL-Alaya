import type { SqliteConnection } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";

/** Message identity survives binding and erasure; bodies exist only while admission is pending. */
export type HostSessionLedgerMessage = Readonly<{
  workspace_id: string; container_key: string; message_id: string; position: number;
  container_scope: string; container_id: string; role: "user" | "assistant";
  completeness: "complete" | "excerpt"; fidelity: "original_bytes" | "normalized" | "unknown";
  host_reported_at: string | null; content_digest: string; run_id: string; producer: string; admitted_at: string;
  pending_body: string | null; round_index: number | null; round_root_id: string | null; erased: number;
}>;
export type HostSessionRound = Readonly<{ round_index: number; root_id: string; run_id: string }>;
type HostSessionCaptureHealth = Readonly<{
  captured_messages: number; excerpt_messages: number; last_captured_at: string | null;
  unbound_messages: number; overdue_unbound_messages: number;
}>;
type HostSessionIdleContainer = Readonly<{ workspace_id: string; container_key: string; newest_message: number }>;
export type HostSessionRoundIntent = Readonly<{ round_index: number; root_id: string; state: "pending" | "erased_pending";
  members: readonly HostSessionLedgerMessage[] }>;

const COLUMNS = `workspace_id, container_key, message_id, position, container_scope, container_id, role, completeness,
  fidelity, host_reported_at, content_digest, run_id, producer, admitted_at, pending_body, round_index, round_root_id, erased`;

export class HostSessionLedger {
  public constructor(private readonly connection: SqliteConnection) {}

  public transaction<T>(body: () => T): T { return this.connection.transaction(body).immediate(); }

  public find(workspaceId: string, containerKey: string, messageId: string): HostSessionLedgerMessage | null {
    return (this.connection.prepare(`SELECT ${COLUMNS} FROM host_session_messages
      WHERE workspace_id = ? AND container_key = ? AND message_id = ?`)
      .get(workspaceId, containerKey, messageId) as HostSessionLedgerMessage | undefined) ?? null;
  }

  public atPosition(workspaceId: string, containerKey: string, position: number): HostSessionLedgerMessage | null {
    return (this.connection.prepare(`SELECT ${COLUMNS} FROM host_session_messages
      WHERE workspace_id = ? AND container_key = ? AND position = ?`)
      .get(workspaceId, containerKey, position) as HostSessionLedgerMessage | undefined) ?? null;
  }

  public producer(workspaceId: string, containerKey: string): string | null {
    const row = this.connection.prepare(`SELECT producer FROM host_session_messages
      WHERE workspace_id = ? AND container_key = ? LIMIT 1`).get(workspaceId, containerKey) as { producer: string } | undefined;
    return row?.producer ?? null;
  }

  public highestPosition(workspaceId: string, containerKey: string): number | null {
    const row = this.connection.prepare(`SELECT MAX(position) AS position FROM host_session_messages
      WHERE workspace_id = ? AND container_key = ?`).get(workspaceId, containerKey) as { position: number | null };
    return row.position;
  }

  public insert(message: Omit<HostSessionLedgerMessage, "round_index" | "round_root_id" | "erased"> & { pending_body: string }): void {
    this.connection.prepare(`INSERT INTO host_session_messages (${COLUMNS})
      VALUES (@workspace_id, @container_key, @message_id, @position, @container_scope, @container_id, @role, @completeness,
        @fidelity, @host_reported_at, @content_digest, @run_id, @producer, @admitted_at, @pending_body, NULL, NULL, 0)`).run(message);
  }

  /** Only messages not already assigned to an immutable round may be paired. */
  public openTail(workspaceId: string, containerKey: string): readonly HostSessionLedgerMessage[] {
    return this.connection.prepare(`SELECT ${COLUMNS} FROM host_session_messages
      WHERE workspace_id = ? AND container_key = ? AND round_index IS NULL AND erased = 0 ORDER BY position`)
      .all(workspaceId, containerKey) as HostSessionLedgerMessage[];
  }

  public nextRoundIndex(workspaceId: string, containerKey: string): number {
    const row = this.connection.prepare(`SELECT MAX(round_index) AS round_index FROM host_session_rounds
      WHERE workspace_id = ? AND container_key = ?`).get(workspaceId, containerKey) as { round_index: number | null };
    return row.round_index === null ? 0 : row.round_index + 1;
  }

  /** Called under the same lock as admission so later appends cannot change a closed tail. */
  public reserveTailBoundary(workspaceId: string, containerKey: string, includePending: boolean): void {
    const row = this.connection.prepare(`SELECT MAX(round_index) AS round_index FROM host_session_rounds
      WHERE workspace_id = ? AND container_key = ? AND (? OR state IN ('done', 'erased'))`)
      .get(workspaceId, containerKey, includePending ? 1 : 0) as { round_index: number | null };
    if (row.round_index !== null) this.connection.prepare(`INSERT OR IGNORE INTO host_session_tail_boundaries
      VALUES (?, ?, ?, 'pending')`).run(workspaceId, containerKey, row.round_index);
  }

  /** Called inside the admission transaction, before any source write. */
  public reserveRound(workspaceId: string, containerKey: string, index: number, rootId: string, ids: readonly string[]): void {
    this.connection.prepare(`INSERT INTO host_session_rounds VALUES (?, ?, ?, ?, 'pending')`)
      .run(workspaceId, containerKey, index, rootId);
    const assign = this.connection.prepare(`UPDATE host_session_messages SET round_index = ?, round_root_id = ?
      WHERE workspace_id = ? AND container_key = ? AND message_id = ? AND round_index IS NULL AND erased = 0`);
    for (const id of ids) {
      if (assign.run(index, rootId, workspaceId, containerKey, id).changes !== 1) {
        throw new StorageError("CONFLICT", "host session round membership changed concurrently");
      }
    }
  }

  public pendingRounds(workspaceId: string, containerKey: string): readonly HostSessionRoundIntent[] {
    const rounds = this.connection.prepare(`SELECT round_index, root_id, state FROM host_session_rounds
      WHERE workspace_id = ? AND container_key = ? AND state IN ('pending', 'erased_pending') ORDER BY round_index`)
      .all(workspaceId, containerKey) as { round_index: number; root_id: string; state: "pending" | "erased_pending" }[];
    const members = this.connection.prepare(`SELECT ${COLUMNS} FROM host_session_messages
      WHERE workspace_id = ? AND container_key = ? AND round_index = ? ORDER BY position`);
    return rounds.map(round => ({ ...round, members: members.all(workspaceId, containerKey, round.round_index) as HostSessionLedgerMessage[] }));
  }

  /** Idempotent under concurrent replays; erasure wins over completion. */
  public completeRound(workspaceId: string, containerKey: string, index: number, rootId: string): "done" | "erased" | null {
    return this.transaction(() => {
      const changed = this.connection.prepare(`UPDATE host_session_rounds SET state = CASE
          WHEN state = 'erased_pending' THEN 'erased' ELSE 'done' END
        WHERE workspace_id = ? AND container_key = ? AND round_index = ? AND root_id = ?
          AND state IN ('pending', 'erased_pending') RETURNING state`)
        .get(workspaceId, containerKey, index, rootId) as { state: "done" | "erased" } | undefined;
      if (changed !== undefined) this.connection.prepare(`UPDATE host_session_messages SET pending_body = NULL
        WHERE workspace_id = ? AND container_key = ? AND round_index = ? AND round_root_id = ?`)
        .run(workspaceId, containerKey, index, rootId);
      return changed?.state ?? null;
    });
  }

  /** Logical round pages; the first message supplies the run attribution. */
  public roundPage(workspaceId: string, containerKey: string, after: number, limit: number,
    through = Number.MAX_SAFE_INTEGER): readonly HostSessionRound[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 64) throw new RangeError("invalid host session round page size");
    return this.connection.prepare(`SELECT r.round_index, r.root_id,
        (SELECT run_id FROM host_session_messages m WHERE m.workspace_id = r.workspace_id
          AND m.container_key = r.container_key AND m.round_index = r.round_index ORDER BY m.position LIMIT 1) AS run_id
      FROM host_session_rounds r WHERE r.workspace_id = ? AND r.container_key = ? AND r.state IN ('done', 'erased_pending', 'erased')
        AND r.round_index > ? AND r.round_index <= ? ORDER BY r.round_index LIMIT ?`)
      .all(workspaceId, containerKey, after, through, limit) as HostSessionRound[];
  }

  public roundForRoot(workspaceId: string, containerKey: string, rootId: string): HostSessionRound | null {
    const row = this.connection.prepare(`SELECT round_index FROM host_session_rounds WHERE workspace_id = ?
      AND container_key = ? AND root_id = ? AND state IN ('done', 'erased_pending', 'erased')`)
      .get(workspaceId, containerKey, rootId) as { round_index: number } | undefined;
    return row === undefined ? null : this.roundPage(workspaceId, containerKey, row.round_index - 1, 1)[0] ?? null;
  }

  public idleContainers(idleBefore: string, now: string, sweeper: string, limit: number): readonly HostSessionIdleContainer[] {
    return this.connection.prepare(`SELECT c.workspace_id, c.container_key, c.newest_position AS newest_message
      FROM host_session_containers c
      LEFT JOIN host_session_sweeps s ON s.workspace_id = c.workspace_id AND s.container_key = c.container_key AND s.sweeper = ?
      WHERE c.newest_admitted_at <= ? AND (s.retry_after IS NULL OR s.retry_after <= ?)
        AND (s.swept_through IS NULL OR s.swept_through < c.newest_position)
      ORDER BY (c.producer = ?) DESC, (s.retry_after IS NOT NULL), c.newest_admitted_at, c.workspace_id, c.container_key LIMIT ?`)
      .all(sweeper, idleBefore, now, sweeper, limit) as HostSessionIdleContainer[];
  }

  public captureHealth(workspaceId: string, overdueBefore: string): HostSessionCaptureHealth {
    return this.connection.prepare(`SELECT COUNT(*) AS captured_messages,
        COALESCE(SUM(completeness = 'excerpt'), 0) AS excerpt_messages, MAX(admitted_at) AS last_captured_at,
        COALESCE(SUM(pending_body IS NOT NULL), 0) AS unbound_messages,
        COALESCE(SUM(pending_body IS NOT NULL AND admitted_at < ?), 0) AS overdue_unbound_messages
      FROM host_session_messages WHERE workspace_id = ?`).get(overdueBefore, workspaceId) as HostSessionCaptureHealth;
  }

  public markSwept(workspaceId: string, containerKey: string, sweeper: string, newest: number): void {
    this.connection.prepare(`INSERT INTO host_session_sweeps VALUES (?, ?, ?, ?, NULL)
      ON CONFLICT (workspace_id, container_key, sweeper) DO UPDATE
      SET swept_through = MAX(swept_through, excluded.swept_through), retry_after = NULL`)
      .run(workspaceId, containerKey, sweeper, newest);
  }

  public retrySweep(workspaceId: string, containerKey: string, sweeper: string, retryAfter: string): void {
    this.connection.prepare(`INSERT INTO host_session_sweeps VALUES (?, ?, ?, -1, ?)
      ON CONFLICT (workspace_id, container_key, sweeper) DO UPDATE SET retry_after = excluded.retry_after`)
      .run(workspaceId, containerKey, sweeper, retryAfter);
  }
}
