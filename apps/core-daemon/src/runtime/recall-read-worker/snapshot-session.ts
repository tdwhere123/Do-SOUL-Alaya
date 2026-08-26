import { AsyncLocalStorage } from "node:async_hooks";
import type { Worker } from "node:worker_threads";
import type { RecallReadSnapshotPort } from "@do-soul/alaya-core";

export type RecallReadSnapshotOperation =
  | "snapshot.beginDeferred"
  | "snapshot.commit"
  | "snapshot.rollback";

export function createRecallReadSnapshotSession(input: {
  readonly workerCount: number;
  getWorker(index: number): Worker;
  dispatch(worker: Worker, operation: RecallReadSnapshotOperation): Promise<unknown>;
}): {
  readonly port: RecallReadSnapshotPort;
  pinnedWorker(): Worker | undefined;
} {
  const als = new AsyncLocalStorage<Worker>();
  const held = new Set<number>();
  const waiters: Array<() => void> = [];

  return {
    port: {
      isolate: async (work) => {
        const index = await acquire(input.workerCount, held, waiters);
        const worker = input.getWorker(index);
        try {
          return await als.run(worker, work);
        } finally {
          release(index, held, waiters);
        }
      },
      beginDeferred: async () => {
        await input.dispatch(requirePinned(als), "snapshot.beginDeferred");
      },
      commit: async () => {
        await input.dispatch(requirePinned(als), "snapshot.commit");
      },
      rollback: async () => {
        await input.dispatch(requirePinned(als), "snapshot.rollback");
      }
    },
    pinnedWorker: () => als.getStore()
  };
}

function requirePinned(als: AsyncLocalStorage<Worker>): Worker {
  const worker = als.getStore();
  if (worker === undefined) {
    throw new Error("recall read snapshot is not isolated onto a worker");
  }
  return worker;
}

async function acquire(
  workerCount: number,
  held: Set<number>,
  waiters: Array<() => void>
): Promise<number> {
  while (true) {
    for (let index = 0; index < workerCount; index += 1) {
      if (!held.has(index)) {
        held.add(index);
        return index;
      }
    }
    await new Promise<void>((resolve) => {
      waiters.push(resolve);
    });
  }
}

function release(
  index: number,
  held: Set<number>,
  waiters: Array<() => void>
): void {
  held.delete(index);
  waiters.shift()?.();
}
