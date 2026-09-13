import { describe, expect, it } from "vitest";
import { KeyedMutex as CoreKeyedMutex } from "../../governance/keyed-mutex.js";
import { KeyedMutex as SoulKeyedMutex } from
  "../../../../soul/src/garden/scheduling/keyed-mutex.js";

describe("KeyedMutex copies", () => {
  it("serializes the same key in arrival order on both layers", async () => {
    const run = async (Mutex: new () => {
      runExclusive<T>(key: string, task: () => Promise<T>): Promise<T>;
    }): Promise<readonly string[]> => {
      const mutex = new Mutex();
      const order: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = mutex.runExclusive("k", async () => {
        order.push("a:start");
        await gate;
        order.push("a:end");
      });
      const second = mutex.runExclusive("k", async () => {
        order.push("b");
      });
      await Promise.resolve();
      expect(order).toEqual(["a:start"]);
      release();
      await Promise.all([first, second]);
      return order;
    };

    expect(await run(CoreKeyedMutex)).toEqual(["a:start", "a:end", "b"]);
    expect(await run(SoulKeyedMutex)).toEqual(["a:start", "a:end", "b"]);
  });
});
