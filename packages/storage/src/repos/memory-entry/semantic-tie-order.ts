export interface MemoryEntrySemanticTieRow {
  readonly content: string;
  readonly dimension: string | null;
  readonly source_kind: string | null;
  readonly formation_kind: string | null;
  readonly scope_class: string | null;
  readonly event_time_start: string | null;
  readonly event_time_end: string | null;
  readonly valid_from: string | null;
  readonly valid_to: string | null;
  readonly time_precision: string | null;
  readonly time_source: string | null;
  readonly canonical_entities: string | null;
  readonly facet_tags: string | null;
}

export const MEMORY_ENTRY_SEMANTIC_TIE_ORDER_SQL = `
  memory_entries.content ASC,
  memory_entries.dimension ASC,
  memory_entries.source_kind ASC,
  memory_entries.formation_kind ASC,
  memory_entries.scope_class ASC,
  memory_entries.event_time_start ASC,
  memory_entries.event_time_end ASC,
  memory_entries.valid_from ASC,
  memory_entries.valid_to ASC,
  memory_entries.time_precision ASC,
  memory_entries.time_source ASC,
  memory_entries.canonical_entities ASC,
  memory_entries.facet_tags ASC`;

export function compareMemoryEntrySemanticTie(
  left: MemoryEntrySemanticTieRow,
  right: MemoryEntrySemanticTieRow
): number {
  return compareNullableString(left.content, right.content) ||
    compareNullableString(left.dimension, right.dimension) ||
    compareNullableString(left.source_kind, right.source_kind) ||
    compareNullableString(left.formation_kind, right.formation_kind) ||
    compareNullableString(left.scope_class, right.scope_class) ||
    compareNullableString(left.event_time_start, right.event_time_start) ||
    compareNullableString(left.event_time_end, right.event_time_end) ||
    compareNullableString(left.valid_from, right.valid_from) ||
    compareNullableString(left.valid_to, right.valid_to) ||
    compareNullableString(left.time_precision, right.time_precision) ||
    compareNullableString(left.time_source, right.time_source) ||
    compareNullableString(left.canonical_entities, right.canonical_entities) ||
    compareNullableString(left.facet_tags, right.facet_tags);
}

function compareNullableString(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
