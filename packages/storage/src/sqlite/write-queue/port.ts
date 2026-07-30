/**
 * Serial SQLite write queue port.
 *
 * invariant: FIFO only orders queued jobs on this instance — an earlier
 * event_log_transaction finishes before any later ontology_write enqueued here.
 * Production ontology EventLog-first txns still run on the main connection and
 * are not automatically migrated onto this queue.
 * invariant: at most one write job runs at a time per queue instance.
 * invariant: LRU eviction must not close a database while blocksEviction(filename).
 */

export type SqliteWriteJobKind = "event_log_transaction" | "ontology_write" | "maintenance";

export interface SqliteWriteStatement {
  readonly sql: string;
  readonly params?: readonly unknown[];
}

export interface SqliteWriteJob {
  readonly jobId: string;
  readonly kind: SqliteWriteJobKind;
  readonly filename: string;
  readonly payload?: {
    readonly statements: readonly SqliteWriteStatement[];
  };
  execute?(): void | Promise<void>;
}

export function assertSqliteWriteJobWorkerShape(job: SqliteWriteJob): void {
  if (job.execute !== undefined && job.payload !== undefined) {
    throw new Error("SqliteWriteJob must not set both execute and payload");
  }
}

export interface SqliteWriteQueuePort {
  readonly kind: string;
  enqueue(job: SqliteWriteJob): Promise<void>;
  pendingCount(): number;
  blocksEviction(filename: string): boolean;
  close?(): Promise<void>;
}

interface FilenamePendingTracker {
  adjust(filename: string, delta: number): void;
  hasPending(filename: string): boolean;
}

function createFilenamePendingTracker(): FilenamePendingTracker {
  const pendingByFilename = new Map<string, number>();
  return {
    adjust(filename, delta) {
      const next = (pendingByFilename.get(filename) ?? 0) + delta;
      if (next <= 0) {
        pendingByFilename.delete(filename);
        return;
      }
      pendingByFilename.set(filename, next);
    },
    hasPending(filename) {
      return (pendingByFilename.get(filename) ?? 0) > 0;
    }
  };
}

interface SerialQueueState {
  chain: Promise<void>;
  pending: number;
  activeFilename: string | null;
  readonly tracker: FilenamePendingTracker;
}

function warnFailedWriteJob(job: SqliteWriteJob, error: unknown): void {
  process.emitWarning(
    `SQLite write queue job failed (jobId=${job.jobId}, kind=${job.kind})`,
    {
      code: "ALAYA_SQLITE_WRITE_QUEUE_JOB_FAILED",
      detail: error instanceof Error ? error.message : String(error)
    }
  );
}

async function runTrackedJob(
  state: SerialQueueState,
  job: SqliteWriteJob,
  runJob: (job: SqliteWriteJob) => Promise<void>
): Promise<void> {
  state.activeFilename = job.filename;
  try {
    await runJob(job);
  } finally {
    state.activeFilename = null;
    state.pending -= 1;
    state.tracker.adjust(job.filename, -1);
  }
}

function createSerialEnqueue(
  state: SerialQueueState,
  runJob: (job: SqliteWriteJob) => Promise<void>
): (job: SqliteWriteJob) => Promise<void> {
  // Port-level observability uses process.emitWarning so storage stays free of
  // daemon logger wiring. Callers must await enqueue() to surface job failures.
  return async (job) => {
    assertSqliteWriteJobWorkerShape(job);
    state.pending += 1;
    state.tracker.adjust(job.filename, 1);
    const ticket = state.chain.then(
      () => runTrackedJob(state, job, runJob),
      () => runTrackedJob(state, job, runJob)
    );
    // invariant: a failed job does not poison the queue — serialize-continue.
    state.chain = ticket.catch((error) => {
      warnFailedWriteJob(job, error);
    });
    await ticket;
  };
}

export function createSerialSqliteWriteQueuePort(input: {
  readonly kind: string;
  runJob(job: SqliteWriteJob): Promise<void>;
  close?(): Promise<void>;
}): SqliteWriteQueuePort {
  const state: SerialQueueState = {
    chain: Promise.resolve(),
    pending: 0,
    activeFilename: null,
    tracker: createFilenamePendingTracker()
  };
  let accepting = true;
  const enqueue = createSerialEnqueue(state, input.runJob);
  return {
    kind: input.kind,
    pendingCount: () => state.pending,
    blocksEviction: (filename) =>
      state.activeFilename === filename || state.tracker.hasPending(filename),
    enqueue: async (job) => {
      if (!accepting) {
        throw new Error("sqlite write queue is closed");
      }
      return enqueue(job);
    },
    close: async () => {
      // Drain in-flight/queued jobs before teardown so close does not abandon work
      // already handed to runJob / the worker.
      accepting = false;
      await state.chain;
      await input.close?.();
    }
  };
}

export function createInMemorySqliteWriteQueuePort(): SqliteWriteQueuePort {
  return createSerialSqliteWriteQueuePort({
    kind: "in-memory-sqlite-write-queue",
    runJob: async (job) => {
      if (job.execute) {
        await job.execute();
      }
    }
  });
}
