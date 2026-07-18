import type { StorageDatabase } from "./db.js";
import type { SqliteAllStatement } from "../repos/memory-entry/statement-types.js";

export class DynamicPreparedStatementCache {
  private connection: StorageDatabase["connection"] | null = null;
  private readonly cache = new Map<string, SqliteAllStatement>();

  public constructor(
    private readonly db: StorageDatabase,
    private readonly ensureActive: () => void,
    private readonly maxEntries = 64
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new Error("Dynamic prepared statement cache size must be a positive integer.");
    }
  }

  public prepare(sql: string): SqliteAllStatement {
    this.ensureActive();
    const currentConnection = this.db.connection;
    if (this.connection !== currentConnection) {
      this.cache.clear();
      this.connection = currentConnection;
    }
    const cached = this.cache.get(sql);
    if (cached !== undefined) {
      this.cache.delete(sql);
      this.cache.set(sql, cached);
      return cached;
    }
    const statement = this.db.connection.prepare(sql) as SqliteAllStatement;
    this.cache.set(sql, statement);
    if (this.cache.size > this.maxEntries) {
      const leastRecentlyUsedSql = this.cache.keys().next().value;
      if (leastRecentlyUsedSql !== undefined) {
        this.cache.delete(leastRecentlyUsedSql);
      }
    }
    return statement;
  }
}
