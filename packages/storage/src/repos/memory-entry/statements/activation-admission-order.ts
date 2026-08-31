// Pushes compareMemoryEntriesForActivationAdmission into SQL: drift-rounded
// activation desc, then the JS semantic-identity field order, then object_id.
// ASCII fixtures match localeCompare; do not invent a second ranker.
export const MEMORY_ENTRY_ACTIVATION_ADMISSION_ORDER_SQL = `
  ROUND(COALESCE(memory_entries.activation_score, 0), 6) DESC,
  memory_entries.content ASC,
  memory_entries.dimension ASC,
  memory_entries.scope_class ASC,
  memory_entries.source_kind ASC,
  memory_entries.formation_kind ASC,
  COALESCE(memory_entries.event_time_start, '') ASC,
  COALESCE(memory_entries.event_time_end, '') ASC,
  COALESCE(memory_entries.valid_from, '') ASC,
  COALESCE(memory_entries.valid_to, '') ASC,
  COALESCE(memory_entries.canonical_entities, '') ASC,
  COALESCE(memory_entries.facet_tags, '') ASC,
  memory_entries.object_id ASC`;
