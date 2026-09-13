import { describe, expect, it, vi } from "vitest";
import { ObservedRelations } from "../../../../recall/conditional-field/engine/observed-relations.js";
import type { RelationObserverRow } from "../../../../recall/conditional-field/observers/observe.js";

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
