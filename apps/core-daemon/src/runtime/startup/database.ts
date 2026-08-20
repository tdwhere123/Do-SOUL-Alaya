import {
  configureSqliteWriteQueuePort,
  initDatabase,
  installDefaultSqliteWriteQueue,
  type SqliteWriteQueuePort
} from "@do-soul/alaya-storage";

let installedWriteQueue: SqliteWriteQueuePort | null = null;

export async function openDaemonDatabase(filename: string) {
  // WAL + busy_timeout already applied in initDatabase; worker queue is default-on
  // so payload writes can leave the event loop. Opt out: ALAYA_SQLITE_WRITE_QUEUE=0.
  // Close any prior install first — the port is process-global and workers outlive DB handles.
  await closeDaemonSqliteWriteQueue();
  installedWriteQueue = await installDefaultSqliteWriteQueue();
  const database = initDatabase({ filename });
  // Without stats, SQLite can pick a low-selectivity index on a growing alaya.db.
  database.optimize();
  return database;
}

export async function closeDaemonSqliteWriteQueue(): Promise<void> {
  const queue = installedWriteQueue;
  installedWriteQueue = null;
  try {
    await queue?.close?.();
  } finally {
    // Always drop the process-global port even if worker close rejects.
    configureSqliteWriteQueuePort(null);
  }
}
