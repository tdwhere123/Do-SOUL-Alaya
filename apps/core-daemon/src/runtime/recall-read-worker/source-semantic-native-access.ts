import type { SourceRecordIdentity, SourceSemanticRetainedNominationWitness } from "@do-soul/alaya-protocol";
import { CoreError, orderNativeRouteAccess, type NativeRouteLane } from "@do-soul/alaya-core";
import type { SourceSemanticReadBudget } from "../field/source-semantic-read-stores.js";

/** The actual catalog/admitted target join authenticates associations; source-id coincidence is insufficient. */
export function nativeSourceAccessPositions(records: readonly SourceRecordIdentity[], witness: SourceSemanticRetainedNominationWitness,
  catalogPositions: ReadonlyMap<string, number> | undefined, unvisited: boolean, meter: SourceSemanticReadBudget): ReadonlyMap<string, number> {
  meter.charge(records.length + witness.length, 64 + 16 * (records.length + witness.length), "native access association lookup");
  const members = new Map(records.map(row => [row.identity, row]));
  const eligible = witness.filter(row => {
    const record = members.get(row.source.target.root_id), target = row.source.target;
    return record !== undefined && record.workspace_id === target.workspace_id && record.source_id === row.source.source_id &&
      record.source_version === target.source_version && record.content_digest === target.content_digest;
  });
  const lanes: NativeRouteLane[] = (["original", "hint"] as const).flatMap(view => (["lexical", "vector"] as const).map(route => {
    const rows = eligible.filter(row => row.view === view && row.route.kind === route);
    const base = { lane: `${view}-${route}` as const, scope: "original" };
    return rows.length === 0 ? { ...base, state: "measured-empty" as const } : { ...base, state: "exact-captured" as const,
      occurrences: rows.map(row => ({ reference: row.reference, root_key: row.source.root_key, native_rank: row.route.native_rank })) };
  }));
  const input = { lanes, pool: records.map(row => ({ record_id: row.identity, catalog_position: catalogPositions?.get(row.identity) ?? null })),
    acquired_root_keys: [...new Set(eligible.map(row => row.source.root_key))],
    associations: eligible.map(row => ({ occurrence_reference: row.reference, root_key: row.source.root_key, record_id: row.source.target.root_id })),
    unvisited_sources: unvisited };
  meter.retain(input, "native access captured membership");
  meter.charge(8 * (eligible.length + records.length), 0, "native access opportunity walk");
  const ordered = orderNativeRouteAccess(input);
  meter.retain(ordered, "native access ordered membership");
  if (ordered.status === "non_total") throw new CoreError("CONFLICT", "native access order is non_total: missing captured catalog positions", {
    details: { admission: "unavailable", order: ordered }
  });
  meter.charge(ordered.record_ids.length, 64 + 24 * ordered.record_ids.length, "native access position lookup");
  return new Map(ordered.record_ids.map((id, position) => [id, position]));
}
