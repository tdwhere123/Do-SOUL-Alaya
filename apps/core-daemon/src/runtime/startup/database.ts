import {
  configureSqliteWriteQueuePort,
  initDatabase,
  inspectTemporalProjectionSelection,
  installDefaultSqliteWriteQueue,
  StorageError,
  type SqliteWriteQueuePort
} from "@do-soul/alaya-storage";
import { processEnvLookup } from "../config/daemon-config-environment.js";

let installedWriteQueue: SqliteWriteQueuePort | null = null;

/** Retains the actual open handle until startup cleanup has succeeded. */
export class DaemonDatabaseOpenCleanupError extends Error {
  public constructor(
    cause: unknown,
    private readonly database: ReturnType<typeof initDatabase> | undefined,
    private readonly nativeCleanup: (() => void) | undefined
  ) {
    super("Daemon database open failed and cleanup remains incomplete.", { cause });
  }

  public async retryCleanup(): Promise<void> {
    await closeDaemonSqliteWriteQueue();
    this.nativeCleanup?.();
    this.database?.close();
  }
}

export async function openDaemonDatabase(filename: string) {
  // WAL + busy_timeout already applied in initDatabase; worker queue is default-on
  // so payload writes can leave the event loop. Opt out: ALAYA_SQLITE_WRITE_QUEUE=0.
  // Close any prior install first — the port is process-global and workers outlive DB handles.
  let database: ReturnType<typeof initDatabase> | undefined;
  try {
    await closeDaemonSqliteWriteQueue();
    installedWriteQueue = await installDefaultSqliteWriteQueue(processEnvLookup());
    database = initDatabase({ filename });
    assertTemporalProjectionReady(database);
    // Without stats, SQLite can pick a low-selectivity index on a growing alaya.db.
    database.optimize();
    return database;
  } catch (error) {
    const nativeCleanup = readNativeOpenCleanup(error);
    const cleanup = new DaemonDatabaseOpenCleanupError(error, database, nativeCleanup);
    try {
      await cleanup.retryCleanup();
    } catch (cleanupError) {
      throw new DaemonDatabaseOpenCleanupError(
        new AggregateError([error, cleanupError], "Database open and cleanup both failed."), database, nativeCleanup
      );
    }
    throw error;
  }
}

function readNativeOpenCleanup(error: unknown): (() => void) | undefined {
  if (!(error instanceof StorageError) || error.code !== "DATABASE_OPEN_FAILED" ||
      !("retryDatabaseOpenCleanup" in error) || typeof error.retryDatabaseOpenCleanup !== "function") return undefined;
  const cleanup = error.retryDatabaseOpenCleanup;
  return () => { cleanup.call(error); };
}

export function assertTemporalProjectionReady(
  database: Parameters<typeof inspectTemporalProjectionSelection>[0]
): void {
  const state = inspectTemporalProjectionSelection(database);
  if (state.schema === "temporal" && state.selectionRequired && !state.selected) {
    throw new Error(
      "Temporal schema exists but is unselected (mixed-mode). Storage blocks writes until cutover selection or rollback completes."
    );
  }
}

export async function closeDaemonSqliteWriteQueue(): Promise<void> {
  const queue = installedWriteQueue;
  await queue?.close?.();
  if (installedWriteQueue === queue) {
    installedWriteQueue = null;
    configureSqliteWriteQueuePort(null);
  }
}
