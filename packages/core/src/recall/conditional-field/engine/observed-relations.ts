import { PersistentStringMap } from "@do-soul/alaya-graph-algorithms";
import type { RelationObserverRow } from "../observers/observe.js";

export type ObservedRelationRows = Iterable<RelationObserverRow> & Readonly<{
  length: number; at(index: number): RelationObserverRow | undefined;
}>;

/** Native pages replace one assertion version without copying retained history. */
export class ObservedRelations implements ObservedRelationRows {
  public constructor(private readonly rows = new PersistentStringMap<RelationObserverRow>(), public readonly bytes = 0) {}
  public get length(): number { return this.rows.size; }
  public at(index: number): RelationObserverRow | undefined { return this.rows.entryAt(index)?.[1]; }
  public [Symbol.iterator](): MapIterator<RelationObserverRow> { return this.rows.values(); }

  public with(row: RelationObserverRow): ObservedRelations {
    const before = this.rows.get(row.assertionId);
    const receipts = new Map([...(before?.evidenceReceipts ?? []), ...(row.evidenceReceipts ?? [])].map((receipt) => [receipt.evidenceId, receipt]));
    const next = { ...row, evidenceRefs: [...new Set([...(before?.evidenceRefs ?? []), ...(row.evidenceRefs ?? [])])],
      evidenceReceipts: [...receipts.values()] };
    const serialized = JSON.stringify(next);
    const previous = before === undefined ? undefined : JSON.stringify(before);
    if (serialized === previous) return this;
    return new ObservedRelations(this.rows.with(row.assertionId, next), this.bytes + Buffer.byteLength(serialized, "utf8")
      - (previous === undefined ? 0 : Buffer.byteLength(previous, "utf8")));
  }
}
