import type { StorageDatabase } from "./db.js";
import type { SqliteAllStatement } from "../repos/memory-entry/statement-types.js";

export class DynamicPreparedStatementCache {
  private connection: StorageDatabase["connection"] | null = null;
  private readonly cache = new Map<string, SqliteAllStatement>();

  public constructor(
    private readonly db: StorageDatabase,
    private readonly ensureActive: () => void
  ) {}

  public prepare(sql: string): SqliteAllStatement {
    this.ensureActive();
    const currentConnection = this.db.connection;
    if (this.connection !== currentConnection) {
      this.cache.clear();
      this.connection = currentConnection;
    }
    const cached = this.cache.get(sql);
    if (cached !== undefined) {
      return cached;
    }
    const statement = this.db.connection.prepare(sql) as SqliteAllStatement;
    this.cache.set(sql, statement);
    return statement;
  }
}
