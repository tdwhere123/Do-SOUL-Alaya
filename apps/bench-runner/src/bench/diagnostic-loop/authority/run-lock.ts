import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export async function withDiagnosticLoopRunLock<T>(
  workRoot: string,
  run: () => Promise<T>
): Promise<T> {
  const lock = acquireDiagnosticLoopRunLock(workRoot);
  try {
    const result = await run();
    lock.exec("COMMIT");
    return result;
  } catch (error) {
    rollbackQuietly(lock);
    throw error;
  } finally {
    lock.close();
  }
}

function acquireDiagnosticLoopRunLock(workRoot: string): DatabaseSync {
  mkdirSync(workRoot, { recursive: true });
  const path = join(workRoot, ".diagnostic-loop-run-lock.sqlite");
  const lock = new DatabaseSync(path);
  try {
    lock.exec("PRAGMA busy_timeout = 0");
    lock.exec("BEGIN EXCLUSIVE");
    return lock;
  } catch (cause) {
    lock.close();
    if (cause instanceof Error && /database is (?:busy|locked)/iu.test(cause.message)) {
      throw new Error(`diagnostic-loop is already in progress for ${workRoot}`, { cause });
    }
    throw new Error(`failed to acquire diagnostic-loop lock for ${workRoot}`, { cause });
  }
}

function rollbackQuietly(lock: DatabaseSync): void {
  try {
    lock.exec("ROLLBACK");
  } catch {
    // The original run or commit failure owns the error result.
  }
}
