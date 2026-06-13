import { describe, it, expect } from "vitest";
import {
  WallClockTimeoutError,
  withWallClockTimeout
} from "../../garden/wall-clock-timeout.js";

// invariant: covers the bench-runner / production garden hang root cause —
// a fetch that never resolves because the host suspended during the in-flight
// HTTP call leaves the monotonic setTimeout paused and the socket stale.
// see also: packages/soul/src/garden/compute-provider.ts requestSignals
// see also: apps/bench-runner/src/longmemeval/compile-seed.ts createGardenHttpExtractor

describe("withWallClockTimeout", () => {
  it("resolves the inner promise when it completes within budget", async () => {
    const result = await withWallClockTimeout(
      async () => "ok",
      { budgetMs: 1_000 }
    );
    expect(result).toBe("ok");
  });

  it("aborts and throws WallClockTimeoutError on monotonic timer fire", async () => {
    // Defer setTimeout firing to a microtask so fn() has wired its abort
    // listener before the controller aborts. Captures the real production
    // shape — Node's setTimeout never fires synchronously.
    const setTimeoutMock = (handler: () => void) => {
      queueMicrotask(handler);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    };
    const noopInterval = (() => 0) as unknown as typeof setInterval;
    const noopClear = (() => undefined) as (handle: unknown) => void;

    let thrown: unknown = null;
    try {
      await withWallClockTimeout(
        async (signal) =>
          new Promise<string>((_, reject) => {
            if (signal.aborted) {
              reject(new Error("aborted-by-controller"));
              return;
            }
            signal.addEventListener("abort", () => {
              reject(new Error("aborted-by-controller"));
            });
          }),
        { budgetMs: 60_000 },
        {
          setTimeoutImpl: setTimeoutMock as unknown as (
            h: () => void,
            ms: number
          ) => ReturnType<typeof setTimeout>,
          clearTimeoutImpl: noopClear as (
            handle: ReturnType<typeof setTimeout>
          ) => void,
          setIntervalImpl: noopInterval as unknown as (
            h: () => void,
            ms: number
          ) => ReturnType<typeof setInterval>,
          clearIntervalImpl: noopClear as (
            handle: ReturnType<typeof setInterval>
          ) => void
        }
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WallClockTimeoutError);
    expect((thrown as WallClockTimeoutError).trigger).toBe("monotonic");
    expect((thrown as WallClockTimeoutError).budgetMs).toBe(60_000);
  });

  it("aborts and throws WallClockTimeoutError when wall-clock detects elapsed budget after suspend", async () => {
    // Simulate host suspend: setTimeout NEVER fires (libuv paused during
    // suspend); setInterval fires once after resume; Date.now jumps forward by
    // 90s between start and the interval tick — wall-clock check trips the
    // abort.
    const noopTimeout = (() => 0) as unknown as typeof setTimeout;
    const noopClear = (() => undefined) as (handle: unknown) => void;
    let intervalHandler: (() => void) | null = null;
    const setIntervalMock = (handler: () => void) => {
      intervalHandler = handler;
      return 0 as unknown as ReturnType<typeof setInterval>;
    };

    let nowValue = 1_000_000;
    const nowMock = () => nowValue;

    let thrown: unknown = null;
    try {
      await withWallClockTimeout(
        async (signal) => {
          return await new Promise<string>((_, reject) => {
            if (signal.aborted) {
              reject(new Error("aborted-by-controller"));
              return;
            }
            signal.addEventListener("abort", () => {
              reject(new Error("aborted-by-controller"));
            });
            // Simulate resume: jump wall-clock 90s and fire the interval tick
            // AFTER the listener is wired so the abort routes through it.
            queueMicrotask(() => {
              nowValue += 90_000;
              intervalHandler?.();
            });
          });
        },
        { budgetMs: 60_000 },
        {
          now: nowMock,
          setTimeoutImpl: noopTimeout as unknown as (
            h: () => void,
            ms: number
          ) => ReturnType<typeof setTimeout>,
          clearTimeoutImpl: noopClear as (
            handle: ReturnType<typeof setTimeout>
          ) => void,
          setIntervalImpl: setIntervalMock as unknown as (
            h: () => void,
            ms: number
          ) => ReturnType<typeof setInterval>,
          clearIntervalImpl: noopClear as (
            handle: ReturnType<typeof setInterval>
          ) => void
        }
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WallClockTimeoutError);
    expect((thrown as WallClockTimeoutError).trigger).toBe("wall_clock");
    expect((thrown as WallClockTimeoutError).elapsedMs).toBeGreaterThanOrEqual(
      60_000
    );
  });

  it("rejects with WallClockTimeoutError when fn never settles AND ignores abort", async () => {
    // Root-cause regression: on Node 24 a stalled undici socket does NOT honor
    // controller.abort(), so a fetch that ignores its signal would leave
    // `await fn(signal)` pending forever — the worker hangs, the catch never
    // runs, the pool wedges. The Promise.race backstop must make the OUTER
    // promise reject on timeout even though the inner promise neither resolves
    // nor reacts to the abort. WITHOUT the fix this test hangs until the vitest
    // test timeout; WITH the fix it rejects promptly with WallClockTimeoutError.
    const setTimeoutMock = (handler: () => void) => {
      queueMicrotask(handler);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    };
    const noopInterval = (() => 0) as unknown as typeof setInterval;
    const noopClear = (() => undefined) as (handle: unknown) => void;

    let thrown: unknown = null;
    try {
      await withWallClockTimeout(
        // Deliberately ignores the abort signal and never settles — the exact
        // stalled-socket shape controller.abort() cannot terminate.
        () => new Promise<string>(() => {}),
        { budgetMs: 60_000 },
        {
          setTimeoutImpl: setTimeoutMock as unknown as (
            h: () => void,
            ms: number
          ) => ReturnType<typeof setTimeout>,
          clearTimeoutImpl: noopClear as (
            handle: ReturnType<typeof setTimeout>
          ) => void,
          setIntervalImpl: noopInterval as unknown as (
            h: () => void,
            ms: number
          ) => ReturnType<typeof setInterval>,
          clearIntervalImpl: noopClear as (
            handle: ReturnType<typeof setInterval>
          ) => void
        }
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WallClockTimeoutError);
    expect((thrown as WallClockTimeoutError).trigger).toBe("monotonic");
    expect((thrown as WallClockTimeoutError).budgetMs).toBe(60_000);
  });

  it("rejects with wall_clock trigger when a stalled fn ignores abort after suspend", async () => {
    // Same stalled-socket shape as above but the monotonic timer never fires
    // (host suspend pauses libuv); the setInterval tick after resume detects
    // the elapsed budget and the backstop rejects with the wall_clock trigger.
    const noopTimeout = (() => 0) as unknown as typeof setTimeout;
    const noopClear = (() => undefined) as (handle: unknown) => void;
    let nowValue = 1_000_000;
    const nowMock = () => nowValue;
    let intervalHandler: (() => void) | null = null;
    const setIntervalMock = (handler: () => void) => {
      intervalHandler = handler;
      // Fire the resume tick on a macrotask so fn() is in flight first.
      setTimeout(() => {
        nowValue += 90_000;
        intervalHandler?.();
      }, 0);
      return 0 as unknown as ReturnType<typeof setInterval>;
    };

    let thrown: unknown = null;
    try {
      await withWallClockTimeout(
        () => new Promise<string>(() => {}),
        { budgetMs: 60_000 },
        {
          now: nowMock,
          setTimeoutImpl: noopTimeout as unknown as (
            h: () => void,
            ms: number
          ) => ReturnType<typeof setTimeout>,
          clearTimeoutImpl: noopClear as (
            handle: ReturnType<typeof setTimeout>
          ) => void,
          setIntervalImpl: setIntervalMock as unknown as (
            h: () => void,
            ms: number
          ) => ReturnType<typeof setInterval>,
          clearIntervalImpl: noopClear as (
            handle: ReturnType<typeof setInterval>
          ) => void
        }
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WallClockTimeoutError);
    expect((thrown as WallClockTimeoutError).trigger).toBe("wall_clock");
    expect((thrown as WallClockTimeoutError).elapsedMs).toBeGreaterThanOrEqual(
      60_000
    );
  });

  it("propagates operator abort without remapping to WallClockTimeoutError", async () => {
    const noopTimeout = (() => 0) as unknown as typeof setTimeout;
    const noopInterval = (() => 0) as unknown as typeof setInterval;
    const noopClear = (() => undefined) as (handle: unknown) => void;
    const operator = new AbortController();
    operator.abort();
    let thrown: unknown = null;
    try {
      await withWallClockTimeout(
        async (signal) => {
          // signal should already be aborted because operator was pre-aborted.
          if (signal.aborted) {
            throw new Error("inner-saw-operator-abort");
          }
          return "should-not-reach";
        },
        { budgetMs: 60_000, operatorAbortSignal: operator.signal },
        {
          setTimeoutImpl: noopTimeout as unknown as (
            h: () => void,
            ms: number
          ) => ReturnType<typeof setTimeout>,
          clearTimeoutImpl: noopClear as (
            handle: ReturnType<typeof setTimeout>
          ) => void,
          setIntervalImpl: noopInterval as unknown as (
            h: () => void,
            ms: number
          ) => ReturnType<typeof setInterval>,
          clearIntervalImpl: noopClear as (
            handle: ReturnType<typeof setInterval>
          ) => void
        }
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("inner-saw-operator-abort");
    expect(thrown).not.toBeInstanceOf(WallClockTimeoutError);
  });

  it("settles (not hangs) when operator pre-aborts before budget AND fn ignores abort and never settles", async () => {
    // I-1 root-cause regression. Operator aborts BEFORE the budget fires, then
    // the inner fn is the abort-ignoring stalled socket (the exact Node-24
    // shape this helper targets) that never settles. Before the fix, fire()'s
    // `signal.aborted` guard returned WITHOUT rejecting the settlement, so
    // Promise.race([inner, settlement]) never settled and the outer await hung
    // forever. The operator-abort path must settle the race with an
    // abort-flavored error — NOT a WallClockTimeoutError — within budget.
    // WITHOUT the fix this test hangs until the vitest test timeout.
    const setTimeoutMock = (handler: () => void) => {
      // Defer the monotonic fire to a macrotask so the operator pre-abort and
      // the stalled fn are both in flight first; even when it fires it must
      // hit the guard and NOT be what settles the race.
      setTimeout(handler, 0);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    };
    const noopInterval = (() => 0) as unknown as typeof setInterval;
    const noopClear = (() => undefined) as (handle: unknown) => void;
    const operator = new AbortController();
    operator.abort();

    let thrown: unknown = null;
    try {
      await withWallClockTimeout(
        // Ignores the abort signal and never settles — the stalled-socket
        // shape controller.abort() cannot terminate.
        () => new Promise<string>(() => {}),
        { budgetMs: 60_000, operatorAbortSignal: operator.signal },
        {
          setTimeoutImpl: setTimeoutMock as unknown as (
            h: () => void,
            ms: number
          ) => ReturnType<typeof setTimeout>,
          clearTimeoutImpl: noopClear as (
            handle: ReturnType<typeof setTimeout>
          ) => void,
          setIntervalImpl: noopInterval as unknown as (
            h: () => void,
            ms: number
          ) => ReturnType<typeof setInterval>,
          clearIntervalImpl: noopClear as (
            handle: ReturnType<typeof setInterval>
          ) => void
        }
      );
    } catch (error) {
      thrown = error;
    }
    // Settled (not a hang) with an abort-flavored error, never remapped to a
    // WallClockTimeoutError for an operator abort.
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(WallClockTimeoutError);
    expect((thrown as Error).name).toBe("OperatorAbortError");
  });

  it("settles when operator aborts MID-FLIGHT and the in-flight fn ignores abort and never settles", async () => {
    // The listener path (operator not pre-aborted): fn starts, operator aborts
    // mid-flight, fn ignores the abort and never settles. The mid-flight
    // listener must settle the race with the abort-flavored error too.
    const noopTimeout = (() => 0) as unknown as typeof setTimeout;
    const noopInterval = (() => 0) as unknown as typeof setInterval;
    const noopClear = (() => undefined) as (handle: unknown) => void;
    const operator = new AbortController();

    let thrown: unknown = null;
    try {
      await withWallClockTimeout(
        () =>
          new Promise<string>(() => {
            // Abort mid-flight, after fn is in flight, on a microtask.
            queueMicrotask(() => operator.abort());
          }),
        { budgetMs: 60_000, operatorAbortSignal: operator.signal },
        {
          setTimeoutImpl: noopTimeout as unknown as (
            h: () => void,
            ms: number
          ) => ReturnType<typeof setTimeout>,
          clearTimeoutImpl: noopClear as (
            handle: ReturnType<typeof setTimeout>
          ) => void,
          setIntervalImpl: noopInterval as unknown as (
            h: () => void,
            ms: number
          ) => ReturnType<typeof setInterval>,
          clearIntervalImpl: noopClear as (
            handle: ReturnType<typeof setInterval>
          ) => void
        }
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(WallClockTimeoutError);
    expect((thrown as Error).name).toBe("OperatorAbortError");
  });
});
