/**
 * BL-060 spike: typed port for a future SQLite worker-thread write queue.
 *
 * Invariants (must survive worker migration):
 * - EventLog-first: event_log_transaction jobs dequeue in enqueue order and finish
 *   before any dependent ontology_write in the same workspace transaction chain.
 * - Serialize: at most one write job runs at a time per queue instance.
 * - No close on eviction: LRU cache eviction must not call StorageDatabase.close()
 *   while blocksEviction(filename) is true for that database path.
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

export interface SqliteWriteQueuePort {
  readonly kind: string;
  enqueue(job: SqliteWriteJob): Promise<void>;
  pendingCount(): number;
  blocksEviction(filename: string): boolean;
}

export function createInMemorySqliteWriteQueuePort(): SqliteWriteQueuePort {
  let chain: Promise<void> = Promise.resolve();
  let pending = 0;
  const pendingByFilename = new Map<string, number>();
  let activeFilename: string | null = null;

  const adjustFilenamePending = (filename: string, delta: number): void => {
    const next = (pendingByFilename.get(filename) ?? 0) + delta;
    if (next <= 0) {
      pendingByFilename.delete(filename);
      return;
    }
    pendingByFilename.set(filename, next);
  };

  return {
    kind: "in-memory-sqlite-write-queue",

    pendingCount: () => pending,

    blocksEviction: (filename) =>
      activeFilename === filename || (pendingByFilename.get(filename) ?? 0) > 0,

    enqueue: async (job) => {
      pending += 1;
      adjustFilenamePending(job.filename, 1);

      const run = async (): Promise<void> => {
        activeFilename = job.filename;
        try {
          if (job.execute) {
            await job.execute();
          }
        } finally {
          activeFilename = null;
          pending -= 1;
          adjustFilenamePending(job.filename, -1);
        }
      };

      const ticket = chain.then(run, run);
      chain = ticket.catch(() => {});
      await ticket;
    }
  };
}
