import { closeDaemonSqliteWriteQueue } from "./database.js";

const retainedStartupCleanups = new Set<() => Promise<void>>();

/** Keep failed owners live, including their lease, until a later retry completes. */
export function retainDaemonStartupCleanup(cleanup: () => Promise<void>): void {
  retainedStartupCleanups.add(cleanup);
}

export async function retryDaemonStartupCleanups(): Promise<void> {
  for (const cleanup of retainedStartupCleanups) {
    await cleanup();
    retainedStartupCleanups.delete(cleanup);
  }
}

type StartupCleanupInput = Readonly<{
  readonly recallReadWorkerClient: Readonly<{ close(): Promise<void> }> | null;
  readonly database: Readonly<{ close(): void }>;
  readonly temporalRuntimeLease: Readonly<{ release(): Promise<void> }>;
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
  readonly error: unknown;
}>;

export async function closeDaemonStartupResourcesAfterFailure(
  input: StartupCleanupInput
): Promise<never> {
  let worker = input.recallReadWorkerClient;
  let database: StartupCleanupInput["database"] | null = input.database;
  const cleanup = async () => {
    if (worker !== null) {
      await closeWorker(input, worker);
      worker = null;
    }
    await closeWriteQueue(input);
    if (database !== null) {
      closeDatabase(input, database);
      database = null;
    }
    await releaseTemporalLease(input);
  };
  try {
    await cleanup();
  } catch (error) {
    retainDaemonStartupCleanup(cleanup);
    throw error;
  }
  throw input.error;
}

async function closeWorker(input: StartupCleanupInput, worker: NonNullable<StartupCleanupInput["recallReadWorkerClient"]>): Promise<void> {
  try {
    await worker.close();
  } catch (error) {
    warnCleanupFailure(input, "recall read worker", error);
    throw error;
  }
}

async function closeWriteQueue(input: StartupCleanupInput): Promise<void> {
  try {
    await closeDaemonSqliteWriteQueue();
  } catch (error) {
    warnCleanupFailure(input, "sqlite write queue", error);
    throw error;
  }
}

function closeDatabase(input: StartupCleanupInput, database: StartupCleanupInput["database"]): void {
  try {
    database.close();
  } catch (error) {
    warnCleanupFailure(input, "database", error);
    throw error;
  }
}

async function releaseTemporalLease(input: StartupCleanupInput): Promise<void> {
  try {
    await input.temporalRuntimeLease.release();
  } catch (error) {
    warnCleanupFailure(input, "temporal runtime lease", error);
    throw error;
  }
}

function warnCleanupFailure(
  input: StartupCleanupInput,
  resource: string,
  error: unknown
): void {
  input.warn("daemon startup cleanup failed", {
    resource,
    error: error instanceof Error ? error.message : String(error)
  });
}
