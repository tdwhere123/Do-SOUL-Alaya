import { AsyncLocalStorage } from "node:async_hooks";
import { rmSync } from "node:fs";
import { AlayaError } from "@do-soul/alaya-protocol";

const EXIT_BOUND_MS = 8_000;

interface OwnedDir {
  readonly path: string;
  readonly whenCancelled: boolean;
}

interface BenchScope {
  readonly signal: AbortSignal;
  cancelled: boolean;
  blocking: boolean;
  busy: number;
  readonly tasks: DaemonTask[];
  readonly bodies: Array<Promise<unknown>>;
  readonly operations: Set<Promise<unknown>>;
  readonly dirs: OwnedDir[];
  shutdown: (() => Promise<void>) | undefined;
  lateError: unknown;
  tail: Promise<void> | undefined;
}

interface DaemonTask {
  wasCancelled: boolean;
  bound: boolean;
  readonly scope: BenchScope;
  readonly started: Promise<void>;
  readonly done: Promise<void>;
  arm(shutdown: () => Promise<void>): () => Promise<void>;
  requestCancel(): void;
  finishWithoutShutdown(): void;
}

const storage = new AsyncLocalStorage<BenchScope>();
const scopes = new Set<BenchScope>();

/** The signal belongs to this test. Later tests get their own scope. */
export function bindBenchDaemonTestSignal(signal: AbortSignal): void {
  const scope = createScope(signal);
  storage.enterWith(scope);
}

export function clearBenchDaemonTestSignal(signal: AbortSignal): void {
  const scope = storage.getStore();
  if (scope?.signal !== signal || scope.blocking) return;
  scopes.delete(scope);
}

/** Launcher and CLI work have no vitest signal. The callback and its awaits see that. */
export function runOutsideBenchDaemonScope<T>(body: () => T): T {
  return storage.exit(body);
}

/** The operation that starts the daemon owns the scope, whether or not a test signal is bound. */
export async function runBenchDaemonOperation<T>(body: () => Promise<T>): Promise<T> {
  const parent = storage.getStore();
  const controller = new AbortController();
  if (parent?.cancelled === true || parent?.signal.aborted === true) controller.abort();
  else if (parent !== undefined) {
    parent.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  const scope = createScope(controller.signal);
  try {
    return await storage.run(scope, body);
  } finally {
    if (!scope.blocking && scope.busy === 0 && scope.shutdown === undefined &&
        scope.bodies.length === 0 && scope.operations.size === 0 && !scope.cancelled) {
      scopes.delete(scope);
    }
  }
}

export function beginBenchDaemonTask(): DaemonTask {
  const scope = storage.getStore() ?? createScope(new AbortController().signal);
  assertScopeCanStart(scope);
  const task = createTask(scope);
  scope.busy += 1;
  return task;
}

export function currentBenchScope(): BenchScope | undefined {
  return storage.getStore();
}

export function refuseBenchWorkAfterCancel(): void {
  const scope = storage.getStore();
  if (scope === undefined) return;
  if (scope.cancelled || scope.signal.aborted) {
    throw new AlayaError("CANCELLED", "bench scope was cancelled before new work could start");
  }
}

export function adoptBenchDaemonShutdown(
  task: DaemonTask,
  shutdown: () => Promise<void>
): () => Promise<void> {
  return task.arm(shutdown);
}

export function finishBenchDaemonTask(task: DaemonTask): void {
  task.finishWithoutShutdown();
}

/** Inner work stays on the scope that started it, even if a later test replaces the store. */
export function trackBenchBody<T>(scope: BenchScope, body: () => Promise<T>): Promise<T> {
  const work = storage.run(scope, body);
  scope.bodies.push(work);
  return work;
}

/** Operations include outer resource release and may await daemon shutdown. */
export function trackBenchOperation<T>(scope: BenchScope, body: () => Promise<T>): Promise<T> {
  const work = storage.run(scope, async () => {
    refuseBenchWorkAfterCancel();
    return body();
  });
  scope.operations.add(work);
  work.then(() => scope.operations.delete(work), () => scope.operations.delete(work));
  return work;
}

export function scopeForBenchWork(): BenchScope {
  return requireScope();
}

/** A timed-out body never reaches its finally, so the directory leaves only after that body stops. */
export function removeDataDirWhenBenchDaemonCancelled(dataDir: string): void {
  requireScope().dirs.push({ path: dataDir, whenCancelled: true });
}

export async function settleActiveBenchDaemonTasks(): Promise<void> {
  const pending = [...scopes].filter((scope) => scope.blocking || scopeNeedsClose(scope));
  for (const scope of pending) markCancelled(scope);
  if (pending.length === 0) return;
  const quiet = Promise.all(pending.map((scope) => closeScope(scope)));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      quiet,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AlayaError(
          "DEADLINE",
          "bench scope was still alive when the next test needed it"
        )), EXIT_BOUND_MS);
      })
    ]);
  } catch (error) {
    retainLate(quiet);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function createScope(signal: AbortSignal): BenchScope {
  const scope: BenchScope = {
    signal,
    cancelled: false,
    blocking: false,
    busy: 0,
    tasks: [],
    bodies: [],
    operations: new Set(),
    dirs: [],
    shutdown: undefined,
    lateError: undefined,
    tail: undefined
  };
  scopes.add(scope);
  const onAbort = () => markCancelled(scope);
  if (signal.aborted) markCancelled(scope);
  else signal.addEventListener("abort", onAbort, { once: true });
  return scope;
}

function createTask(scope: BenchScope): DaemonTask {
  let resolveStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  let resolveDone: () => void = () => undefined;
  let rejectDone: (error: unknown) => void = () => undefined;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  // A caller may ignore `done`. The rejection still has to stay on the scope.
  done.catch((error: unknown) => {
    if (scope.lateError === undefined) scope.lateError = error;
  });
  const task: DaemonTask = {
    get wasCancelled() {
      return scope.cancelled;
    },
    bound: false,
    scope,
    started,
    done,
    arm(shutdown) {
      task.bound = true;
      scope.busy = Math.max(0, scope.busy - 1);
      scope.shutdown = shutdown;
      resolveStarted();
      if (scope.cancelled) remember(scope, closeOnce(true));
      return () => closeOnce(false);
    },
    requestCancel() {
      scope.cancelled = true;
      scope.blocking = true;
      if (!task.bound || scope.tail !== undefined) return;
      remember(scope, closeOnce(true));
    },
    finishWithoutShutdown() {
      if (task.bound) return;
      scope.busy = Math.max(0, scope.busy - 1);
      resolveStarted();
      if (scope.busy === 0 && scope.shutdown === undefined && scope.bodies.length === 0 &&
          scope.operations.size === 0) {
        removeOwnedDirs(scope);
        scope.blocking = false;
      }
      resolveDone();
    }
  };
  scope.tasks.push(task);
  return task;

  function closeOnce(fromCancel: boolean): Promise<void> {
    if (fromCancel) markCancelled(scope);
    return ensureClosed(scope).then(resolveDone, (error: unknown) => {
      rejectDone(error);
      throw error;
    });
  }
}

async function closeScope(scope: BenchScope): Promise<void> {
  // Outer operations may await daemon shutdown before releasing their own locks.
  await Promise.all([ensureClosed(scope), Promise.allSettled([...scope.operations])]);
  await ensureClosed(scope);
}

function ensureClosed(scope: BenchScope): Promise<void> {
  // A second close waits for the first. Returning early would drop the directory while it is still open.
  if (scope.tail !== undefined) return scope.tail;
  const closing = closeResources(scope).then(() => {
    if (scope.operations.size === 0) removeOwnedDirs(scope);
    // The caller still holds this scope. Sealing it would skip the next daemon's shutdown.
    scope.shutdown = undefined;
    scope.tail = undefined;
    scope.lateError = undefined;
    scope.busy = 0;
    scope.bodies.length = 0;
    scope.tasks.length = 0;
    scope.blocking = scope.cancelled && scope.operations.size > 0;
    if (scope.operations.size === 0 && (scope.cancelled || storage.getStore() !== scope)) scopes.delete(scope);
  }, (error: unknown) => {
    scope.tail = undefined;
    scope.lateError = error;
    scope.blocking = true;
    throw error;
  });
  scope.tail = closing;
  return closing;
}

async function closeResources(scope: BenchScope): Promise<void> {
  // Startup must hand over shutdown before cleanup; task.done also waits for cleanup.
  await Promise.all(scope.tasks.map((task) => task.started));
  await settledBodies(scope);
  if (scope.busy > 0 && scope.shutdown === undefined) {
    throw new AlayaError("DEADLINE", "bench scope is still starting");
  }
  if (scope.shutdown !== undefined) await scope.shutdown();
}

function settledBodies(scope: BenchScope): Promise<unknown> {
  // The caller of the body still receives its rejection. Cleanup only waits until that promise has settled.
  return Promise.all(scope.bodies.map((body) => body.then(() => undefined, () => undefined)));
}

function removeOwnedDirs(scope: BenchScope): void {
  for (const dir of scope.dirs) {
    if (dir.whenCancelled && !scope.cancelled) continue;
    rmSync(dir.path, { recursive: true, force: true });
  }
  scope.dirs.length = 0;
}

function markCancelled(scope: BenchScope): void {
  const already = scope.cancelled;
  scope.cancelled = true;
  scope.blocking = true;
  if (already) return;
  for (const task of scope.tasks) task.requestCancel();
}

function scopeNeedsClose(scope: BenchScope): boolean {
  return scope.shutdown !== undefined || scope.bodies.length > 0 || scope.operations.size > 0 || scope.dirs.length > 0;
}

function assertScopeCanStart(scope: BenchScope): void {
  if (scope.lateError !== undefined) {
    throw scope.lateError instanceof Error
      ? scope.lateError
      : new AlayaError("CONFLICT", "bench scope failed and cannot be reused");
  }
  if (scope.cancelled || scope.signal.aborted) {
    throw new AlayaError("CANCELLED", "bench scope was cancelled before new work could start");
  }
  for (const other of scopes) {
    if (other !== scope && other.blocking) {
      throw new AlayaError("CONFLICT", "a bench scope is still alive");
    }
  }
}

function requireScope(): BenchScope {
  const scope = storage.getStore();
  if (scope === undefined) {
    throw new AlayaError("CANCELLED", "bench work has no owning scope");
  }
  return scope;
}

function remember(scope: BenchScope, pending: Promise<unknown>): void {
  // closeOnce already rejected `done`. This only keeps the extra rejection from going unhandled.
  pending.then(() => undefined, (error: unknown) => {
    if (scope.lateError === undefined) scope.lateError = error;
  });
}

function retainLate(quiet: Promise<unknown>): void {
  quiet.then(() => undefined, (error: unknown) => {
    for (const scope of scopes) {
      if (scope.blocking && scope.lateError === undefined) scope.lateError = error;
    }
  });
}
