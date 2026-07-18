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
  await closeWorker(input);
  closeDatabase(input);
  await releaseTemporalLease(input);
  throw input.error;
}

async function closeWorker(input: StartupCleanupInput): Promise<void> {
  if (input.recallReadWorkerClient === null) return;
  try {
    await input.recallReadWorkerClient.close();
  } catch (error) {
    warnCleanupFailure(input, "recall read worker", error);
  }
}

function closeDatabase(input: StartupCleanupInput): void {
  try {
    input.database.close();
  } catch (error) {
    warnCleanupFailure(input, "database", error);
  }
}

async function releaseTemporalLease(input: StartupCleanupInput): Promise<void> {
  try {
    await input.temporalRuntimeLease.release();
  } catch (error) {
    warnCleanupFailure(input, "temporal runtime lease", error);
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
