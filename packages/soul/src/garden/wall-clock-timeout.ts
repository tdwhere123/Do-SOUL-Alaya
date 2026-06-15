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

  // invariant: the settlement promise NEVER resolves; it only rejects when a
  // timeout fires (`fire()`) OR the operator aborts (`settleOperatorAbort()`).
  // Racing it against `fn(signal)` is what guarantees the outer promise settles
  // even if the inner fetch ignores the abort (the Node 24 stalled-undici
  // case). A timeout rejection is a WallClockTimeoutError so it flows through
  // the SAME catch-rewrap below; the timeout fields are read from `trigger` /
  // `elapsedAtTrigger` set by `fire()` (so a wall-clock trigger still surfaces
  // its real elapsed, not the rejection-site value).
  // invariant: every path that calls controller.abort() MUST also settle this
  // promise — otherwise a stalled fn that ignores its signal leaves the race
  // unsettled and the outer await hangs forever. The operator-abort paths
  // settle via OperatorAbortError so the catch below surfaces it as the abort
  // (NOT a WallClockTimeoutError); when the inner fn honors the abort it
  // rejects first and wins the race, surfacing its own original error instead.
  let rejectSettlement:
    | ((error: WallClockTimeoutError | OperatorAbortError) => void)
    | null = null;
  const timeoutSettlement = new Promise<never>((_resolve, reject) => {
    rejectSettlement = reject;
  });

  const settleOperatorAbort = (): void => {
    controller.abort();
    rejectSettlement?.(new OperatorAbortError());
  };

  const operatorAbortListener = (): void => {
    // Operator abort: forward to inner AND settle the race. The outer promise
    // surfaces the inner's original abort error if the inner honors the abort
    // (it rejects first), otherwise the OperatorAbortError above — NEVER a
    // WallClockTimeoutError.
    settleOperatorAbort();
  };
  const operator = options.operatorAbortSignal;
  if (operator !== undefined) {
    if (operator.aborted) {
      settleOperatorAbort();
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
    rejectSettlement?.(
      new WallClockTimeoutError(options.budgetMs, elapsedAtTrigger, cause)
    );
  };

  // invariant: .unref?.() so a live backstop timer does not pin the event loop
  // and block process exit mid-extract. finally-clear + awaiting callers make
  // this redundant on the happy path; it is the safety margin for an abrupt
  // exit. see also: packages/core/src/embedding-recall/openai-client.ts:OpenAIEmbeddingClient.fetchEmbeddingWithRetry
  monotonicHandle = setTimeoutFn(() => fire("monotonic"), options.budgetMs);
  monotonicHandle.unref?.();
  wallClockHandle = setIntervalFn(() => {
    if (nowFn() - startedAt >= options.budgetMs) {
      fire("wall_clock");
    }
  }, WALL_CLOCK_TICK_MS);
  wallClockHandle.unref?.();

  let raceSettled = false;
  try {
    const inner = fn(controller.signal);
    // invariant: once the outer race already settled, a late rejection from an
    // abandoned inner promise must not surface as an unhandledRejection.
    // Timeout/operator-abort paths intentionally abandon the inner; any other
    // post-settlement rejection is unexpected and should stay visible.
    void inner.catch((error: unknown) => {
      if (!raceSettled || controller.signal.aborted) {
        return;
      }
      console.warn(
        "garden/wall-clock-timeout: inner promise rejected after outer settlement",
        { error }
      );
    });
    const result = await Promise.race([inner, timeoutSettlement]);
    raceSettled = true;
    return result;
  } catch (error) {
    raceSettled = true;
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
