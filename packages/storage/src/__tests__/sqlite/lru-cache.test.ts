import { describe, expect, it } from "vitest";
import { LruCache } from "../../sqlite/lru-cache.js";

describe("LruCache", () => {
  it("returns undefined for missing keys", () => {
    const cache = new LruCache<string, number>(2);
    expect(cache.get("missing")).toBeUndefined();
  });

  it("promotes touched entries so the oldest evicts first", () => {
    const cache = new LruCache<string, string>(2);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.get("a");
    cache.set("c", "3");

    expect(cache.get("a")).toBe("1");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe("3");
  });

  it("deleteOldest removes the least recently used entry", () => {
    const cache = new LruCache<string, number>(3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.get("a");

    expect(cache.deleteOldest()).toBe(2);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
  });

  it("set on an existing key refreshes without evicting others", () => {
    const cache = new LruCache<string, string>(2);
    cache.set("a", "old");
    cache.set("b", "2");
    cache.set("a", "new");

    expect(cache.size).toBe(2);
    expect(cache.get("a")).toBe("new");
    expect(cache.get("b")).toBe("2");
  });
});
