import { afterEach, describe, expect, it, vi } from "vitest";
import { RecallExecutionRetention, recallRetentionBytes } from "../../../recall/runtime/recall-execution-retention.js";

afterEach(() => vi.useRealTimers());

describe("Recall execution lease retention", () => {
  it("releases records and routing handles on elapsed time without another lookup", () => {
    vi.useFakeTimers();
    const store = new RecallExecutionRetention(10_000, 8_000, 100);
    const removed = vi.fn();
    store.subscribe(removed);
    store.set("field:a", { execution: "a", workspace: "one", bytes: 100, handles: ["token-a"], value: {} });
    store.set("prepared:a", { execution: "a", workspace: "one", bytes: 200, handles: ["token-a", "ack-a"], value: {} });
    vi.advanceTimersByTime(100);
    expect(removed).toHaveBeenCalledWith({ handles: ["token-a", "ack-a"], reason: "expired" });
    expect(store.snapshot()).toEqual({ entries: 0, executions: 0, retained_bytes: 0 });
  });

  it("evicts the least-recently-used other execution of the workspace instead of refusing", () => {
    const store = new RecallExecutionRetention(10_000, 3_000, 60_000);
    const removed = vi.fn(); store.subscribe(removed);
    const row = (execution: string, workspace = "one") =>
      ({ execution, workspace, bytes: 1_000, handles: [`h-${execution}`], value: { execution } });
    store.set("field:a", row("a"));
    store.set("field:b", row("b"));
    store.set("field:c", row("c", "two"));
    expect(store.get("field:a")).toEqual({ execution: "a" });
    store.set("field:d", row("d"));
    expect(removed).toHaveBeenCalledWith({ handles: ["h-b"], reason: "evicted" });
    expect(store.executionFor("h-a")).toBe("a");
    expect(store.executionFor("h-c")).toBe("c");
    expect(store.executionFor("h-d")).toBe("d");
    store.invalidate("a"); store.invalidate("c"); store.invalidate("d");
  });

  it("evicts only the same workspace's least-recently-used execution when global capacity is exceeded", () => {
    const store = new RecallExecutionRetention(5_000, 5_000, 60_000);
    const removed = vi.fn(); store.subscribe(removed);
    const row = (execution: string, workspace: string) =>
      ({ execution, workspace, bytes: 1_000, handles: [`h-${execution}`], value: { execution } });
    store.set("field:two-a", row("two-a", "two"));
    store.set("field:two-b", row("two-b", "two"));
    store.set("field:one-a", row("one-a", "one"));
    store.set("field:one-b", row("one-b", "one"));
    expect(removed).toHaveBeenCalledTimes(1);
    expect(removed).toHaveBeenCalledWith({ handles: ["h-one-a"], reason: "evicted" });
    expect(store.executionFor("h-two-a")).toBe("two-a");
    expect(store.executionFor("h-two-b")).toBe("two-b");
    expect(store.executionFor("h-one-b")).toBe("one-b");
    expect(store.executionFor("h-one-a")).toBeUndefined();
    store.invalidate("two-a"); store.invalidate("two-b"); store.invalidate("one-b");
  });

  it("refuses when global capacity is exceeded and the same workspace has no other execution to evict", () => {
    const store = new RecallExecutionRetention(3_000, 3_000, 60_000);
    const removed = vi.fn(); store.subscribe(removed);
    const row = (execution: string, workspace: string) =>
      ({ execution, workspace, bytes: 1_000, handles: [`h-${execution}`], value: { execution } });
    store.set("field:two-a", row("two-a", "two"));
    store.set("field:two-b", row("two-b", "two"));
    expect(() => store.set("field:one-a", row("one-a", "one")))
      .toThrowError(expect.objectContaining({
        code: "CONFLICT",
        details: expect.objectContaining({ resource: "execution_retention" })
      }));
    expect(removed).not.toHaveBeenCalled();
    expect(store.executionFor("h-two-a")).toBe("two-a");
    expect(store.executionFor("h-two-b")).toBe("two-b");
    expect(store.executionFor("h-one-a")).toBeUndefined();
    store.invalidate("two-a"); store.invalidate("two-b");
  });

  it("never evicts the incoming execution and refuses without evicting when nothing can make room", () => {
    const store = new RecallExecutionRetention(5_000, 3_000, 60_000);
    const removed = vi.fn(); store.subscribe(removed);
    const small = { execution: "a", workspace: "one", bytes: 1_000, handles: ["a"], value: {} };
    store.set("field:a", small);
    store.set("page:a", { ...small, handles: ["page-a"] });
    expect(() => store.set("prepared:a", { ...small, handles: ["ack-a"] }))
      .toThrowError(expect.objectContaining({ details: expect.objectContaining({ resource: "execution_retention" }) }));
    store.set("field:b", { ...small, execution: "b", workspace: "two", handles: ["b"] });
    expect(() => store.set("oversized", { ...small, execution: "c", bytes: 10_000 })).toThrow();
    expect(removed).not.toHaveBeenCalled();
    expect(store.snapshot().executions).toBe(2);
    store.invalidate("a"); store.invalidate("b");
  });

  it("restores evicted executions when the evicting transaction rolls back", () => {
    const store = new RecallExecutionRetention(10_000, 1_500, 60_000);
    const removed = vi.fn(); store.subscribe(removed);
    const kept = { kept: true };
    store.set("field:a", { execution: "a", workspace: "one", bytes: 1_000, handles: ["h-a"], value: kept });
    expect(() => store.transaction(() => {
      store.set("field:b", { execution: "b", workspace: "one", bytes: 1_000, handles: ["h-b"], value: {} });
      throw new Error("stale field");
    })).toThrow("stale field");
    expect(store.get("field:a")).toBe(kept);
    expect(removed).not.toHaveBeenCalled();
    store.invalidate("a");
  });

  it("lowers a record's charge without refusing or changing its value", () => {
    const store = new RecallExecutionRetention(10_000, 10_000, 60_000);
    const value = { settled: true };
    store.set("prepared:a", { execution: "a", workspace: "one", bytes: 5_000, handles: ["ack-a"], value });
    const before = store.snapshot().retained_bytes;
    store.reduce("prepared:a", 100);
    expect(store.snapshot().retained_bytes).toBe(before - 4_900);
    store.reduce("prepared:a", 9_000);
    expect(store.snapshot().retained_bytes).toBe(before - 4_900);
    expect(store.get("prepared:a")).toBe(value);
    store.invalidate("a");
  });

  it("rolls back an unsuccessful page and field transaction without revoking prior handles", () => {
    const store = new RecallExecutionRetention(5_000, 5_000);
    const removed = vi.fn(); store.subscribe(removed);
    const previous = { page: "winner" };
    store.set("page:a", { execution: "a", workspace: "one", bytes: 100, handles: ["old"], value: previous });
    const before = store.snapshot();
    expect(() => store.transaction(() => {
      store.delete("page:a");
      store.set("page:a", { execution: "a", workspace: "one", bytes: 1_000, handles: ["loser"], value: {} });
      throw new Error("stale field");
    })).toThrow("stale field");
    expect(store.get("page:a")).toBe(previous);
    expect(store.snapshot()).toEqual(before);
    expect(removed).not.toHaveBeenCalled();
    store.invalidate("a");
  });

  it("counts the complete retained backing buffer of a small typed-array view", () => {
    const backing = new ArrayBuffer(65_536);
    expect(recallRetentionBytes(new Uint8Array(backing, 0, 1))).toBeGreaterThanOrEqual(65_536);
    expect(recallRetentionBytes(new Map([["large", "x".repeat(5_000)]]))).toBeGreaterThan(10_000);
  });
});
