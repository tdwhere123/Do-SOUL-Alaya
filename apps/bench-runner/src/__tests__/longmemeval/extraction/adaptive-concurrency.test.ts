import { describe, expect, it } from "vitest";
import {
  createAdaptiveConcurrencyController
} from "../../../longmemeval/extraction/adaptive-concurrency.js";

describe("adaptive extraction concurrency", () => {
  it("starts a higher ceiling at its bounded initial concurrency", async () => {
    const controller = createAdaptiveConcurrencyController({ maximum: 64, initial: 32 });
    const signal = new AbortController().signal;

    expect(controller.snapshot()).toMatchObject({ maximum: 64, current: 32, active: 0 });
    await controller.acquire(signal);
    expect(controller.release(false)).toMatchObject({ current: 32, active: 0 });
    controller.dispose();
  });

  it("never backs off below an explicit minimum while the default remains one", async () => {
    const signal = new AbortController().signal;
    const bounded = createAdaptiveConcurrencyController({
      maximum: 32,
      initial: 8,
      minimumConcurrency: 8
    });
    await bounded.acquire(signal);
    expect(bounded.release(true)).toMatchObject({ minimum: 8, current: 8 });
    bounded.dispose();

    const defaulted = createAdaptiveConcurrencyController({ maximum: 2, initial: 2 });
    await defaulted.acquire(signal);
    expect(defaulted.release(true)).toMatchObject({ minimum: 1, current: 1 });
    defaulted.dispose();
  });

  it("rejects a minimum above the initial concurrency", () => {
    expect(() => createAdaptiveConcurrencyController({
      maximum: 32,
      initial: 4,
      minimumConcurrency: 8
    })).toThrow(/minimum.*initial/u);
  });

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
    for (let active = 0; active < 8; active += 1) await controller.acquire(signal);

    for (let active = 1; active < 8; active += 1) {
      expect(controller.release(true)).toMatchObject({
        current: 4,
        rateLimitBackoffs: 1,
        backoffMs: 250
      });
    }
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
    expect(controller.snapshot()).toMatchObject({ current: 4, active: 0 });
    await controller.acquire(signal);
    expect(controller.release(true)).toMatchObject({
      current: 2,
      rateLimitBackoffs: 2,
      backoffMs: 750
    });
  });

  it("adds one worker only after a successful concurrency window", async () => {
    const controller = createAdaptiveConcurrencyController({ maximum: 8, initial: 4 });
    const signal = new AbortController().signal;

    for (let completed = 0; completed < 3; completed += 1) {
      await controller.acquire(signal);
      expect(controller.release(false)).toMatchObject({ current: 4, active: 0 });
    }
    await controller.acquire(signal);
    expect(controller.release(false)).toMatchObject({ current: 5, active: 0 });
    for (let completed = 0; completed < 5; completed += 1) {
      await controller.acquire(signal);
      const expected = completed === 4 ? 6 : 5;
      expect(controller.release(false)).toMatchObject({ current: expected, active: 0 });
    }
    controller.dispose();
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
