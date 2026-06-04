import type { StorageDatabase } from "../db.js";
import { StorageError } from "../errors.js";

// invariant: durable backing store for PathRelationProposalService co-usage
// counts. Replaces the prior in-memory Map so counts toward the propose
// threshold survive daemon restarts. Pairs are stored with the memory ids
// ordered (low <= high) so (A,B) and (B,A) share one row.
// see also: packages/core/src/path-relation-proposal-service.ts — consumer
// see also: migrations/083-path-relation-co-usage-counters.sql — schema

export interface CoUsageCounterIncrementInput {
  readonly workspaceId: string;
  readonly lowMemoryId: string;
  readonly highMemoryId: string;
  readonly seenAt: string;
}

export interface CoUsageCounterRepo {
  increment(input: CoUsageCounterIncrementInput): number;
  delete(workspaceId: string, lowMemoryId: string, highMemoryId: string): void;
  evictExpired(cutoff: string): number;
  size(): number;
}

interface CountRow {
  readonly count: number;
}

interface SizeRow {
  readonly size: number;
}

export class SqliteCoUsageCounterRepo implements CoUsageCounterRepo {
  private readonly incrementStatement;
  private readonly selectCountStatement;
  private readonly deleteStatement;
  private readonly evictStatement;
  private readonly sizeStatement;

  public constructor(db: StorageDatabase) {
    this.incrementStatement = db.connection.prepare(`
      INSERT INTO path_relation_co_usage_counters (
        workspace_id,
        low_memory_id,
        high_memory_id,
        count,
        first_seen_at,
        updated_at
      ) VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT(workspace_id, low_memory_id, high_memory_id) DO UPDATE SET
        count = count + 1,
        updated_at = excluded.updated_at
    `);

    this.selectCountStatement = db.connection.prepare(`
      SELECT count
      FROM path_relation_co_usage_counters
      WHERE workspace_id = ? AND low_memory_id = ? AND high_memory_id = ?
      LIMIT 1
    `);

    this.deleteStatement = db.connection.prepare(`
      DELETE FROM path_relation_co_usage_counters
      WHERE workspace_id = ? AND low_memory_id = ? AND high_memory_id = ?
    `);

    this.evictStatement = db.connection.prepare(`
      DELETE FROM path_relation_co_usage_counters
      WHERE updated_at < ?
    `);

    this.sizeStatement = db.connection.prepare(`
      SELECT COUNT(*) AS size
      FROM path_relation_co_usage_counters
    `);
  }

  public increment(input: CoUsageCounterIncrementInput): number {
    try {
      this.incrementStatement.run(
        input.workspaceId,
        input.lowMemoryId,
        input.highMemoryId,
        input.seenAt,
        input.seenAt
      );
      const row = this.selectCountStatement.get(
        input.workspaceId,
        input.lowMemoryId,
        input.highMemoryId
      ) as CountRow | undefined;
      return row?.count ?? 0;
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        "Failed to increment co-usage counter.",
        error
      );
    }
  }

  public delete(workspaceId: string, lowMemoryId: string, highMemoryId: string): void {
    try {
      this.deleteStatement.run(workspaceId, lowMemoryId, highMemoryId);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to delete co-usage counter.", error);
    }
  }

  public evictExpired(cutoff: string): number {
    try {
      const result = this.evictStatement.run(cutoff);
      return Number(result.changes ?? 0);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to evict co-usage counters.", error);
    }
  }

  public size(): number {
    try {
      const row = this.sizeStatement.get() as SizeRow | undefined;
      return row?.size ?? 0;
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to count co-usage counters.", error);
    }
  }
}
