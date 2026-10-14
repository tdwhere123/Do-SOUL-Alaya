import { PersistentStringMap } from "@do-soul/alaya-graph-algorithms";
import type { QueryProgram } from "@do-soul/alaya-protocol";
import type { RelationObserverRow } from "../observers/observe.js";
import { visitQueryProgram } from "../query/query-admission.js";
import { guardSourceFactDependency, type BoundSourceFacts } from "./binding-environment.js";

export type ObservedRelationRows = Iterable<RelationObserverRow> & Readonly<{
  length: number; at(index: number): RelationObserverRow | undefined;
}>;

type EvidenceReceipt = NonNullable<RelationObserverRow["evidenceReceipts"]>[number];
type SourceObservation = NonNullable<RelationObserverRow["sourceObservations"]>[number];

/** Native pages replace one assertion version without copying retained history. */
export class ObservedRelations implements ObservedRelationRows {
  public constructor(
    private readonly rows = new PersistentStringMap<RelationObserverRow>(),
    public readonly bytes = 0,
    private readonly endpoints: PersistentStringMap<number> | null = rows.size === 0 ? new PersistentStringMap() : null,
    public readonly index_work = 0
  ) {}
  /** Withdrawal restores plain rows. Missing index coverage must never imply independence. */
  public static unindexed(): ObservedRelations { return new ObservedRelations(undefined, 0, null); }
  public get length(): number { return this.rows.size; }
  public at(index: number): RelationObserverRow | undefined { return this.rows.entryAt(index)?.[1]; }
  public get(assertionId: string): RelationObserverRow | undefined { return this.rows.get(assertionId); }
  public [Symbol.iterator](): MapIterator<RelationObserverRow> { return this.rows.values(); }
  public hasEndpoint(id: string): boolean | undefined {
    return this.endpoints === null ? undefined : (this.endpoints.get(id) ?? 0) > 0;
  }

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
    let endpoints = this.endpoints, indexBytes = 0, indexWork = 0;
    if (endpoints !== null && (before?.sourceObjectId !== next.sourceObjectId || before?.targetObjectId !== next.targetObjectId)) {
      const adjust = (id: string, delta: number): void => {
        const count = endpoints!.get(id);
        // Zero-count keys remain allocated in the persistent map and keep their charge.
        if (count === undefined) indexBytes += 64 + Buffer.byteLength(id, "utf8");
        endpoints = endpoints!.with(id, (count ?? 0) + delta);
        indexWork += 2;
      };
      if (before !== undefined) { adjust(before.sourceObjectId, -1); adjust(before.targetObjectId, -1); }
      adjust(next.sourceObjectId, 1); adjust(next.targetObjectId, 1);
    }
    return new ObservedRelations(this.rows.with(row.assertionId, next), this.bytes + nextBytes - previousBytes + indexBytes,
      endpoints, this.index_work + indexWork);
  }
}

/** Pages admit assertion versions. Index order is by key, so a length suffix is not the delta. */
export function retainRelationPage(
  population: ObservedRelations,
  captured: readonly RelationObserverRow[]
): Readonly<{ readonly population: ObservedRelations; readonly changed: readonly RelationObserverRow[]; readonly work: number }> {
  const touched: string[] = [];
  const seen = new Set<string>();
  let next = population;
  for (const row of captured) {
    const stored = next.with(row);
    if (stored === next) continue;
    next = stored;
    if (seen.has(row.assertionId)) continue;
    seen.add(row.assertionId);
    touched.push(row.assertionId);
  }
  const changed: RelationObserverRow[] = [];
  for (const assertionId of touched) {
    const admitted = next.get(assertionId);
    if (admitted !== undefined) changed.push(admitted);
  }
  return { population: next, changed, work: next.index_work - population.index_work };
}

/** A fact change or a full id cover is a complete pass. One id is one changed row. */
export function relationPageJoinRows(
  population: ObservedRelations,
  changed: readonly RelationObserverRow[],
  factsChanged: boolean
): readonly RelationObserverRow[] | undefined {
  if (factsChanged) return undefined;
  const ids = new Set(changed.map((row) => row.assertionId));
  if (ids.size === population.length) return undefined;
  return changed;
}

/** A changed snapshot can leave every prior row admission unchanged. Unknown dependencies keep the full pass. */
export function checkRetainedRelationFacts(input: Readonly<{
  rows: ObservedRelationRows; program: QueryProgram;
  before: ReadonlyMap<string, BoundSourceFacts>; after: ReadonlyMap<string, BoundSourceFacts>;
  changes?: Readonly<{
    before: ReadonlyMap<string, BoundSourceFacts>; after: ReadonlyMap<string, BoundSourceFacts>;
    keys: ReadonlySet<string> | undefined;
  }>;
  work_limit: number; memory_limit: number;
}>): Readonly<{ unaffected: boolean; work: number; admitted_bytes: number }> {
  const scratchBytes = 512;
  if (input.memory_limit < scratchBytes || input.work_limit < 1) return { unaffected: false, work: 0, admitted_bytes: 0 };
  const stop = {}, env = new Map<string, string>(), endpoints = { sourceId: "source", targetId: "target" };
  let work = 0;
  const charge = (units: number): void => {
    if (work + units > input.work_limit) throw stop;
    work += units;
  };
  try {
    visitQueryProgram(input.program, (node) => {
      charge(1);
      if (node.kind !== "relation") return;
      // Named predicates can decode source filters; the bounded optional check leaves them to the full pass.
      if (node.guard.predicate_name !== undefined) throw stop;
      // Give the guard owner a bound object so a missing variable cannot hide a dependency.
      env.clear();
      if (node.guard.variable !== undefined) env.set(node.guard.variable, node.guard.variable);
      if (guardSourceFactDependency(node.guard, env, endpoints) !== undefined) throw stop;
    });
    const changes = input.changes;
    if (input.rows instanceof ObservedRelations && changes?.keys !== undefined
      && changes.before === input.before && changes.after === input.after) {
      let covered = true;
      for (const id of changes.keys) {
        charge(1);
        const used = input.rows.hasEndpoint(id);
        if (used === undefined) { covered = false; break; }
        if (used) throw stop;
      }
      if (covered) return { unaffected: true, work, admitted_bytes: scratchBytes };
    }
    for (const row of input.rows) {
      charge(4);
      // Target facts carry revision and interpretation identity; source facts can supply the revision fallback.
      if (input.before.get(row.sourceObjectId) !== input.after.get(row.sourceObjectId)
        || input.before.get(row.targetObjectId) !== input.after.get(row.targetObjectId)) throw stop;
    }
    return { unaffected: true, work, admitted_bytes: scratchBytes };
  } catch (error) {
    if (error !== stop) throw error;
    return { unaffected: false, work, admitted_bytes: scratchBytes };
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
