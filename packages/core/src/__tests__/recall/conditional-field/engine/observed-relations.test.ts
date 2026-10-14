import { describe, expect, it, vi } from "vitest";
import { checkRetainedRelationFacts, ObservedRelations, retainRelationPage } from "../../../../recall/conditional-field/engine/observed-relations.js";
import type { RelationObserverRow } from "../../../../recall/conditional-field/observers/observe.js";
import type { QueryProgram } from "@do-soul/alaya-protocol";
import { ObservedSourceFacts } from "../../../../recall/runtime/observed-source-facts.js";

describe("observed relation merge", () => {
  it("returns the same collection when receipts are unchanged without serializing the row", () => {
    const stringify = vi.spyOn(JSON, "stringify");
    const rows = new ObservedRelations().with(relationRow());
    stringify.mockClear();
    const next = rows.with(relationRow());
    expect(next).toBe(rows);
    expect(stringify).not.toHaveBeenCalled();
    stringify.mockRestore();
  });

  it("keeps added receipts and grows retained bytes without rewriting an unchanged assertion", () => {
    const first = new ObservedRelations().with(relationRow({
      evidenceReceipts: [{ evidenceId: "e1", eventId: "ev1", eventType: "observed", occurredAt: "t0" }]
    }));
    const merged = first.with(relationRow({
      evidenceReceipts: [{ evidenceId: "e2", eventId: "ev2", eventType: "observed", occurredAt: "t1" }]
    }));
    expect(merged).not.toBe(first);
    expect(merged.at(0)?.evidenceReceipts).toHaveLength(2);
    expect(merged.bytes).toBeGreaterThan(first.bytes);
  });
});

describe("retained endpoint dependencies", () => {
  const program: QueryProgram = { schema_version: 1, kind: "relation", relation_kind: "observed_log",
    source_variable: "x", target_variable: "y", facet_mode: "same_path", threshold_milligrades: 0,
    guard: { schema_version: 1, kind: "query_predicate", verdict: "true", time_scope: "none" } };

  it("preserves shared endpoints, self loops and immutable forks while replacing an assertion", () => {
    const original = new ObservedRelations().with(relationRow())
      .with(relationRow({ assertionId: "a2", sourceObjectId: "dst", targetObjectId: "dst" }));
    const moved = original.with(relationRow({ sourceObjectId: "new", targetObjectId: "new" }));
    expect(moved.hasEndpoint("src")).toBe(false);
    expect(moved.hasEndpoint("dst")).toBe(true);
    expect(moved.hasEndpoint("new")).toBe(true);
    expect(original.hasEndpoint("src")).toBe(true);
    expect(original.hasEndpoint("new")).toBe(false);
    const emptied = moved.with(relationRow({ assertionId: "a2", sourceObjectId: "new", targetObjectId: "new" }));
    expect(emptied.hasEndpoint("dst")).toBe(false);
    expect(emptied.bytes).toBeGreaterThanOrEqual(moved.bytes);
  });

  it("charges endpoint updates once per version and keeps receipt-only updates free of index work", () => {
    const first = new ObservedRelations().with(relationRow());
    expect(first.index_work).toBe(4);
    const receipt = first.with(relationRow({ evidenceRefs: ["evidence"] }));
    expect(receipt.index_work).toBe(first.index_work);
    const changed = relationRow({ targetObjectId: "changed" });
    const retained = retainRelationPage(receipt, [changed, changed]);
    expect(retained.changed).toHaveLength(1);
    expect(retained.work).toBe(8);
    expect(retained.population.hasEndpoint("dst")).toBe(false);
    expect(retained.population.bytes).toBeGreaterThan(receipt.bytes);
  });

  function check(rows: ObservedRelations, changedId: string, work = 100) {
    const facts = new ObservedSourceFacts();
    const tracked = facts.captureChanges(() => facts.set(changedId, { object_id: changedId, source_revision: "rev" }),
      { work: 10, bytes: 1024 });
    return checkRetainedRelationFacts({ rows, program, ...tracked.changes, changes: tracked.changes,
      work_limit: work, memory_limit: 1024 });
  }

  it("checks a fixed complete fact delta without scanning unrelated old rows", () => {
    const first = new ObservedRelations().with(relationRow());
    let many = first;
    for (let index = 0; index < 512; index += 1) many = many.with(relationRow({
      assertionId: `row-${index}`, sourceObjectId: `s-${index}`, targetObjectId: `t-${index}` }));
    const iteration = vi.spyOn(many, Symbol.iterator).mockImplementation(() => { throw new Error("old population scanned"); });
    try {
      expect(check(many, "unrelated")).toEqual(check(first, "unrelated"));
      expect(check(many, "unrelated")).toMatchObject({ unaffected: true, work: 2 });
      expect(check(many, "unrelated", 1)).toMatchObject({ unaffected: false, work: 1 });
    } finally { iteration.mockRestore(); }
  });

  it("invalidates absence reads at either endpoint", () => {
    const rows = new ObservedRelations().with(relationRow());
    expect(check(rows, "src").unaffected).toBe(false);
    expect(check(rows, "dst").unaffected).toBe(false);
  });

  it("falls back after restoration, incomplete capture or a mismatched snapshot", () => {
    const rows = ObservedRelations.unindexed().with(relationRow()).with(relationRow({ assertionId: "new", targetObjectId: "new" }));
    expect(rows.hasEndpoint("src")).toBeUndefined();
    expect(rows.index_work).toBe(0);
    expect(check(rows, "src").unaffected).toBe(false);
    expect(check(rows, "unrelated").work).toBeGreaterThan(2);
    const facts = new ObservedSourceFacts();
    const tracked = facts.captureChanges(() => facts.set("src", { object_id: "src", source_revision: "changed" }),
      { work: 0, bytes: 0 });
    const indexed = new ObservedRelations().with(relationRow());
    const input = { rows: indexed, program, before: tracked.changes.before, after: tracked.changes.after,
      work_limit: 100, memory_limit: 1024 };
    expect(checkRetainedRelationFacts({ ...input, changes: tracked.changes }).unaffected).toBe(false);
    expect(checkRetainedRelationFacts({ ...input, changes: { before: new Map(), after: input.after, keys: new Set() } }).unaffected).toBe(false);
  });
});

function relationRow(extra: Partial<RelationObserverRow> = {}): RelationObserverRow {
  return {
    assertionId: "a1",
    sourceObjectId: "src",
    targetObjectId: "dst",
    resultObjectId: "dst",
    predicate: "observed_log",
    ...extra
  };
}
