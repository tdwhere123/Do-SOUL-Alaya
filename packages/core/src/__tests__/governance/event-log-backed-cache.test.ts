import { describe, expect, it, vi } from "vitest";
import { EventLogBackedCache } from "../../governance/cache/event-log-backed-cache.js";

function createDeferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("EventLogBackedCache", () => {
  it("shares one in-flight EventLog load and reuses the cached result", async () => {
    const deferred = createDeferred<string>();
    const load = vi.fn(async () => await deferred.promise);
    const cache = new EventLogBackedCache<string>();

    const first = cache.resolve("run-1", load, (value) => value);
    const second = cache.resolve("run-1", load, (value) => value);
    deferred.resolve("rehydrated");

    await expect(Promise.all([first, second])).resolves.toEqual(["rehydrated", "rehydrated"]);
    await expect(cache.resolve("run-1", load, (value) => value)).resolves.toBe("rehydrated");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not let a stale load replace a value written while rehydrating", async () => {
    const deferred = createDeferred<string>();
    const cache = new EventLogBackedCache<string>();
    const pending = cache.resolve("run-1", async () => await deferred.promise, (value) => value);

    cache.set("run-1", "fresh");
    deferred.resolve("stale");

    await expect(pending).resolves.toBe("fresh");
    await expect(cache.resolve("run-1", async () => "other", (value) => value)).resolves.toBe("fresh");
  });

  it("evicts cached state when normalization makes it inactive", async () => {
    const load = vi.fn(async () => "rehydrated");
    const cache = new EventLogBackedCache<string>();

    await cache.resolve("run-1", load, (value) => value);
    expect(cache.refresh("run-1", () => undefined)).toBeUndefined();
    await expect(cache.resolve("run-1", load, (value) => value)).resolves.toBe("rehydrated");
    expect(load).toHaveBeenCalledTimes(2);
  });
});
