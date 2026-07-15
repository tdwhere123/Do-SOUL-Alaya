import {
  SOURCE_GROUNDING_DEFER_QUEUE_CAP,
  SOURCE_GROUNDING_DEFER_QUEUE_OVERFLOW_ALLOWANCE,
  type SourceGroundingDeferEnqueueInput,
  type SourceGroundingDeferEnqueueResult,
  type SourceGroundingDeferEntry,
  type SourceGroundingDeferReason,
  type SourceGroundingDeferStats
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";

export {
  SOURCE_GROUNDING_DEFER_QUEUE_CAP,
  SOURCE_GROUNDING_DEFER_QUEUE_OVERFLOW_ALLOWANCE,
  type SourceGroundingDeferEnqueueInput,
  type SourceGroundingDeferEnqueueResult,
  type SourceGroundingDeferEntry,
  type SourceGroundingDeferReason,
  type SourceGroundingDeferStats
} from "@do-soul/alaya-protocol";

export interface SourceGroundingDeferQueueRepo {
  enqueue(input: SourceGroundingDeferEnqueueInput): SourceGroundingDeferEnqueueResult;
  get(workspaceId: string, signalId: string): SourceGroundingDeferEntry | null;
  list(workspaceId: string, limit?: number): readonly SourceGroundingDeferEntry[];
  stats(workspaceId: string): SourceGroundingDeferStats;
  aggregateStats(): SourceGroundingDeferStats;
  claim(
    workspaceId: string,
    signalId: string,
    claimToken: string,
    claimTokenFingerprint: string,
    claimExpiresAt: string
  ): SourceGroundingDeferEntry | null;
  ownsClaim(workspaceId: string, signalId: string, claimToken: string): boolean;
  readClaimCapability(workspaceId: string, signalId: string): {
    readonly claimToken: string;
    readonly claimExpiresAt: string;
  } | null;
  clearExpiredClaim(input: {
    readonly workspaceId: string;
    readonly signalId: string;
    readonly claimToken: string;
    readonly claimExpiresAt: string;
    readonly expiredBefore: string;
  }): boolean;
  removeClaimed(workspaceId: string, signalId: string, claimToken: string): boolean;
}

interface QueueRow {
  readonly signal_id: string;
  readonly workspace_id: string;
  readonly run_id: string;
  readonly defer_reason: SourceGroundingDeferReason;
  readonly enqueued_at: string;
  readonly claim_token_fingerprint: string | null;
  readonly claim_expires_at: string | null;
  readonly capacity_blocked: 0 | 1;
}

interface QueueStatsRow {
  readonly total: number;
  readonly claimable: number;
  readonly capacity_blocked: number;
}

interface ReasonCountRow {
  readonly defer_reason: SourceGroundingDeferReason;
  readonly enqueue_count: number;
}

interface ClaimCapabilityRow {
  readonly claim_token: string;
  readonly claim_expires_at: string;
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
  private readonly aggregateReasonsStatement;
  private readonly claimStatement;
  private readonly ownsClaimStatement;
  private readonly readClaimCapabilityStatement;
  private readonly clearExpiredClaimStatement;
  private readonly deleteClaimedStatement;
  private readonly promoteBlockedStatement;

  public constructor(private readonly db: StorageDatabase, cap = SOURCE_GROUNDING_DEFER_QUEUE_CAP) {
    this.cap = cap;
    const statements = prepareQueueStatements(db.connection);
    this.upsertStatement = statements.upsert;
    this.deleteStatement = statements.delete;
    this.getStatement = statements.get;
    this.listStatement = statements.list;
    this.countStatement = statements.count;
    this.oldestStatement = statements.oldest;
    this.bumpReasonStatement = statements.bumpReason;
    this.listReasonsStatement = statements.listReasons;
    this.aggregateReasonsStatement = statements.aggregateReasons;
    this.claimStatement = statements.claim;
    this.ownsClaimStatement = statements.ownsClaim;
    this.readClaimCapabilityStatement = statements.readClaimCapability;
    this.clearExpiredClaimStatement = statements.clearExpiredClaim;
    this.deleteClaimedStatement = statements.deleteClaimed;
    this.promoteBlockedStatement = statements.promoteBlocked;
  }

  public enqueue(input: SourceGroundingDeferEnqueueInput): SourceGroundingDeferEnqueueResult {
    const enqueued_at = input.enqueued_at ?? new Date().toISOString();
    const entry: SourceGroundingDeferEntry = {
      signal_id: input.signal_id,
      workspace_id: input.workspace_id,
      run_id: input.run_id,
      defer_reason: input.defer_reason,
      enqueued_at,
      claim_token_fingerprint: null,
      claim_expires_at: null,
      admission_state: "ready"
    };

    const execute = () => this.enqueueInCurrentTransaction(entry);
    try {
      if (this.db.connection.inTransaction) return execute();
      return this.db.connection.transaction(execute).immediate();
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        "Failed to enqueue source grounding defer row.",
        error
      );
    }
  }

  private enqueueInCurrentTransaction(
    entry: SourceGroundingDeferEntry
  ): SourceGroundingDeferEnqueueResult {
    this.bumpReasonStatement.run(entry.workspace_id, entry.defer_reason);
    const existing = this.get(entry.workspace_id, entry.signal_id);
    let evicted: SourceGroundingDeferEntry | null = null;
    let admissionState = existing?.admission_state ?? "ready";
    if (existing === null) {
      const depth = this.readQueueStats(entry.workspace_id).total;
      if (depth >= this.cap) {
        const oldest = this.oldestStatement.get(entry.workspace_id) as QueueRow | undefined;
        // An active claim may hide non-idempotent side effects. If every slot is
        // claimed, preserving the new obligation is safer than enforcing a hard cap.
        if (oldest !== undefined) {
          evicted = mapRow(oldest);
          this.deleteStatement.run(entry.workspace_id, oldest.signal_id);
        }
        const remainingDepth = depth - (evicted === null ? 0 : 1);
        if (remainingDepth >= this.cap) {
          admissionState = "capacity_blocked";
        }
      }
    }
    const admittedEntry = { ...entry, admission_state: admissionState };
    this.upsertStatement.run(
      admittedEntry.signal_id,
      admittedEntry.workspace_id,
      admittedEntry.run_id,
      admittedEntry.defer_reason,
      admittedEntry.enqueued_at,
      admittedEntry.admission_state === "capacity_blocked" ? 1 : 0
    );
    return { entry: admittedEntry, evicted };
  }

  public get(workspaceId: string, signalId: string): SourceGroundingDeferEntry | null {
    try {
      const row = this.getStatement.get(workspaceId, signalId) as QueueRow | undefined;
      return row === undefined ? null : mapRow(row);
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to load source grounding defer ${signalId}.`,
        error
      );
    }
  }

  public list(
    workspaceId: string,
    limit = Number.MAX_SAFE_INTEGER
  ): readonly SourceGroundingDeferEntry[] {
    try {
      const rows = this.listStatement.all(workspaceId, Math.max(0, limit)) as QueueRow[];
      return rows.map(mapRow);
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        "Failed to list source grounding defer queue.",
        error
      );
    }
  }

  public stats(workspaceId: string): SourceGroundingDeferStats {
    try {
      const queueStats = this.readQueueStats(workspaceId);
      const reasons = this.listReasonsStatement.all(workspaceId) as ReasonCountRow[];
      return buildStats(queueStats, this.cap, reasons);
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        "Failed to load source grounding defer stats.",
        error
      );
    }
  }

  public aggregateStats(): SourceGroundingDeferStats {
    try {
      const row = this.db.connection.prepare(`
        SELECT COUNT(*) AS total,
               COALESCE(SUM(
                 CASE WHEN claim_token IS NULL AND capacity_blocked = 0 THEN 1 ELSE 0 END
               ), 0) AS claimable,
               COALESCE(SUM(capacity_blocked), 0) AS capacity_blocked
        FROM source_grounding_defer_queue
      `).get() as QueueStatsRow | undefined;
      const reasons = this.aggregateReasonsStatement.all() as ReasonCountRow[];
      return buildStats(row ?? emptyQueueStats(), this.cap, reasons, "aggregate");
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        "Failed to load aggregate source grounding defer stats.",
        error
      );
    }
  }

  public claim(
    workspaceId: string,
    signalId: string,
    claimToken: string,
    claimTokenFingerprint: string,
    claimExpiresAt: string
  ): SourceGroundingDeferEntry | null {
    const result = this.claimStatement.run(
      claimToken,
      claimTokenFingerprint,
      claimExpiresAt,
      workspaceId,
      signalId,
      workspaceId,
      this.cap
    );
    return result.changes === 0 ? null : this.get(workspaceId, signalId);
  }

  public ownsClaim(workspaceId: string, signalId: string, claimToken: string): boolean {
    return this.ownsClaimStatement.get(workspaceId, signalId, claimToken) !== undefined;
  }

  public readClaimCapability(workspaceId: string, signalId: string) {
    const row = this.readClaimCapabilityStatement.get(
      workspaceId,
      signalId
    ) as ClaimCapabilityRow | undefined;
    return row === undefined
      ? null
      : { claimToken: row.claim_token, claimExpiresAt: row.claim_expires_at };
  }

  public clearExpiredClaim(input: {
    readonly workspaceId: string;
    readonly signalId: string;
    readonly claimToken: string;
    readonly claimExpiresAt: string;
    readonly expiredBefore: string;
  }): boolean {
    return this.clearExpiredClaimStatement.run(
      input.workspaceId,
      input.signalId,
      input.claimToken,
      input.claimExpiresAt,
      input.expiredBefore
    ).changes > 0;
  }

  public removeClaimed(workspaceId: string, signalId: string, claimToken: string): boolean {
    const execute = () => {
      const result = this.deleteClaimedStatement.run(workspaceId, signalId, claimToken);
      if (result.changes === 0) return false;
      this.promoteBlockedStatement.run(workspaceId, workspaceId, workspaceId, this.cap);
      return true;
    };
    if (this.db.connection.inTransaction) return execute();
    return this.db.connection.transaction(execute).immediate();
  }

  public getStorageConnectionIdentity(): StorageDatabase {
    return this.db;
  }

  private readQueueStats(workspaceId: string): QueueStatsRow {
    return (this.countStatement.get(workspaceId) as QueueStatsRow | undefined) ?? emptyQueueStats();
  }
}

function prepareQueueStatements(connection: StorageDatabase["connection"]) {
  return {
    ...prepareEntryStatements(connection),
    ...prepareReasonStatements(connection),
    ...prepareClaimStatements(connection)
  };
}

function prepareEntryStatements(connection: StorageDatabase["connection"]) {
  const upsert = connection.prepare(`
    INSERT INTO source_grounding_defer_queue (
      signal_id, workspace_id, run_id, defer_reason, enqueued_at, capacity_blocked
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(signal_id) DO UPDATE SET
      workspace_id = excluded.workspace_id,
      run_id = excluded.run_id,
      defer_reason = excluded.defer_reason,
      enqueued_at = excluded.enqueued_at,
      capacity_blocked = excluded.capacity_blocked,
      claim_token = NULL,
      claim_token_fingerprint = NULL,
      claim_expires_at = NULL
  `);
  const deleteStatement = connection.prepare(
    `DELETE FROM source_grounding_defer_queue WHERE workspace_id = ? AND signal_id = ?`
  );
  const get = connection.prepare(
    `SELECT signal_id, workspace_id, run_id, defer_reason, enqueued_at,
            claim_token_fingerprint, claim_expires_at, capacity_blocked
     FROM source_grounding_defer_queue WHERE workspace_id = ? AND signal_id = ?`
  );
  const list = connection.prepare(
    `SELECT signal_id, workspace_id, run_id, defer_reason, enqueued_at,
            claim_token_fingerprint, claim_expires_at, capacity_blocked
     FROM source_grounding_defer_queue
     WHERE workspace_id = ?
     ORDER BY enqueued_at ASC, signal_id ASC
     LIMIT ?`
  );
  const count = connection.prepare(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(
              CASE WHEN claim_token IS NULL AND capacity_blocked = 0 THEN 1 ELSE 0 END
            ), 0) AS claimable,
            COALESCE(SUM(capacity_blocked), 0) AS capacity_blocked
     FROM source_grounding_defer_queue WHERE workspace_id = ?`
  );
  const oldest = connection.prepare(
    `SELECT signal_id, workspace_id, run_id, defer_reason, enqueued_at,
            claim_token_fingerprint, claim_expires_at, capacity_blocked
     FROM source_grounding_defer_queue
     WHERE workspace_id = ? AND claim_token IS NULL
     ORDER BY enqueued_at ASC, signal_id ASC
     LIMIT 1`
  );
  return { upsert, delete: deleteStatement, get, list, count, oldest };
}

function prepareReasonStatements(connection: StorageDatabase["connection"]) {
  const bumpReason = connection.prepare(`
    INSERT INTO source_grounding_defer_reason_counts (workspace_id, defer_reason, enqueue_count)
    VALUES (?, ?, 1)
    ON CONFLICT(workspace_id, defer_reason) DO UPDATE SET
      enqueue_count = enqueue_count + 1
  `);
  const listReasons = connection.prepare(
    `SELECT defer_reason, enqueue_count FROM source_grounding_defer_reason_counts
     WHERE workspace_id = ?`
  );
  const aggregateReasons = connection.prepare(
    `SELECT defer_reason, SUM(enqueue_count) AS enqueue_count
     FROM source_grounding_defer_reason_counts
     GROUP BY defer_reason`
  );
  return { bumpReason, listReasons, aggregateReasons };
}

function prepareClaimStatements(connection: StorageDatabase["connection"]) {
  const claim = connection.prepare(`
    UPDATE source_grounding_defer_queue
    SET claim_token = ?, claim_token_fingerprint = ?, claim_expires_at = ?, capacity_blocked = 0
    WHERE workspace_id = ? AND signal_id = ? AND claim_token IS NULL
      AND (
        capacity_blocked = 0 OR
        (SELECT COUNT(*) FROM source_grounding_defer_queue AS workspace_queue
         WHERE workspace_queue.workspace_id = ?) <= ?
      )
  `);
  const ownsClaim = connection.prepare(`
    SELECT 1 FROM source_grounding_defer_queue
    WHERE workspace_id = ? AND signal_id = ? AND claim_token = ?
  `);
  const readClaimCapability = connection.prepare(`
    SELECT claim_token, claim_expires_at FROM source_grounding_defer_queue
    WHERE workspace_id = ? AND signal_id = ?
      AND claim_token IS NOT NULL AND claim_expires_at IS NOT NULL
  `);
  const clearExpiredClaim = connection.prepare(`
    UPDATE source_grounding_defer_queue
    SET claim_token = NULL, claim_token_fingerprint = NULL, claim_expires_at = NULL
    WHERE workspace_id = ? AND signal_id = ? AND claim_token = ?
      AND claim_expires_at = ?
      AND claim_expires_at <= ?
  `);
  const deleteClaimed = connection.prepare(`
    DELETE FROM source_grounding_defer_queue
    WHERE workspace_id = ? AND signal_id = ? AND claim_token = ?
  `);
  const promoteBlocked = connection.prepare(`
    UPDATE source_grounding_defer_queue
    SET capacity_blocked = 0
    WHERE workspace_id = ?
      AND signal_id = (
        SELECT signal_id FROM source_grounding_defer_queue
        WHERE workspace_id = ? AND capacity_blocked = 1
        ORDER BY enqueued_at ASC, signal_id ASC
        LIMIT 1
      )
      AND (
        SELECT COUNT(*) FROM source_grounding_defer_queue
        WHERE workspace_id = ?
      ) <= ?
  `);
  return { claim, ownsClaim, readClaimCapability, clearExpiredClaim, deleteClaimed, promoteBlocked };
}

function buildStats(
  queueStats: QueueStatsRow,
  queueCap: number,
  reasons: readonly ReasonCountRow[],
  queueScope: "workspace" | "aggregate" = "workspace"
): SourceGroundingDeferStats {
  const deferred_by_reason: Partial<Record<SourceGroundingDeferReason, number>> = {};
  for (const row of reasons) deferred_by_reason[row.defer_reason] = row.enqueue_count;
  return {
    queue_depth: queueStats.total,
    queue_cap: queueCap,
    queue_cap_per_workspace: queueCap,
    queue_hard_limit_per_workspace:
      queueCap + SOURCE_GROUNDING_DEFER_QUEUE_OVERFLOW_ALLOWANCE,
    queue_scope: queueScope,
    claimable_depth: queueStats.claimable,
    capacity_blocked_depth: queueStats.capacity_blocked,
    capacity_state: queueStats.capacity_blocked > 0 ? "saturated" : "ready",
    deferred_by_reason
  };
}

function mapRow(row: QueueRow): SourceGroundingDeferEntry {
  return {
    signal_id: row.signal_id,
    workspace_id: row.workspace_id,
    run_id: row.run_id,
    defer_reason: row.defer_reason,
    enqueued_at: row.enqueued_at,
    claim_token_fingerprint: row.claim_token_fingerprint,
    claim_expires_at: row.claim_expires_at,
    admission_state: row.capacity_blocked === 1 ? "capacity_blocked" : "ready"
  };
}

function emptyQueueStats(): QueueStatsRow {
  return { total: 0, claimable: 0, capacity_blocked: 0 };
}
