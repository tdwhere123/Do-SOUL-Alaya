import { describe, expect, it } from "vitest";
import { ObservedSourceFacts, recordObservedAt } from "../../../recall/runtime/observed-source-facts.js";

describe("source fact change capture", () => {
  it("binds actual changed keys to exact snapshots and deduplicates repeated writes", () => {
    const facts = new ObservedSourceFacts();
    const before = facts.snapshot;
    const tracked = facts.captureChanges(() => {
      const fact = { object_id: "source", source_revision: "rev" };
      facts.set("qualified-key", fact).set("qualified-key", fact);
      facts.set("qualified-key", { ...fact, source_revision: "new" });
      return "result";
    }, { work: 10, bytes: 1024 });
    expect(tracked.value).toBe("result");
    expect(tracked.changes.before).toBe(before);
    expect(tracked.changes.after).toBe(facts.snapshot);
    expect([...tracked.changes.keys!]).toEqual(["qualified-key"]);
    expect(tracked.work).toBe(2);
    expect(tracked.bytes).toBeGreaterThan(0);
    facts.set("later", { object_id: "later" });
    expect(tracked.changes.after.has("later")).toBe(false);
    expect([...tracked.changes.keys!]).toEqual(["qualified-key"]);
  });

  it.each([{ work: 1, bytes: 1024 }, { work: 10, bytes: 1 }])("reports unknown instead of a partial delta at its limit: %j", (limits) => {
    const facts = new ObservedSourceFacts();
    const tracked = facts.captureChanges(() => {
      for (const object_id of ["first", "second", "third"]) facts.set(object_id, { object_id });
    }, limits);
    expect(tracked.changes.keys).toBeUndefined();
    expect(tracked.changes.after.size).toBe(3);
    expect(tracked.work).toBeLessThanOrEqual(limits.work);
    expect(tracked.bytes).toBeLessThanOrEqual(limits.bytes);
  });

  it("retains writes from an observed row even when the caller subsequently filters it", () => {
    const facts = new ObservedSourceFacts();
    const captured = ["old-dependent-endpoint", "new-endpoint"];
    const tracked = facts.captureChanges(() => {
      recordObservedAt({ workspace_id: "workspace", authorized_scopes: null, sourceCache: new Map(captured.map(objectId => [objectId, {
        row: { object_id: objectId, sourceRevision: "rev", lifecycle_state: "active", scope_class: "project" },
        rowsRead: 1, bytesRead: 32, unavailable: false
      }])) }, [...captured, "unfunded-endpoint"], {}, facts);
      captured.shift();
    }, { work: 2, bytes: 1024 });
    expect(captured).toEqual(["new-endpoint"]);
    expect([...tracked.changes.keys!]).toEqual(["old-dependent-endpoint", "new-endpoint"]);
    expect(facts.has("unfunded-endpoint")).toBe(false);
  });

  it("restores the capture scope after an exception and preserves enclosing coverage", () => {
    const facts = new ObservedSourceFacts();
    const outer = facts.captureChanges(() => {
      expect(() => facts.captureChanges(() => {
        facts.set("inner", { object_id: "inner" });
        throw new Error("reader failed");
      }, { work: 1, bytes: 128 })).toThrow("reader failed");
      facts.set("outer", { object_id: "outer" });
    }, { work: 2, bytes: 256 });
    expect([...outer.changes.keys!]).toEqual(["inner", "outer"]);
    facts.set("later", { object_id: "later" });
    expect([...outer.changes.keys!]).toEqual(["inner", "outer"]);
  });
});
