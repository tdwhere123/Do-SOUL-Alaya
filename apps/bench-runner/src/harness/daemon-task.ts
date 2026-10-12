import { rmSync } from "node:fs";

const EXIT_BOUND_MS = 8_000;

interface ExitHook {
  readonly whenCancelled: boolean;
  readonly run: () => Promise<void> | void;
}

interface DaemonTask {
  wasCancelled: boolean;
  bound: boolean;
  readonly exits: ExitHook[];
  arm(shutdown: () => Promise<void>): () => Promise<void>;
  requestCancel(): void;
  finishWithoutShutdown(): void;
  readonly done: Promise<void>;
}

const tasks = new Set<DaemonTask>();
let current: DaemonTask | undefined;
let testSignal: AbortSignal | undefined;

/** Vitest stops waiting on timeout before the test's finally runs. This signal is that cancel. */
export function bindBenchDaemonTestSignal(signal: AbortSignal): void {
  testSignal = signal;
}

export function clearBenchDaemonTestSignal(signal: AbortSignal): void {
  if (testSignal === signal) testSignal = undefined;
}

export function beginBenchDaemonTask(): DaemonTask {
  let resolveDone: () => void = () => undefined;
  let rejectDone: (error: unknown) => void = () => undefined;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  let run: ((fromCancel: boolean) => Promise<void>) | undefined;
  let pending: Promise<void> | undefined;
  const task: DaemonTask = {
    wasCancelled: false,
    bound: false,
    exits: [],
    arm(shutdown) {
      task.bound = true;
      run = (fromCancel) => {
        if (fromCancel) task.wasCancelled = true;
        pending ??= shutdown().then(() => runExitHooks(task.exits, task.wasCancelled));
        return pending;
      };
      const started = () => {
        const promise = run!(false).then(resolveDone, (error) => {
          rejectDone(error);
          throw error;
        });
        void promise.catch(() => undefined);
        return promise;
      };
      if (task.wasCancelled) void run(true).then(resolveDone, rejectDone);
      return started;
    },
    requestCancel() {
      task.wasCancelled = true;
      if (run === undefined || pending !== undefined) return;
      void run(true).then(resolveDone, (error) => {
        rejectDone(error);
      });
    },
    finishWithoutShutdown() {
      if (pending !== undefined || task.bound) return;
      pending = Promise.resolve();
      resolveDone();
    },
    done
  };
  tasks.add(task);
  current = task;
  const signal = testSignal;
  const onAbort = () => task.requestCancel();
  if (signal?.aborted) task.requestCancel();
  else signal?.addEventListener("abort", onAbort, { once: true });
  void done.finally(() => {
    signal?.removeEventListener("abort", onAbort);
    tasks.delete(task);
    if (current === task) current = undefined;
  });
  return task;
}

async function runExitHooks(exits: readonly ExitHook[], cancelled: boolean): Promise<void> {
  for (const hook of exits) {
    if (hook.whenCancelled && !cancelled) continue;
    await hook.run();
  }
}

export function adoptBenchDaemonShutdown(task: DaemonTask, shutdown: () => Promise<void>): () => Promise<void> {
  return task.arm(shutdown);
}

export function finishBenchDaemonTask(task: DaemonTask): void {
  task.finishWithoutShutdown();
}

/** A timed-out body never reaches its finally, so the session directory has to leave with the daemon. */
export function removeDataDirWhenBenchDaemonCancelled(dataDir: string): void {
  current?.exits.push({
    whenCancelled: true,
    run: () => rmSync(dataDir, { recursive: true, force: true })
  });
}

export async function settleActiveBenchDaemonTasks(): Promise<void> {
  const pending = [...tasks];
  for (const task of pending) task.requestCancel();
  if (pending.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(pending.map((task) => task.done)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          "bench daemon was still running when the next test needed the process slot"
        )), EXIT_BOUND_MS);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
