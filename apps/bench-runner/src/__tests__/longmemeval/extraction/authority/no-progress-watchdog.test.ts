import { describe, expect, it } from "vitest";
import {
  ExtractionNoProgressError,
  createExtractionNoProgressWatchdog
} from "../../../../longmemeval/extraction/authority/no-progress-watchdog.js";

describe("extraction no-progress watchdog", () => {
  it("aborts only after a full no-progress window and resets on durable progress", () => {
    let now = 0;
    let tick: (() => void) | undefined;
    const cleared: unknown[] = [];
    const schedule = ((callback: () => void) => {
      tick = callback;
      return { unref: () => undefined } as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    const watchdog = createExtractionNoProgressWatchdog({
      timeoutMs: 1_800_000,
      now: () => now,
      setInterval: schedule,
      clearInterval: (timer) => { cleared.push(timer); }
    });

    now = 1_799_999;
    tick?.();
    expect(watchdog.signal.aborted).toBe(false);
    watchdog.markProgress();
    now = 3_599_998;
    tick?.();
    expect(watchdog.signal.aborted).toBe(false);
    now = 3_599_999;
    tick?.();

    expect(watchdog.signal.reason).toBeInstanceOf(ExtractionNoProgressError);
    watchdog.dispose();
    expect(cleared).toHaveLength(1);
  });

  it("forwards an operator signal without changing its exit-relevant reason", () => {
    const operator = new AbortController();
    const watchdog = createExtractionNoProgressWatchdog({
      timeoutMs: 1_800_000,
      externalSignal: operator.signal
    });
    const reason = new Error("SIGTERM");

    operator.abort(reason);

    expect(watchdog.signal.aborted).toBe(true);
    expect(watchdog.signal.reason).toBe(reason);
    watchdog.dispose();
  });
});
