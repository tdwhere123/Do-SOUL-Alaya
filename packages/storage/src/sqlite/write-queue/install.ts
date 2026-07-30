import { isEnvFlagDisabled } from "../../shared/env-bool.js";
import { configureSqliteWriteQueuePort, getSqliteWriteQueuePort } from "../db.js";
import type { SqliteWriteQueuePort } from "./port.js";
import {
  createWorkerThreadSqliteWriteQueuePort,
  resolveSqliteWriteQueueWorkerUrl
} from "./worker-port.js";

export const ALAYA_SQLITE_WRITE_QUEUE_ENV = "ALAYA_SQLITE_WRITE_QUEUE";

export function isSqliteWriteQueueDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEnvFlagDisabled(env[ALAYA_SQLITE_WRITE_QUEUE_ENV]);
}

/**
 * Install the worker-thread write queue when WAL/read-concurrency is usable.
 * Opt out with ALAYA_SQLITE_WRITE_QUEUE=0|false|off|disabled.
 * Replaces any previously configured port after awaiting its close.
 */
export async function installDefaultSqliteWriteQueue(
  env: NodeJS.ProcessEnv = process.env
): Promise<SqliteWriteQueuePort | null> {
  await closeConfiguredSqliteWriteQueuePort();

  if (isSqliteWriteQueueDisabled(env)) {
    configureSqliteWriteQueuePort(null);
    return null;
  }

  const workerUrl = resolveSqliteWriteQueueWorkerUrl();
  if (workerUrl === null) {
    process.emitWarning(
      "SQLite write-queue worker script missing; leaving write queue unconfigured",
      {
        code: "ALAYA_SQLITE_WRITE_QUEUE_WORKER_MISSING"
      }
    );
    configureSqliteWriteQueuePort(null);
    return null;
  }

  const port = createWorkerThreadSqliteWriteQueuePort({ workerUrl });
  configureSqliteWriteQueuePort(port);
  return port;
}

async function closeConfiguredSqliteWriteQueuePort(): Promise<void> {
  const prior = getSqliteWriteQueuePort();
  if (prior === null) {
    return;
  }
  configureSqliteWriteQueuePort(null);
  await prior.close?.();
}
