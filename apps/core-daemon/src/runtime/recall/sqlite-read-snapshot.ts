import type { RecallReadSnapshotPort } from "@do-soul/alaya-core";

export interface SqliteExecConnection {
  exec(sql: string): unknown;
}

export function createSqliteConnectionReadSnapshot(
  connection: SqliteExecConnection
): RecallReadSnapshotPort {
  return {
    beginDeferred() {
      connection.exec("BEGIN DEFERRED");
    },
    commit() {
      connection.exec("COMMIT");
    },
    rollback() {
      connection.exec("ROLLBACK");
    }
  };
}
