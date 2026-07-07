import type { StorageDatabase } from "./db.js";

export class RefreshableStatementHolder<T> {
  private statements: T | null = null;
  private statementConnectionVersion = -1;

  public constructor(
    private readonly db: StorageDatabase,
    private readonly prepare: (database: StorageDatabase) => T
  ) {}

  public active(): T {
    this.db.reopenIfClosed();
    const currentConnectionVersion = this.db.getConnectionVersion();
    if (this.statements !== null && currentConnectionVersion === this.statementConnectionVersion) {
      return this.statements;
    }
    this.statements = this.prepare(this.db);
    this.statementConnectionVersion = currentConnectionVersion;
    return this.statements;
  }
}
