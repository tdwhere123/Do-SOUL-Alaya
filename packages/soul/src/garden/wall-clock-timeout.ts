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
  const nowFn = deps?.now ?? Date.now;
  const setTimeoutFn = deps?.setTimeoutImpl ?? setTimeout;
  const clearTimeoutFn = deps?.clearTimeoutImpl ?? clearTimeout;
  const setIntervalFn = deps?.setIntervalImpl ?? setInterval;
  const clearIntervalFn = deps?.clearIntervalImpl ?? clearInterval;

  const controller = new AbortController();
  const startedAt = nowFn();
  let monotonicHandle: ReturnType<typeof setTimeout> | null = null;
  let wallClockHandle: ReturnType<typeof setInterval> | null = null;
  let trigger: "monotonic" | "wall_clock" | null = null;
  let elapsedAtTrigger = 0;

  const operatorAbortListener = (): void => {
    // Operator abort: forward to inner; outer promise will reject with
    // whatever the inner throws (the abort error), NOT a WallClockTimeoutError.
    controller.abort();
  };
  const operator = options.operatorAbortSignal;
  if (operator !== undefined) {
    if (operator.aborted) {
      controller.abort();
    } else {
      operator.addEventListener("abort", operatorAbortListener);
    }
  }

  const fire = (cause: "monotonic" | "wall_clock"): void => {
    if (controller.signal.aborted) {
      return;
    }
    trigger = cause;
    elapsedAtTrigger = nowFn() - startedAt;
    controller.abort();
  };

  monotonicHandle = setTimeoutFn(() => fire("monotonic"), options.budgetMs);
  wallClockHandle = setIntervalFn(() => {
    if (nowFn() - startedAt >= options.budgetMs) {
      fire("wall_clock");
    }
  }, WALL_CLOCK_TICK_MS);

  try {
    return await fn(controller.signal);
  } catch (error) {
    // Distinguish OUR timeout from any other rejection. If `trigger` is set,
    // our controller aborted the inner; rewrap as WallClockTimeoutError so
    // callers can classify it cleanly. If the operator aborted, surface the
    // original error (it carries the operator's abort reason).
    if (
      trigger !== null &&
      controller.signal.aborted &&
      (operator === undefined || !operator.aborted)
    ) {
      throw new WallClockTimeoutError(
        options.budgetMs,
        elapsedAtTrigger,
        trigger
      );
    }
    throw error;
  } finally {
    if (monotonicHandle !== null) {
      clearTimeoutFn(monotonicHandle);
    }
    if (wallClockHandle !== null) {
      clearIntervalFn(wallClockHandle);
    }
    if (operator !== undefined) {
      operator.removeEventListener("abort", operatorAbortListener);
    }
  }
}
