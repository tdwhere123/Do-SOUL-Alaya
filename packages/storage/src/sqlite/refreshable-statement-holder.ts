import type { StorageDatabase } from "./db.js";

export class RefreshableStatementHolder<T> {
  private statements: T;

  public constructor(
    private readonly db: StorageDatabase,
    private readonly prepare: (database: StorageDatabase) => T
  ) {
    this.statements = prepare(db);
  }

  public active(): T {
    if (!this.db.isClosed()) {
      return this.statements;
    }
    this.db.reopenIfClosed();
    this.statements = this.prepare(this.db);
    return this.statements;
  }
}
