import type { MemoryEntry } from "@do-soul/alaya-protocol";

type MemoryEntryStatementParam = string | number | null;

export function buildMemoryEntryCreateParams(
  entry: Readonly<MemoryEntry>
): readonly MemoryEntryStatementParam[] {
  return [
    ...buildMemoryEntryIdentityParams(entry),
    ...buildMemoryEntryContentParams(entry),
    ...buildMemoryEntryStateParams(entry),
    ...buildMemoryEntryProjectionParams(entry),
    entry.forget_disposition ?? null,
    entry.forget_disposition_ref ?? null
  ];
}

function buildMemoryEntryIdentityParams(
  entry: Readonly<MemoryEntry>
): readonly MemoryEntryStatementParam[] {
  return [
    entry.object_id,
    entry.object_kind,
    entry.schema_version,
    entry.lifecycle_state,
    entry.created_at,
    entry.updated_at,
    entry.created_by,
    entry.dimension,
    entry.source_kind,
    entry.formation_kind,
    entry.scope_class
  ];
}

function buildMemoryEntryContentParams(
  entry: Readonly<MemoryEntry>
): readonly MemoryEntryStatementParam[] {
  return [
    entry.content,
    JSON.stringify(entry.domain_tags),
    JSON.stringify(entry.evidence_refs),
    entry.workspace_id,
    entry.run_id,
    entry.surface_id
  ];
}

function buildMemoryEntryStateParams(
  entry: Readonly<MemoryEntry>
): readonly MemoryEntryStatementParam[] {
  return [
    entry.storage_tier,
    entry.activation_score,
    entry.retention_score,
    entry.manifestation_state,
    entry.retention_state,
    entry.decay_profile,
    entry.confidence,
    entry.last_used_at,
    entry.last_hit_at,
    entry.reinforcement_count,
    entry.contradiction_count,
    entry.superseded_by
  ];
}

function buildMemoryEntryProjectionParams(
  entry: Readonly<MemoryEntry>
): readonly MemoryEntryStatementParam[] {
  return [
    entry.projection_schema_version ?? null,
    entry.event_time_start ?? null,
    entry.event_time_end ?? null,
    entry.valid_from ?? null,
    entry.valid_to ?? null,
    entry.time_precision ?? null,
    entry.time_source ?? null,
    entry.preference_subject ?? null,
    entry.preference_predicate ?? null,
    entry.preference_object ?? null,
    entry.preference_category ?? null,
    entry.preference_polarity ?? null,
    entry.facet_tags == null ? null : JSON.stringify(entry.facet_tags)
  ];
}
