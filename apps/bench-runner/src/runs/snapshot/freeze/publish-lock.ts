import { mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
// The package barrel is a reviewed export set. This owner module is the path rule.
import { sqliteHostFilename } from "@do-soul/alaya-storage/sqlite/open-sqlite-connection";

export async function withSnapshotPublishLock<T>(
  snapshotOut: string,
  publish: () => Promise<T>
): Promise<T> {
  const lockDb = acquireSnapshotPublishLock(snapshotOut);
  try {
    const result = await publish();
    lockDb.exec("COMMIT");
    return result;
  } catch (error) {
    rollbackQuietly(lockDb);
    throw error;
  } finally {
    lockDb.close();
  }
}

function acquireSnapshotPublishLock(snapshotOut: string): DatabaseSync {
  const lockPath = snapshotPublishLockPath(snapshotOut);
  mkdirSync(dirname(lockPath), { recursive: true });
  const lockDb = new DatabaseSync(sqliteHostFilename(lockPath));
  try {
    lockDb.exec("PRAGMA busy_timeout = 0");
    lockDb.exec("BEGIN EXCLUSIVE");
    return lockDb;
  } catch (cause) {
    lockDb.close();
    if (isSqliteBusy(cause)) {
      throw new Error(`snapshot publish is already in progress for ${snapshotOut}`, {
        cause
      });
    }
    throw new Error(`failed to acquire snapshot publish lock for ${snapshotOut}`, {
      cause
    });
  }
}

export function snapshotPublishLockPath(snapshotOut: string): string {
  return join(dirname(snapshotOut), `.${basename(snapshotOut)}.publish-lock.sqlite`);
}

function rollbackQuietly(lockDb: DatabaseSync): void {
  try {
    lockDb.exec("ROLLBACK");
  } catch {
    // The original publication or commit failure owns the error result.
  }
}

function isSqliteBusy(error: unknown): boolean {
  return error instanceof Error && /database is (?:busy|locked)/iu.test(error.message);
}
