import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";

/**
 * Cap is storage-budget-derived (~200B metadata/row → ~400KB at 2048).
 * Not a recall-quality tuning knob.
 */
export const SOURCE_GROUNDING_DEFER_QUEUE_CAP = 2048;

export interface SourceGroundingDeferEntry {
  readonly signal_id: string;
  readonly workspace_id: string;
  readonly run_id: string;
  readonly defer_reason: string;
  readonly enqueued_at: string;
}

export interface SourceGroundingDeferEnqueueResult {
  readonly entry: SourceGroundingDeferEntry;
  readonly evicted: SourceGroundingDeferEntry | null;
}

export interface SourceGroundingDeferStats {
  readonly queue_depth: number;
  readonly queue_cap: number;
  readonly deferred_by_reason: Readonly<Record<string, number>>;
}

export interface SourceGroundingDeferQueueRepo {
  enqueue(input: {
    readonly signal_id: string;
    readonly workspace_id: string;
    readonly run_id: string;
    readonly defer_reason: string;
    readonly enqueued_at?: string;
  }): SourceGroundingDeferEnqueueResult;
  remove(signalId: string): boolean;
  get(signalId: string): SourceGroundingDeferEntry | null;
  list(limit?: number): readonly SourceGroundingDeferEntry[];
  stats(): SourceGroundingDeferStats;
}

interface QueueRow {
  readonly signal_id: string;
  readonly workspace_id: string;
  readonly run_id: string;
  readonly defer_reason: string;
  readonly enqueued_at: string;
}

interface CountRow {
  readonly total: number;
}

interface ReasonCountRow {
  readonly defer_reason: string;
  readonly enqueue_count: number;
}

export class SqliteSourceGroundingDeferQueueRepo implements SourceGroundingDeferQueueRepo {
  private readonly cap: number;
  private readonly upsertStatement;
  private readonly deleteStatement;
  private readonly getStatement;
  private readonly listStatement;
  private readonly countStatement;
  private readonly oldestStatement;
  private readonly bumpReasonStatement;
  private readonly listReasonsStatement;

  public constructor(db: StorageDatabase, cap = SOURCE_GROUNDING_DEFER_QUEUE_CAP) {
    this.cap = cap;
    const connection = db.connection;
    this.upsertStatement = connection.prepare(`
      INSERT INTO source_grounding_defer_queue (
        signal_id, workspace_id, run_id, defer_reason, enqueued_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(signal_id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        run_id = excluded.run_id,
        defer_reason = excluded.defer_reason,
        enqueued_at = excluded.enqueued_at
    `);
    this.deleteStatement = connection.prepare(
      `DELETE FROM source_grounding_defer_queue WHERE signal_id = ?`
    );
    this.getStatement = connection.prepare(
      `SELECT signal_id, workspace_id, run_id, defer_reason, enqueued_at
       FROM source_grounding_defer_queue WHERE signal_id = ?`
    );
    this.listStatement = connection.prepare(
      `SELECT signal_id, workspace_id, run_id, defer_reason, enqueued_at
       FROM source_grounding_defer_queue
       ORDER BY enqueued_at ASC, signal_id ASC
       LIMIT ?`
    );
    this.countStatement = connection.prepare(
      `SELECT COUNT(*) AS total FROM source_grounding_defer_queue`
    );
    this.oldestStatement = connection.prepare(
      `SELECT signal_id, workspace_id, run_id, defer_reason, enqueued_at
       FROM source_grounding_defer_queue
       ORDER BY enqueued_at ASC, signal_id ASC
       LIMIT 1`
    );
    this.bumpReasonStatement = connection.prepare(`
      INSERT INTO source_grounding_defer_reason_counts (defer_reason, enqueue_count)
      VALUES (?, 1)
      ON CONFLICT(defer_reason) DO UPDATE SET
        enqueue_count = enqueue_count + 1
    `);
    this.listReasonsStatement = connection.prepare(
      `SELECT defer_reason, enqueue_count FROM source_grounding_defer_reason_counts`
    );
  }

  public enqueue(input: {
    readonly signal_id: string;
    readonly workspace_id: string;
    readonly run_id: string;
    readonly defer_reason: string;
    readonly enqueued_at?: string;
  }): SourceGroundingDeferEnqueueResult {
    const enqueued_at = input.enqueued_at ?? new Date().toISOString();
    const entry: SourceGroundingDeferEntry = {
      signal_id: input.signal_id,
      workspace_id: input.workspace_id,
      run_id: input.run_id,
      defer_reason: input.defer_reason,
      enqueued_at
    };

    try {
      this.bumpReasonStatement.run(entry.defer_reason);
      const existing = this.get(entry.signal_id);
      let evicted: SourceGroundingDeferEntry | null = null;
      if (existing === null) {
        const depth = (this.countStatement.get() as CountRow | undefined)?.total ?? 0;
        if (depth >= this.cap) {
          const oldest = this.oldestStatement.get() as QueueRow | undefined;
          if (oldest !== undefined) {
            evicted = mapRow(oldest);
            this.deleteStatement.run(oldest.signal_id);
          }
        }
      }
      this.upsertStatement.run(
        entry.signal_id,
        entry.workspace_id,
        entry.run_id,
        entry.defer_reason,
        entry.enqueued_at
      );
      return { entry, evicted };
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        "Failed to enqueue source grounding defer row.",
        error
      );
    }
  }

  public remove(signalId: string): boolean {
    try {
      const result = this.deleteStatement.run(signalId);
      return result.changes > 0;
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to remove source grounding defer ${signalId}.`,
        error
      );
    }
  }

  public get(signalId: string): SourceGroundingDeferEntry | null {
    try {
      const row = this.getStatement.get(signalId) as QueueRow | undefined;
      return row === undefined ? null : mapRow(row);
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to load source grounding defer ${signalId}.`,
        error
      );
    }
  }

  public list(limit = this.cap): readonly SourceGroundingDeferEntry[] {
    try {
      const rows = this.listStatement.all(Math.max(0, limit)) as QueueRow[];
      return rows.map(mapRow);
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        "Failed to list source grounding defer queue.",
        error
      );
    }
  }

  public stats(): SourceGroundingDeferStats {
    try {
      const depth = (this.countStatement.get() as CountRow | undefined)?.total ?? 0;
      const reasons = this.listReasonsStatement.all() as ReasonCountRow[];
      const deferred_by_reason: Record<string, number> = {};
      for (const row of reasons) {
        deferred_by_reason[row.defer_reason] = row.enqueue_count;
      }
      return {
        queue_depth: depth,
        queue_cap: this.cap,
        deferred_by_reason
      };
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        "Failed to load source grounding defer stats.",
        error
      );
    }
  }
}

function mapRow(row: QueueRow): SourceGroundingDeferEntry {
  return {
    signal_id: row.signal_id,
    workspace_id: row.workspace_id,
    run_id: row.run_id,
    defer_reason: row.defer_reason,
    enqueued_at: row.enqueued_at
  };
}
