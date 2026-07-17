import { describe, expect, it } from "vitest";
import {
  createAdaptiveConcurrencyController
} from "../../../longmemeval/extraction/adaptive-concurrency.js";

describe("adaptive extraction concurrency", () => {
  it("halves concurrency and holds new work through exponential rate-limit backoff", async () => {
    let now = 0;
    let wake: (() => void) | undefined;
    const schedule = ((callback: () => void) => {
      wake = callback;
      return { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    const controller = createAdaptiveConcurrencyController({
      maximum: 8,
      now: () => now,
      setTimeout: schedule,
      clearTimeout: () => undefined
    });
    const signal = new AbortController().signal;
    await controller.acquire(signal);

    expect(controller.release(true)).toMatchObject({
      current: 4,
      rateLimitBackoffs: 1,
      backoffMs: 250
    });
    const blocked = controller.acquire(signal);
    await Promise.resolve();
    expect(controller.snapshot().active).toBe(0);
    now = 250;
    wake?.();
    await blocked;

    expect(controller.snapshot()).toMatchObject({ current: 4, active: 1 });
    controller.release(false);
    expect(controller.snapshot()).toMatchObject({ current: 5, active: 0 });
  });

  it("wakes and fails closed when the operator aborts while waiting", async () => {
    const controller = createAdaptiveConcurrencyController({ maximum: 1 });
    const first = new AbortController();
    const waiting = new AbortController();
    await controller.acquire(first.signal);
    const blocked = controller.acquire(waiting.signal);

    waiting.abort(new Error("SIGINT"));

    await expect(blocked).rejects.toThrow("SIGINT");
    controller.release(false);
    controller.dispose();
  });
});
