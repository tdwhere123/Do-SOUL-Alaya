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

  it("refuses oversized and workspace-over-cap records without evicting valid executions", () => {
    const store = new RecallExecutionRetention(5_000, 2_000, 100);
    const small = { execution: "a", workspace: "one", bytes: 1_000, handles: ["a"], value: { retained: true } };
    store.set("field:a", small);
    expect(() => store.set("field:b", { ...small, execution: "b", handles: ["b"] }))
      .toThrowError(expect.objectContaining({ details: expect.objectContaining({ resource: "execution_retention" }) }));
    store.set("field:c", { ...small, execution: "c", workspace: "two", handles: ["c"] });
    expect(store.executionFor("a")).toBe("a");
    expect(store.executionFor("c")).toBe("c");
    expect(() => store.set("oversized", { ...small, bytes: 10_000 })).toThrow();
    expect(store.snapshot().executions).toBe(2);
    store.invalidate("a"); store.invalidate("c");
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
