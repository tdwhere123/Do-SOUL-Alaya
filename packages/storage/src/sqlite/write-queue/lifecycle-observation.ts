/** Private diagnostics only; never a persistence or successful-work receipt. */
export interface QueueLifecycleSnapshot {
  readonly queueId: number;
  readonly threadId: number | null;
  readonly accepting: boolean;
  readonly pendingJobs: number;
  readonly activeJob: "caller" | "payload" | "empty" | null;
  readonly completedJobs: number;
  readonly failedJobs: number;
  readonly readiness: "pending" | "ready" | "failed" | "not-applicable";
  readonly pendingRequests: number;
  readonly closes: readonly Readonly<{
    id: number; drained: boolean; result: "pending" | "fulfilled" | "rejected";
  }>[];
  readonly shutdowns: readonly Readonly<{
    id: number; closeId: number | null;
    result: "pending" | "acknowledged" | "failed";
    pendingBeforeTerminate: number | null;
    terminationRequested: boolean;
  }>[];
  readonly terminal: Readonly<{ code: number }> | null;
}

type Observer = (snapshot: QueueLifecycleSnapshot) => void | Promise<void>;
const observers = new Set<Observer>();
const bindings = new WeakMap<object, QueueLifecycleObservation>();
let currentCloseId: number | null = null;
let terminating: QueueLifecycleObservation | undefined;

/** Only populated during the owner's actual native terminate invocation. */
export function currentSqliteWriteQueueTermination(threadId: number): QueueLifecycleSnapshot | null {
  const observation = terminating;
  return observation?.state.threadId === threadId ? observation.snapshot() : null;
}
let nextQueueId = 1;

/** Subscribe before queue creation. Late subscriptions cannot reconstruct history. */
export function observeSqliteWriteQueueLifecycle(observer: Observer): () => void {
  observers.add(observer);
  return () => { observers.delete(observer); };
}

export class QueueLifecycleObservation {
  readonly state = {
    queueId: nextQueueId++, threadId: null as number | null, accepting: true,
    pendingJobs: 0, activeJob: null as QueueLifecycleSnapshot["activeJob"],
    completedJobs: 0, failedJobs: 0,
    readiness: "not-applicable" as QueueLifecycleSnapshot["readiness"], pendingRequests: 0,
    closes: [] as { id: number; drained: boolean; result: "pending" | "fulfilled" | "rejected" }[],
    shutdowns: [] as {
      id: number; closeId: number | null; result: "pending" | "acknowledged" | "failed";
      pendingBeforeTerminate: number | null; terminationRequested: boolean;
    }[],
    terminal: null as { code: number } | null
  };

  snapshot(): QueueLifecycleSnapshot {
    return Object.freeze({ ...this.state,
      closes: Object.freeze(this.state.closes.map(row => Object.freeze({ ...row }))),
      shutdowns: Object.freeze(this.state.shutdowns.map(row => Object.freeze({ ...row }))),
      terminal: this.state.terminal === null ? null : Object.freeze({ ...this.state.terminal })
    });
  }

  publish(): void {
    if (observers.size === 0) return;
    const snapshot = this.snapshot();
    for (const observer of observers) {
      try { void Promise.resolve(observer(snapshot)).catch(() => undefined); } catch { /* Diagnostics cannot affect work. */ }
    }
  }

  // Bind only synchronous owner entry, never async descendants of a close call.
  terminate<T>(action: () => T): T {
    const previous = terminating;
    terminating = this;
    try { return action(); } finally { terminating = previous; }
  }
  close<T>(id: number, action: () => T): T {
    const previous = currentCloseId;
    currentCloseId = id;
    try { return action(); } finally { currentCloseId = previous; }
  }
  currentClose(): number | null { return currentCloseId; }
}

export function createQueueLifecycleObservation(): QueueLifecycleObservation | undefined {
  return observers.size === 0 ? undefined : new QueueLifecycleObservation();
}

export function bindQueueLifecycleObservation(owner: object, observation: QueueLifecycleObservation | undefined): void {
  if (observation !== undefined) bindings.set(owner, observation);
}

export function queueLifecycleObservation(owner: object): QueueLifecycleObservation | undefined {
  return bindings.get(owner);
}
