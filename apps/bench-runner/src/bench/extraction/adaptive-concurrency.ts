const BASE_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 10_000;

export interface AdaptiveConcurrencySnapshot {
  readonly maximum: number;
  readonly minimum: number;
  readonly current: number;
  readonly active: number;
  readonly rateLimitBackoffs: number;
  readonly transientFailureBackoffs: number;
  readonly backoffMs: number;
}

export type AdaptiveConcurrencyReleaseOutcome =
  | "success"
  | "rate_limit"
  | "transient_failure"
  | "neutral";

export function createAdaptiveConcurrencyController(input: {
  readonly maximum: number;
  readonly initial?: number;
  readonly minimumConcurrency?: number;
  readonly now?: () => number;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
}): {
  readonly acquire: (signal: AbortSignal) => Promise<void>;
  readonly release: (outcome: AdaptiveConcurrencyReleaseOutcome) => AdaptiveConcurrencySnapshot;
  readonly snapshot: () => AdaptiveConcurrencySnapshot;
  readonly dispose: () => void;
} {
  assertMaximum(input.maximum);
  const initial = input.initial ?? input.maximum;
  assertInitial(initial, input.maximum);
  const minimum = input.minimumConcurrency ?? 1;
  assertMinimum(minimum, initial);
  const state = createState(input.maximum, minimum, initial, input.now ?? Date.now);
  const schedule = input.setTimeout ?? setTimeout;
  const cancel = input.clearTimeout ?? clearTimeout;
  return {
    acquire: async (signal) => await acquireSlot(state, signal, schedule, cancel),
    release: (outcome) => releaseSlot(state, outcome),
    snapshot: () => snapshot(state),
    dispose: () => disposeWaiters(state, cancel)
  };
}

interface AdaptiveState {
  readonly maximum: number;
  readonly minimum: number;
  readonly now: () => number;
  current: number;
  active: number;
  successfulReleases: number;
  pressureStreak: number;
  resumeAt: number;
  rateLimitBackoffs: number;
  transientFailureBackoffs: number;
  totalBackoffMs: number;
  waiters: Set<() => void>;
}

function createState(
  maximum: number,
  minimum: number,
  initial: number,
  now: () => number
): AdaptiveState {
  return {
    maximum,
    minimum,
    now,
    current: initial,
    active: 0,
    successfulReleases: 0,
    pressureStreak: 0,
    resumeAt: 0,
    rateLimitBackoffs: 0,
    transientFailureBackoffs: 0,
    totalBackoffMs: 0,
    waiters: new Set()
  };
}

async function acquireSlot(
  state: AdaptiveState,
  signal: AbortSignal,
  schedule: typeof setTimeout,
  cancel: typeof clearTimeout
): Promise<void> {
  while (true) {
    signal.throwIfAborted();
    if (canAcquire(state)) {
      state.active += 1;
      return;
    }
    await waitForAvailability(state, signal, schedule, cancel);
  }
}

function canAcquire(state: AdaptiveState): boolean {
  return state.now() >= state.resumeAt && state.active < state.current;
}

function waitForAvailability(
  state: AdaptiveState,
  signal: AbortSignal,
  schedule: typeof setTimeout,
  cancel: typeof clearTimeout
): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wake = (): void => {
      if (!state.waiters.delete(wake)) return;
      if (timer !== undefined) cancel(timer);
      signal.removeEventListener("abort", wake);
      resolve();
    };
    state.waiters.add(wake);
    signal.addEventListener("abort", wake, { once: true });
    const delay = state.resumeAt - state.now();
    if (delay > 0) timer = schedule(wake, delay);
  });
}

function releaseSlot(
  state: AdaptiveState,
  outcome: AdaptiveConcurrencyReleaseOutcome
): AdaptiveConcurrencySnapshot {
  if (state.active < 1) throw new Error("adaptive extraction concurrency released without a slot");
  state.active -= 1;
  if (outcome === "rate_limit" || outcome === "transient_failure") {
    applyPressureBackoff(state, outcome);
  } else if (outcome === "success") {
    recoverConcurrency(state);
  } else {
    state.successfulReleases = 0;
  }
  wakeWaiters(state);
  return snapshot(state);
}

function applyPressureBackoff(
  state: AdaptiveState,
  outcome: "rate_limit" | "transient_failure"
): void {
  if (state.now() < state.resumeAt) return;
  state.current = Math.max(state.minimum, Math.floor(state.current / 2));
  state.successfulReleases = 0;
  state.pressureStreak += 1;
  const backoffMs = Math.min(
    BASE_BACKOFF_MS * 2 ** Math.max(0, state.pressureStreak - 1),
    MAX_BACKOFF_MS
  );
  state.resumeAt = Math.max(state.resumeAt, state.now() + backoffMs);
  if (outcome === "rate_limit") state.rateLimitBackoffs += 1;
  else state.transientFailureBackoffs += 1;
  state.totalBackoffMs += backoffMs;
}

function recoverConcurrency(state: AdaptiveState): void {
  if (state.now() < state.resumeAt) return;
  if (state.current === state.maximum) {
    state.successfulReleases = 0;
    return;
  }
  state.successfulReleases += 1;
  if (state.successfulReleases < state.current) return;
  state.successfulReleases = 0;
  state.pressureStreak = 0;
  state.current = Math.min(state.maximum, state.current + 1);
}

function wakeWaiters(state: AdaptiveState): void {
  for (const wake of [...state.waiters]) wake();
}

function snapshot(state: AdaptiveState): AdaptiveConcurrencySnapshot {
  return Object.freeze({
    maximum: state.maximum,
    minimum: state.minimum,
    current: state.current,
    active: state.active,
    rateLimitBackoffs: state.rateLimitBackoffs,
    transientFailureBackoffs: state.transientFailureBackoffs,
    backoffMs: state.totalBackoffMs
  });
}

function disposeWaiters(state: AdaptiveState, cancel: typeof clearTimeout): void {
  for (const wake of [...state.waiters]) wake();
  void cancel;
}

function assertMaximum(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("adaptive extraction concurrency maximum must be a positive safe integer");
  }
}

function assertInitial(value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error("adaptive extraction concurrency initial value is outside its maximum");
  }
}

function assertMinimum(value: number, initial: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > initial) {
    throw new Error("adaptive extraction concurrency minimum is outside its initial value");
  }
}
