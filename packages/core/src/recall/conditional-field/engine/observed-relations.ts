import { PersistentStringMap } from "@do-soul/alaya-graph-algorithms";
import type { RelationObserverRow } from "../observers/observe.js";

export type ObservedRelationRows = Iterable<RelationObserverRow> & Readonly<{
  length: number; at(index: number): RelationObserverRow | undefined;
}>;

type EvidenceReceipt = NonNullable<RelationObserverRow["evidenceReceipts"]>[number];
type SourceObservation = NonNullable<RelationObserverRow["sourceObservations"]>[number];

/** Native pages replace one assertion version without copying retained history. */
export class ObservedRelations implements ObservedRelationRows {
  public constructor(private readonly rows = new PersistentStringMap<RelationObserverRow>(), public readonly bytes = 0) {}
  public get length(): number { return this.rows.size; }
  public at(index: number): RelationObserverRow | undefined { return this.rows.entryAt(index)?.[1]; }
  public [Symbol.iterator](): MapIterator<RelationObserverRow> { return this.rows.values(); }

  public with(row: RelationObserverRow): ObservedRelations {
    const before = this.rows.get(row.assertionId);
    const receipts = mergeReceipts(before?.evidenceReceipts, row.evidenceReceipts);
    const next: RelationObserverRow = {
      ...row,
      evidenceRefs: mergeUnique(before?.evidenceRefs, row.evidenceRefs),
      evidenceReceipts: receipts
    };
    if (before !== undefined && sameRelationRow(before, next)) return this;
    const nextBytes = relationRowBytes(next);
    const previousBytes = before === undefined ? 0 : relationRowBytes(before);
    return new ObservedRelations(this.rows.with(row.assertionId, next), this.bytes + nextBytes - previousBytes);
  }
}

function mergeUnique(
  prior: readonly string[] | undefined,
  incoming: readonly string[] | undefined
): readonly string[] {
  if (prior === undefined || prior.length === 0) return incoming ?? [];
  if (incoming === undefined || incoming.length === 0) return prior;
  return [...new Set([...prior, ...incoming])];
}

function mergeReceipts(
  prior: readonly EvidenceReceipt[] | undefined,
  incoming: readonly EvidenceReceipt[] | undefined
): readonly EvidenceReceipt[] {
  if (prior === undefined || prior.length === 0) return incoming ?? [];
  if (incoming === undefined || incoming.length === 0) return prior;
  const receipts = new Map(prior.map((receipt) => [receipt.evidenceId, receipt]));
  for (const receipt of incoming) receipts.set(receipt.evidenceId, receipt);
  return [...receipts.values()];
}

function sameRelationRow(before: RelationObserverRow, next: RelationObserverRow): boolean {
  return before.assertionId === next.assertionId
    && before.sourceObjectId === next.sourceObjectId
    && before.targetObjectId === next.targetObjectId
    && before.resultObjectId === next.resultObjectId
    && before.predicate === next.predicate
    && before.validity === next.validity
    && before.source_revision === next.source_revision
    && before.resolutionKind === next.resolutionKind
    && before.resolvedAt === next.resolvedAt
    && before.source_event_id === next.source_event_id
    && before.occurred_at === next.occurred_at
    && sameStrings(before.evidenceRefs, next.evidenceRefs)
    && sameReceipts(before.evidenceReceipts, next.evidenceReceipts)
    && sameSourceObservations(before.sourceObservations, next.sourceObservations);
}

function sameStrings(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return (left?.length ?? 0) === 0 && (right?.length ?? 0) === 0;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function sameReceipts(
  left: readonly EvidenceReceipt[] | undefined,
  right: readonly EvidenceReceipt[] | undefined
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return (left?.length ?? 0) === 0 && (right?.length ?? 0) === 0;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const prior = left[index]!;
    const next = right[index]!;
    if (prior.evidenceId !== next.evidenceId || prior.eventId !== next.eventId
      || prior.eventType !== next.eventType || prior.occurredAt !== next.occurredAt) {
      return false;
    }
  }
  return true;
}

function sameSourceObservations(
  left: readonly SourceObservation[] | undefined,
  right: readonly SourceObservation[] | undefined
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return (left?.length ?? 0) === 0 && (right?.length ?? 0) === 0;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const prior = left[index]!;
    const next = right[index]!;
    if (prior.source_id !== next.source_id || prior.source_sha256 !== next.source_sha256) return false;
  }
  return true;
}

function relationRowBytes(row: RelationObserverRow): number {
  let bytes = row.assertionId.length + row.sourceObjectId.length + row.targetObjectId.length
    + row.resultObjectId.length + row.predicate.length
    + (row.source_revision?.length ?? 0) + (row.resolutionKind?.length ?? 0)
    + (row.resolvedAt?.length ?? 0) + (row.source_event_id?.length ?? 0)
    + (row.occurred_at?.length ?? 0);
  for (const ref of row.evidenceRefs ?? []) bytes += ref.length;
  for (const receipt of row.evidenceReceipts ?? []) {
    bytes += receipt.evidenceId.length + receipt.eventId.length + receipt.eventType.length + receipt.occurredAt.length;
  }
  for (const observation of row.sourceObservations ?? []) {
    bytes += observation.source_id.length + observation.source_sha256.length;
  }
  return bytes;
}
