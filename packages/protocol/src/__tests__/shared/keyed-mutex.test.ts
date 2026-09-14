import { describe, expect, it } from "vitest";
import { KeyedMutex } from "../../shared/keyed-mutex.js";

describe("KeyedMutex", () => {
  it("serializes tasks for the same key in arrival order", async () => {
    const mutex = new KeyedMutex();
    const order: number[] = [];
    let active = 0;
    let maxActive = 0;

    const make = (id: number) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 3));
      order.push(id);
      active -= 1;
    };

    await Promise.all([
      mutex.runExclusive("k", make(1)),
      mutex.runExclusive("k", make(2)),
      mutex.runExclusive("k", make(3))
    ]);

    expect(maxActive).toBe(1);
    expect(order).toEqual([1, 2, 3]);
  });

  it("deletes the map entry after the last waiter for a key drains", async () => {
    const mutex = new KeyedMutex();
    expect(mutex.trackedKeyCount).toBe(0);

    await mutex.runExclusive("k", async () => {
      expect(mutex.trackedKeyCount).toBe(1);
    });
    expect(mutex.trackedKeyCount).toBe(0);
  });
});
