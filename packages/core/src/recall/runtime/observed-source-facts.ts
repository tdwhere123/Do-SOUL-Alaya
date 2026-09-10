import type { TypedObservation } from "@do-soul/alaya-protocol";
import type { ObserverReaders, SourceRootObserverRow } from "../conditional-field/observers/observe.js";
import { sourceFactKey, type BoundSourceFacts } from "../conditional-field/engine/binding-environment.js";
import { PersistentStringMap } from "@do-soul/alaya-graph-algorithms";

type FactWriter = Readonly<{ has(id: string): boolean; set(id: string, facts: BoundSourceFacts): unknown }>;

export class ObservedSourceFacts {
  public constructor(public snapshot: PersistentStringMap<BoundSourceFacts> = new PersistentStringMap(), public bytes = 0) {}
  public has(id: string): boolean { return this.snapshot.has(id); }
  public set(id: string, facts: BoundSourceFacts): this {
    const before = this.snapshot.get(id);
    this.bytes += Buffer.byteLength(JSON.stringify([id, facts]), "utf8")
      - (before === undefined ? 0 : Buffer.byteLength(JSON.stringify([id, before]), "utf8"));
    this.snapshot = this.snapshot.with(id, facts);
    return this;
  }
}

type ObservedFactInput = Readonly<{
  readonly workspace_id: string;
  readonly readers: ObserverReaders;
}>;

export function recordObservedAt(
  input: ObservedFactInput,
  objectIds: readonly string[],
  observedAt: Record<string, string>,
  sourceFacts: FactWriter
): void {
  const source = input.readers.source;
  if (source === undefined) return;
  for (const objectId of objectIds) {
    if (sourceFacts.has(objectId)) continue;
    const page = source({ workspaceId: input.workspace_id, objectId });
    const row = page.row;
    if (row === null) continue;
    sourceFacts.set(objectId, {
      object_id: row.object_id,
      workspace_id: input.workspace_id,
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
    sourceFacts.set(sourceFactKey(target), {
      object_id: target.root_id,
      workspace_id: target.workspace_id,
      root_kind: target.root_kind,
      source_revision: target.source_version,
      evidence_object_id: target.evidence_object_id,
      ...(row?.evidence_verified === true ? { evidence_verified: true } : {}),
      ...(observation.observed_at === undefined ? {} : {
        observed_at: observation.observed_at,
        event_time: observation.observed_at
      }),
      ...(row?.content === undefined ? {} : { content: row.content }),
      content_complete: row?.content_complete === true,
      ...(row?.literal_verdicts === undefined ? {} : { literal_verdicts: row.literal_verdicts }),
      ...(row?.role === undefined ? {} : { role: row.role }),
      ...(row?.event_time === undefined || row.event_time === null
        ? {}
        : { event_time: row.event_time }),
      ...(row?.scope_class === undefined ? {} : { scope_class: row.scope_class })
    });
  }
}
