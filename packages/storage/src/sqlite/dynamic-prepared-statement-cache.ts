import type BetterSqlite3 from "better-sqlite3";
import type { StorageDatabase } from "./db.js";
type SqliteStatement = BetterSqlite3.Statement<unknown[], unknown>;

export class DynamicPreparedStatementCache {
  private connection: StorageDatabase["connection"] | null = null;
  private readonly cache = new Map<string, SqliteStatement>();

  public constructor(
    private readonly db: StorageDatabase,
    private readonly ensureActive: () => void,
    private readonly maxEntries = 64
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new Error("Dynamic prepared statement cache size must be a positive integer.");
    }
  }

  public prepare(sql: string): SqliteStatement {
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
    const statement: SqliteStatement = this.db.connection.prepare(sql);
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

const readStatementCaches = new WeakMap<StorageDatabase, DynamicPreparedStatementCache>();

/** Compile a hot read statement once per connection. Do not keep one across an open `.iterate()` of the same SQL. */
export function cachedReadStatement(db: StorageDatabase, sql: string): SqliteStatement {
  let cache = readStatementCaches.get(db);
  if (cache === undefined) {
    cache = new DynamicPreparedStatementCache(db, () => db.reopenIfClosed());
    readStatementCaches.set(db, cache);
  }
  return cache.prepare(sql);
}
