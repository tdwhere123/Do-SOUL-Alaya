import { SourceLookupReasonsSchema, sameSourceEvidenceRoot, type TypedObservation } from "@do-soul/alaya-protocol";
import type { ObserverReaders, SourceObserverPage, SourceRootObserverRow } from "../conditional-field/observers/observe.js";
import { sourceFactKey, type BoundSourceFacts } from "../conditional-field/engine/binding-environment.js";
import { PersistentStringMap } from "@do-soul/alaya-graph-algorithms";
import { sourceFactEligible } from "../conditional-field/observers/observation-admission.js";

type FactWriter = Readonly<{ has(id: string): boolean; set(id: string, facts: BoundSourceFacts): unknown }>;

export class ObservedSourceFacts {
  private changed: ((id: string) => void) | undefined;
  public constructor(public snapshot: PersistentStringMap<BoundSourceFacts> = new PersistentStringMap(), public bytes = 0) {}
  public has(id: string): boolean { return this.snapshot.has(id); }
  public set(id: string, facts: BoundSourceFacts): this {
    const before = this.snapshot.get(id);
    if (facts.source_lookup_reasons === undefined && before?.source_lookup_reasons !== undefined) {
      facts = { ...facts, source_lookup_reasons: before.source_lookup_reasons };
    }
    if (before === facts) return this;
    this.bytes += Buffer.byteLength(JSON.stringify([id, facts]), "utf8")
      - (before === undefined ? 0 : Buffer.byteLength(JSON.stringify([id, before]), "utf8"));
    this.snapshot = this.snapshot.with(id, facts);
    this.changed?.(id);
    return this;
  }

  /** Capture actual writes, including facts learned from rows later rejected by a caller. */
  public captureChanges<T>(operation: () => T, limits: Readonly<{ work: number; bytes: number }>) {
    const before = this.snapshot, previous = this.changed;
    let keys: Set<string> | undefined = new Set(), work = 0, bytes = 0;
    this.changed = (id) => {
      previous?.(id);
      if (keys === undefined) return;
      if (work >= limits.work) { keys = undefined; return; }
      work += 1;
      if (keys.has(id)) return;
      const retained = 32 + Buffer.byteLength(id, "utf8");
      if (bytes + retained > limits.bytes) { keys = undefined; return; }
      keys.add(id); bytes += retained;
    };
    try {
      const value = operation();
      return { value, changes: { before, after: this.snapshot, keys: keys as ReadonlySet<string> | undefined }, work, bytes };
    } finally { this.changed = previous; }
  }
}

type ObservedFactInput = Readonly<{
  readonly workspace_id: string;
  readonly sourceCache: ReadonlyMap<string, SourceObserverPage>;
  readonly authorized_scopes?: readonly string[] | null;
  readonly as_of?: string;
}>;

export function recordObservedAt(
  input: ObservedFactInput,
  objectIds: readonly string[],
  observedAt: Record<string, string>,
  sourceFacts: FactWriter
): void {
  // These facts were funded by the observer. Missing dependencies are read by
  // the bounded source-fact demand owner, never through an implicit extra lookup.
  for (const objectId of objectIds) {
    if (sourceFacts.has(objectId)) continue;
    const page = input.sourceCache.get(objectId);
    const row = page?.row;
    if (row == null || page?.unavailable || page?.resourceLimited
      || !sourceFactEligible(row, input.authorized_scopes, input.as_of)) continue;
    retainSourceFact(sourceFacts, objectId, row, input.workspace_id, observedAt);
  }
}

export function retainSourceFact(
  sourceFacts: FactWriter,
  objectId: string,
  row: NonNullable<ReturnType<NonNullable<ObserverReaders["source"]>>["row"]>,
  workspaceId: string,
  observedAt: Record<string, string>
): void {
    sourceFacts.set(objectId, {
      object_id: row.object_id,
      ...(row.interpretation_node === undefined ? {} : { interpretation_node: row.interpretation_node }),
      workspace_id: workspaceId,
      source_revision: row.sourceRevision,
      ...(row.content === undefined ? {} : { content: row.content }),
      ...(row.predicates === undefined ? {} : { predicates: row.predicates }),
      ...(row.observed_at === undefined ? {} : { observed_at: row.observed_at }),
      ...(row.created_at === undefined ? {} : { created_at: row.created_at }),
      ...(row.last_used_at === undefined ? {} : { last_used_at: row.last_used_at }),
      ...(row.dimension === undefined ? {} : { dimension: row.dimension }),
      ...(row.domain_tags === undefined ? {} : { domain_tags: row.domain_tags }),
      ...(row.scope_class === undefined ? {} : { scope_class: row.scope_class }),
      ...(row.evidence_refs === undefined ? {} : { evidence_refs: row.evidence_refs }),
      ...(row.staged_warnings === undefined ? {} : { staged_warnings: row.staged_warnings })
    });
    if (row.observed_at !== undefined) observedAt[objectId] = row.observed_at;
}

export function recordSourceRootFacts(
  rows: readonly SourceRootObserverRow[],
  observations: readonly TypedObservation[],
  sourceFacts: FactWriter
): void {
  for (const observation of observations) {
    const target = observation.target;
    if (target === undefined || target.kind !== "source_evidence") continue;
    const row = rows.find((candidate) => candidate.kind === target.root_kind && candidate.root_id === target.root_id
      && candidate.revision === target.source_version && candidate.digest === target.content_digest);
    const parsedReasons = SourceLookupReasonsSchema.safeParse(row?.source_lookup_reasons);
    const reasons = parsedReasons.success ? [...new Map(parsedReasons.data
      .filter((reason) => sameSourceEvidenceRoot(reason.source_target, target))
      .map((reason) => [JSON.stringify(reason), reason])).values()] : [];
    sourceFacts.set(sourceFactKey(target), {
      object_id: target.root_id,
      workspace_id: target.workspace_id,
      root_kind: target.root_kind,
      source_revision: target.source_version,
      ...(reasons.length === 0 ? {} : { source_lookup_reasons: reasons }),
      evidence_object_id: target.evidence_object_id,
      ...(row?.evidence_verified === true ? { evidence_verified: true } : {}),
      ...(observation.observed_at === undefined ? {} : {
        observed_at: observation.observed_at
      }),
      ...(row?.content === undefined ? {} : { content: row.content }),
      content_complete: row?.content_complete === true,
      original_complete: row?.original_complete === true,
      ...(row?.retained_extent === undefined ? {} : { retained_extent: row.retained_extent }),
      ...(row?.source_representation === undefined ? {} : { source_representation: row.source_representation }),
      ...(row?.valid_from === undefined ? {} : { valid_from: row.valid_from }),
      ...(row?.valid_to === undefined ? {} : { valid_to: row.valid_to }),
      ...(row?.content_start === undefined ? {} : { content_start: row.content_start }),
      ...(row?.literal_verdicts === undefined ? {} : { literal_verdicts: row.literal_verdicts }),
      ...(row?.role === undefined ? {} : { role: row.role }),
      ...(row?.event_time === undefined ? {} : { event_time: row.event_time }),
      ...(row?.scope_class === undefined ? {} : { scope_class: row.scope_class })
    });
  }
}
