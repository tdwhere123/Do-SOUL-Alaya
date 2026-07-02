import type { StorageDatabase } from "./db.js";

export class RefreshableStatementHolder<T> {
  private statements: T;
  private statementConnectionVersion: number;

  public constructor(
    private readonly db: StorageDatabase,
    private readonly prepare: (database: StorageDatabase) => T
  ) {
    db.reopenIfClosed();
    this.statements = prepare(db);
    this.statementConnectionVersion = db.getConnectionVersion();
  }

  public active(): T {
    this.db.reopenIfClosed();
    const currentConnectionVersion = this.db.getConnectionVersion();
    if (currentConnectionVersion === this.statementConnectionVersion) {
      return this.statements;
    }
    this.statements = this.prepare(this.db);
    this.statementConnectionVersion = currentConnectionVersion;
    return this.statements;
  }
}
