import { describe, expect, it } from "vitest";
import { KeyedMutex } from "../../shared/keyed-mutex.js";

// invariant: covers the per-key in-process async mutex — strict
// serialization per key, concurrency across distinct keys, lock release
// on throw, and the no-leak cleanup (the map entry is deleted once the
// last waiter for a key drains).
// see also: packages/core/src/shared/keyed-mutex.ts

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

  it("runs tasks for distinct keys concurrently", async () => {
    const mutex = new KeyedMutex();
    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Each task parks on a shared gate so all three are observed active
    // before any releases, independent of scheduler timing.
    const task = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gate;
      active -= 1;
    };

    const all = Promise.all([
      mutex.runExclusive("a", task),
      mutex.runExclusive("b", task),
      mutex.runExclusive("c", task)
    ]);

    await Promise.resolve();
    release();
    await all;

    expect(maxActive).toBe(3);
  });

  it("releases the lock when the task throws", async () => {
    const mutex = new KeyedMutex();

    await expect(
      mutex.runExclusive("k", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    const result = await mutex.runExclusive("k", async () => "ok");
    expect(result).toBe("ok");
  });

  it("deletes the map entry after the last waiter for a key drains", async () => {
    const mutex = new KeyedMutex();
    expect(mutex.trackedKeyCount).toBe(0);

    await mutex.runExclusive("k", async () => {
      expect(mutex.trackedKeyCount).toBe(1);
    });
    expect(mutex.trackedKeyCount).toBe(0);

    await Promise.all([
      mutex.runExclusive("k", async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }),
      mutex.runExclusive("k", async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
      })
    ]);
    expect(mutex.trackedKeyCount).toBe(0);

    await Promise.all([
      mutex.runExclusive("a", async () => undefined),
      mutex.runExclusive("b", async () => undefined)
    ]);
    expect(mutex.trackedKeyCount).toBe(0);
  });
});
