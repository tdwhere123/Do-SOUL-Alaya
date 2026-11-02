import type { SqliteConnection } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";

/** One captured host message; `pending_body` is set exactly while its round root is not yet admitted. */
export type HostSessionLedgerMessage = Readonly<{
  workspace_id: string; container_key: string; message_id: string; position: number;
  container_scope: string; container_id: string; role: "user" | "assistant";
  completeness: "complete" | "excerpt"; fidelity: "original_bytes" | "normalized" | "unknown";
  host_reported_at: string | null; content_digest: string; run_id: string; producer: string; admitted_at: string;
  pending_body: string | null; round_index: number | null; round_root_id: string | null;
}>;
/** An admitted round root of a container, in round order, with the run that admitted its first message. */
export type HostSessionRound = Readonly<{ round_index: number; root_id: string; run_id: string }>;
/** `newest_message` is the container's newest ledger rowid, the sweep checkpoint. */
export type HostSessionIdleContainer = Readonly<{ workspace_id: string; container_key: string; newest_message: number }>;

const COLUMNS = `workspace_id, container_key, message_id, position, container_scope, container_id, role, completeness,
  fidelity, host_reported_at, content_digest, run_id, producer, admitted_at, pending_body, round_index, round_root_id`;

/** Capture ledger of host sessions: idempotent message identity, pending bodies and round bindings. */
export class HostSessionLedger {
  public constructor(private readonly connection: SqliteConnection) {}

  public transaction<T>(body: () => T): T {
    return this.connection.transaction(body)();
  }

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

  /** The capture producer that owns the container, or null before its first message. */
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

  public insert(message: Omit<HostSessionLedgerMessage, "round_index" | "round_root_id"> & { pending_body: string }): void {
    this.connection.prepare(`INSERT INTO host_session_messages (${COLUMNS})
      VALUES (@workspace_id, @container_key, @message_id, @position, @container_scope, @container_id, @role, @completeness,
        @fidelity, @host_reported_at, @content_digest, @run_id, @producer, @admitted_at, @pending_body, NULL, NULL)`).run(message);
  }

  /** Messages not yet bound to a round, in position order. */
  public openTail(workspaceId: string, containerKey: string): readonly HostSessionLedgerMessage[] {
    return this.connection.prepare(`SELECT ${COLUMNS} FROM host_session_messages
      WHERE workspace_id = ? AND container_key = ? AND round_root_id IS NULL ORDER BY position`)
      .all(workspaceId, containerKey) as HostSessionLedgerMessage[];
  }

  public nextRoundIndex(workspaceId: string, containerKey: string): number {
    const row = this.connection.prepare(`SELECT MAX(round_index) AS round_index FROM host_session_messages
      WHERE workspace_id = ? AND container_key = ?`).get(workspaceId, containerKey) as { round_index: number | null };
    return row.round_index === null ? 0 : row.round_index + 1;
  }

  /** Binds still-open messages to their admitted round root and drops their pending bodies. */
  public bindRound(workspaceId: string, containerKey: string, messageIds: readonly string[], roundIndex: number,
    rootId: string): void {
    this.transaction(() => {
      for (const messageId of messageIds) {
        const changed = this.connection.prepare(`UPDATE host_session_messages
          SET round_index = ?, round_root_id = ?, pending_body = NULL
          WHERE workspace_id = ? AND container_key = ? AND message_id = ? AND round_root_id IS NULL`)
          .run(roundIndex, rootId, workspaceId, containerKey, messageId).changes;
        if (changed !== 1) throw new StorageError("CONFLICT", "host session round binding changed concurrently");
      }
    });
  }

  public rounds(workspaceId: string, containerKey: string): readonly HostSessionRound[] {
    return this.connection.prepare(`SELECT round_index, round_root_id AS root_id, run_id FROM host_session_messages AS message
      WHERE workspace_id = ? AND container_key = ? AND round_root_id IS NOT NULL
        AND position = (SELECT MIN(position) FROM host_session_messages
          WHERE workspace_id = message.workspace_id AND container_key = message.container_key
            AND round_index = message.round_index)
      ORDER BY round_index`).all(workspaceId, containerKey) as HostSessionRound[];
  }

  /** Idle containers with a message admitted after their last sweep, freshest first so dead ones never starve new ones. */
  public idleContainers(idleBefore: string, admittedSince: string, limit: number): readonly HostSessionIdleContainer[] {
    return this.connection.prepare(`WITH containers AS (
        SELECT workspace_id, container_key, MAX(admitted_at) AS newest, MAX(rowid) AS newest_message
        FROM host_session_messages WHERE admitted_at >= ?
        GROUP BY workspace_id, container_key HAVING newest <= ?
      )
      SELECT containers.workspace_id, containers.container_key, containers.newest_message FROM containers
      LEFT JOIN host_session_sweeps AS sweep
        ON sweep.workspace_id = containers.workspace_id AND sweep.container_key = containers.container_key
      WHERE sweep.swept_through IS NULL OR sweep.swept_through < containers.newest_message
      ORDER BY containers.newest DESC, containers.workspace_id, containers.container_key LIMIT ?`)
      .all(admittedSince, idleBefore, limit) as HostSessionIdleContainer[];
  }

  /** Records that the tail through `newestMessage` was examined, whether or not it formed anything. */
  public markSwept(workspaceId: string, containerKey: string, newestMessage: number): void {
    this.connection.prepare(`INSERT INTO host_session_sweeps (workspace_id, container_key, swept_through) VALUES (?, ?, ?)
      ON CONFLICT (workspace_id, container_key) DO UPDATE SET swept_through = MAX(swept_through, excluded.swept_through)`)
      .run(workspaceId, containerKey, newestMessage);
  }
}
