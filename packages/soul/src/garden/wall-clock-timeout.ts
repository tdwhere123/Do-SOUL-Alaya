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
// see also: packages/core/src/embedding-recall-service.ts raceFetchAgainstBackstop

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

  // invariant: the timeout settlement promise NEVER resolves; it only rejects
  // when `fire()` runs. Racing it against `fn(signal)` is what guarantees the
  // outer promise settles even if the inner fetch ignores the abort (the
  // Node 24 stalled-undici case). Its rejection is a WallClockTimeoutError so
  // it flows through the SAME catch-rewrap below; the timeout fields are read
  // from `trigger` / `elapsedAtTrigger` set by `fire()` (so a wall-clock
  // trigger still surfaces its real elapsed, not the rejection-site value).
  let rejectOnTimeout: ((error: WallClockTimeoutError) => void) | null = null;
  const timeoutSettlement = new Promise<never>((_resolve, reject) => {
    rejectOnTimeout = reject;
  });

  const fire = (cause: "monotonic" | "wall_clock"): void => {
    if (controller.signal.aborted) {
      return;
    }
    trigger = cause;
    elapsedAtTrigger = nowFn() - startedAt;
    controller.abort();
    rejectOnTimeout?.(
      new WallClockTimeoutError(options.budgetMs, elapsedAtTrigger, cause)
    );
  };

  monotonicHandle = setTimeoutFn(() => fire("monotonic"), options.budgetMs);
  wallClockHandle = setIntervalFn(() => {
    if (nowFn() - startedAt >= options.budgetMs) {
      fire("wall_clock");
    }
  }, WALL_CLOCK_TICK_MS);

  try {
    const inner = fn(controller.signal);
    // invariant: if the timeout backstop wins the race, the abandoned `inner`
    // promise may still reject later (e.g. the socket finally errors). Attach a
    // no-op catch so that late rejection does not surface as an
    // unhandledRejection and crash the process.
    inner.catch(() => {});
    return await Promise.race([inner, timeoutSettlement]);
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
