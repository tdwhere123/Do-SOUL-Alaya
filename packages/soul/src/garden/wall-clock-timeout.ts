// invariant: wall-clock outer timeout for any HTTP-bound await chain that may
// outlive Node's monotonic-clock setTimeout. A host suspend (laptop lid close,
// VM pause, WSL2 host sleep) freezes the libuv monotonic clock for the suspend
// duration; `setTimeout(abort, ms)` schedules off that monotonic clock, so a
// fetch whose socket went stale during suspend resolves neither — and our
// abort never fires either. The bench-runner symptom is a 12-hour idle hang
// at the seed-extraction await, RSS flat, CPU 0.8%.
//
// This helper races the awaited promise against TWO timers:
//   1. setTimeout(ms)             — monotonic; fires normally on no-suspend.
//   2. setInterval(WALL_TICK_MS)  — re-checks Date.now() on every tick. On
//      resume, libuv catches up suppressed intervals, so the wall-clock check
//      detects the elapsed budget within one tick of resume and aborts.
//
// Both timers feed the SAME AbortController so the caller cannot observe a
// race between them; the first to fire wins and the promise rejects with a
// WallClockTimeoutError.
//
// invariant: the outer settlement is a Promise.race between `fn(signal)` and a
// settlement promise the timers REJECT — abort alone is NOT enough. On Node 24
// a stalled undici socket does NOT honor controller.abort(): the timer fires,
// abort() is called, but `await fn(signal)` never settles and the caller hangs
// forever. The race guarantees the outer promise settles on timeout even when
// the inner fetch ignores the abort. abort() is still called (so abort-aware
// fetches cancel cleanly and free the socket); the race is the safety net for
// the transport phases where the abort cannot terminate the stall.
// see also: packages/core/src/embedding-recall/openai-client.ts:OpenAIEmbeddingClient.raceFetchAgainstBackstop

const WALL_CLOCK_TICK_MS = 5_000;

export class WallClockTimeoutError extends Error {
  public constructor(
    public readonly budgetMs: number,
    public readonly elapsedMs: number,
    public readonly trigger: "monotonic" | "wall_clock"
  ) {
    super(
      `Wall-clock timeout: budget=${budgetMs}ms elapsed=${elapsedMs}ms trigger=${trigger}`
    );
    this.name = "WallClockTimeoutError";
  }
}

// invariant: an operator abort settles the race with THIS error (NOT a
// WallClockTimeoutError) only when the inner fn ignores the abort and never
// settles on its own. When the inner fn honors the abort it rejects first and
// wins the race, so its original abort error is surfaced instead. Either way
// the surfaced error is never a WallClockTimeoutError for an operator abort.
// see also: withWallClockTimeout operatorAbortListener
class OperatorAbortError extends Error {
  public constructor() {
    super("Operator aborted the wall-clock-bounded call.");
    this.name = "OperatorAbortError";
  }
}

export interface WallClockTimeoutDeps {
  // Test seam: defaults to Date.now (wall clock).
  readonly now?: () => number;
  // Test seam: defaults to global setTimeout (monotonic).
  readonly setTimeoutImpl?: (
    handler: () => void,
    ms: number
  ) => ReturnType<typeof setTimeout>;
  readonly clearTimeoutImpl?: (
    handle: ReturnType<typeof setTimeout>
  ) => void;
  // Test seam: defaults to global setInterval.
  readonly setIntervalImpl?: (
    handler: () => void,
    ms: number
  ) => ReturnType<typeof setInterval>;
  readonly clearIntervalImpl?: (
    handle: ReturnType<typeof setInterval>
  ) => void;
}

export interface WallClockTimeoutOptions {
  // Hard outer budget in ms. The promise rejects with WallClockTimeoutError if
  // it has not settled by Date.now() + budgetMs OR by monotonic+budgetMs,
  // whichever fires first.
  readonly budgetMs: number;
  // Optional operator-supplied abort: chained onto the same controller so
  // cancel still aborts the underlying call.
  readonly operatorAbortSignal?: AbortSignal;
}

interface ResolvedWallClockTimeoutDeps {
  readonly now: () => number;
  readonly setTimeout: (
    handler: () => void,
    ms: number
  ) => ReturnType<typeof setTimeout>;
  readonly clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
  readonly setInterval: (
    handler: () => void,
    ms: number
  ) => ReturnType<typeof setInterval>;
  readonly clearInterval: (handle: ReturnType<typeof setInterval>) => void;
}

interface WallClockTimeoutState {
  readonly controller: AbortController;
  readonly startedAt: number;
  readonly timeoutSettlement: Promise<never>;
  rejectSettlement: (error: WallClockTimeoutError | OperatorAbortError) => void;
  monotonicHandle: ReturnType<typeof setTimeout> | null;
  wallClockHandle: ReturnType<typeof setInterval> | null;
  trigger: "monotonic" | "wall_clock" | null;
  elapsedAtTrigger: number;
}

/**
 * Race `fn(signal)` against a wall-clock outer budget.
 *
 * The function is given an AbortSignal it MUST wire into its inner fetch /
 * SDK call. On timeout (monotonic OR wall-clock), the signal aborts and the
 * outer promise rejects with WallClockTimeoutError. Operator abort is chained
 * onto the same controller so cancel propagates uniformly.
 *
 * Cleanup is guaranteed by a try/finally that clears BOTH timers before the
 * promise resolves or rejects — no timer leak even on synchronous throw.
 *
 * see also: packages/soul/src/garden/compute-provider.ts requestSignals
 * see also: apps/bench-runner/src/longmemeval/compile-seed.ts createGardenHttpExtractor
 */
export async function withWallClockTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  options: WallClockTimeoutOptions,
  deps?: WallClockTimeoutDeps
): Promise<T> {
  const resolvedDeps = resolveWallClockTimeoutDeps(deps);
  const state = createWallClockTimeoutState(resolvedDeps);
  const operator = options.operatorAbortSignal;
  const operatorAbortListener = registerOperatorAbortListener(operator, state);
  startWallClockGuards(state, options, resolvedDeps);

  let raceSettled = false;
  try {
    const inner = fn(state.controller.signal);
    // invariant: once the outer race already settled, a late rejection from an
    // abandoned inner promise must not surface as an unhandledRejection.
    // Timeout/operator-abort paths intentionally abandon the inner; any other
    // post-settlement rejection is unexpected and should stay visible.
    void inner.catch((error: unknown) => {
      if (!raceSettled || state.controller.signal.aborted) {
        return;
      }
      console.warn(
        "garden/wall-clock-timeout: inner promise rejected after outer settlement",
        { error }
      );
    });
    const result = await Promise.race([inner, state.timeoutSettlement]);
    raceSettled = true;
    return result;
  } catch (error) {
    raceSettled = true;
    throw remapWallClockTimeoutError(error, state, options, operator);
  } finally {
    cleanupWallClockGuards(state, resolvedDeps);
    operator?.removeEventListener("abort", operatorAbortListener);
  }
}

function resolveWallClockTimeoutDeps(
  deps?: WallClockTimeoutDeps
): ResolvedWallClockTimeoutDeps {
  return {
    now: deps?.now ?? Date.now,
    setTimeout: deps?.setTimeoutImpl ?? setTimeout,
    clearTimeout: deps?.clearTimeoutImpl ?? clearTimeout,
    setInterval: deps?.setIntervalImpl ?? setInterval,
    clearInterval: deps?.clearIntervalImpl ?? clearInterval
  };
}

function createWallClockTimeoutState(
  deps: ResolvedWallClockTimeoutDeps
): WallClockTimeoutState {
  let rejectSettlement:
    | ((error: WallClockTimeoutError | OperatorAbortError) => void)
    | null = null;
  const timeoutSettlement = new Promise<never>((_resolve, reject) => {
    rejectSettlement = reject;
  });
  return {
    controller: new AbortController(),
    startedAt: deps.now(),
    timeoutSettlement,
    rejectSettlement: rejectSettlement ?? (() => undefined),
    monotonicHandle: null,
    wallClockHandle: null,
    trigger: null,
    elapsedAtTrigger: 0
  };
}

function registerOperatorAbortListener(
  operator: AbortSignal | undefined,
  state: WallClockTimeoutState
): () => void {
  const listener = (): void => settleOperatorAbort(state);
  if (operator === undefined) {
    return listener;
  }
  if (operator.aborted) {
    listener();
    return listener;
  }
  operator.addEventListener("abort", listener);
  return listener;
}

function settleOperatorAbort(state: WallClockTimeoutState): void {
  state.controller.abort();
  state.rejectSettlement(new OperatorAbortError());
}

function startWallClockGuards(
  state: WallClockTimeoutState,
  options: WallClockTimeoutOptions,
  deps: ResolvedWallClockTimeoutDeps
): void {
  state.monotonicHandle = deps.setTimeout(
    () => fireWallClockTimeout(state, options.budgetMs, "monotonic", deps.now),
    options.budgetMs
  );
  state.monotonicHandle.unref?.();
  state.wallClockHandle = deps.setInterval(() => {
    if (deps.now() - state.startedAt >= options.budgetMs) {
      fireWallClockTimeout(state, options.budgetMs, "wall_clock", deps.now);
    }
  }, WALL_CLOCK_TICK_MS);
  state.wallClockHandle.unref?.();
}

function fireWallClockTimeout(
  state: WallClockTimeoutState,
  budgetMs: number,
  cause: "monotonic" | "wall_clock",
  now: () => number
): void {
  if (state.controller.signal.aborted) {
    return;
  }
  state.trigger = cause;
  state.elapsedAtTrigger = now() - state.startedAt;
  state.controller.abort();
  state.rejectSettlement(
    new WallClockTimeoutError(budgetMs, state.elapsedAtTrigger, cause)
  );
}

function remapWallClockTimeoutError(
  error: unknown,
  state: WallClockTimeoutState,
  options: WallClockTimeoutOptions,
  operator: AbortSignal | undefined
): unknown {
  if (
    state.trigger !== null &&
    state.controller.signal.aborted &&
    (operator === undefined || !operator.aborted)
  ) {
    return new WallClockTimeoutError(
      options.budgetMs,
      state.elapsedAtTrigger,
      state.trigger
    );
  }
  return error;
}

function cleanupWallClockGuards(
  state: WallClockTimeoutState,
  deps: ResolvedWallClockTimeoutDeps
): void {
  if (state.monotonicHandle !== null) {
    deps.clearTimeout(state.monotonicHandle);
  }
  if (state.wallClockHandle !== null) {
    deps.clearInterval(state.wallClockHandle);
  }
}
