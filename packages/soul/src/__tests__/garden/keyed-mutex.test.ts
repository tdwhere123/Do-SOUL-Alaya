import { describe, expect, it } from "vitest";
import { KeyedMutex } from "../../garden/keyed-mutex.js";

function defer<T>(): { readonly promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("KeyedMutex", () => {
  it("serializes same-key tasks in arrival order", async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    const first = defer<void>();

    const a = mutex.runExclusive("k", async () => {
      order.push("a:start");
      await first.promise;
      order.push("a:end");
    });
    const b = mutex.runExclusive("k", async () => {
      order.push("b:start");
      order.push("b:end");
    });

    // The second same-key task must not begin until the first releases.
    await Promise.resolve();
    expect(order).toEqual(["a:start"]);

    first.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("runs different keys concurrently", async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    const gate = defer<void>();

    const a = mutex.runExclusive("ka", async () => {
      order.push("a:start");
      await gate.promise;
      order.push("a:end");
    });
    const b = mutex.runExclusive("kb", async () => {
      order.push("b:start");
      order.push("b:end");
    });

    // b holds a different key, so it completes while a is still blocked.
    await b;
    expect(order).toEqual(["a:start", "b:start", "b:end"]);

    gate.resolve();
    await a;
    expect(order).toEqual(["a:start", "b:start", "b:end", "a:end"]);
  });

  it("releases the lock when a task throws", async () => {
    const mutex = new KeyedMutex();

    await expect(
      mutex.runExclusive("k", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    const result = await mutex.runExclusive("k", async () => "recovered");
    expect(result).toBe("recovered");
  });

  it("returns the task result", async () => {
    const mutex = new KeyedMutex();
    await expect(mutex.runExclusive("k", async () => 42)).resolves.toBe(42);
  });
});
