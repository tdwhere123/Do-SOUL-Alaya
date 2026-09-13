-- Rebuild memory_entries so protocol enums are CHECK-constrained at the
-- truth boundary. SQLite cannot ALTER TABLE ADD CHECK; the migration
-- runner disables foreign_keys around this file (pragma is a no-op inside
-- a transaction). Enum literals must match packages/protocol/src/memory
-- memory-entry.ts, object-kind.ts, and lifecycle.ts.

CREATE TABLE memory_entries_enum_checked (
  object_id TEXT PRIMARY KEY,
  object_kind TEXT NOT NULL DEFAULT 'memory_entry' CHECK (object_kind = 'memory_entry'),
  schema_version INTEGER NOT NULL DEFAULT 1,
  lifecycle_state TEXT NOT NULL DEFAULT 'active' CHECK (
    lifecycle_state IN ('draft', 'active', 'dormant', 'archived', 'tombstone')
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  dimension TEXT NOT NULL CHECK (
    dimension IN (
      'preference', 'constraint', 'decision', 'procedure',
      'fact', 'hazard', 'glossary', 'episode'
    )
  ),
  source_kind TEXT NOT NULL CHECK (
    source_kind IN ('compiler', 'user', 'seed', 'import', 'review')
  ),
  formation_kind TEXT NOT NULL CHECK (
    formation_kind IN ('extracted', 'explicit', 'inferred', 'derived', 'imported')
  ),
  scope_class TEXT NOT NULL CHECK (
    scope_class IN ('project', 'global_domain', 'global_core')
  ),
  content TEXT NOT NULL,
  domain_tags TEXT NOT NULL DEFAULT '[]',
  evidence_refs TEXT NOT NULL DEFAULT '[]',
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  surface_id TEXT,
  storage_tier TEXT NOT NULL DEFAULT 'hot' CHECK (
    storage_tier IN ('hot', 'warm', 'cold')
  ),
  activation_score REAL,
  retention_score REAL,
  manifestation_state TEXT CHECK (
    manifestation_state IS NULL OR manifestation_state IN (
      'hidden', 'hint', 'excerpt', 'full_eligible'
    )
  ),
  retention_state TEXT CHECK (
    retention_state IS NULL OR retention_state IN (
      'working', 'consolidated', 'canon', 'archived', 'tombstoned'
    )
  ),
  decay_profile TEXT CHECK (
    decay_profile IS NULL OR decay_profile IN (
      'pinned', 'stable', 'normal', 'volatile', 'hazard'
    )
  ),
  confidence REAL,
  last_used_at TEXT,
  last_hit_at TEXT,
  reinforcement_count INTEGER,
  contradiction_count INTEGER,
  superseded_by TEXT,
  forget_disposition TEXT CHECK (
    forget_disposition IS NULL OR forget_disposition IN ('compressed', 'judged_useless')
  ),
  forget_disposition_ref TEXT,
  projection_schema_version INTEGER,
  event_time_start TEXT,
  event_time_end TEXT,
  valid_from TEXT,
  valid_to TEXT,
  time_precision TEXT CHECK (
    time_precision IS NULL OR time_precision IN (
      'day', 'month', 'year', 'range', 'relative', 'unknown'
    )
  ),
  time_source TEXT CHECK (
    time_source IS NULL OR time_source IN (
      'explicit', 'session_timestamp', 'relative_resolved'
    )
  ),
  preference_subject TEXT,
  preference_predicate TEXT,
  preference_object TEXT,
  preference_category TEXT,
  preference_polarity TEXT CHECK (
    preference_polarity IS NULL OR preference_polarity IN (
      'positive', 'negative', 'neutral'
    )
  ),
  facet_tags TEXT,
  canonical_entities TEXT
);

INSERT INTO memory_entries_enum_checked (
  rowid,
  object_id, object_kind, schema_version, lifecycle_state, created_at, updated_at, created_by,
  dimension, source_kind, formation_kind, scope_class, content, domain_tags, evidence_refs,
  workspace_id, run_id, surface_id, storage_tier, activation_score, retention_score,
  manifestation_state, retention_state, decay_profile, confidence, last_used_at, last_hit_at,
  reinforcement_count, contradiction_count, superseded_by, forget_disposition,
  forget_disposition_ref, projection_schema_version, event_time_start, event_time_end,
  valid_from, valid_to, time_precision, time_source, preference_subject, preference_predicate,
  preference_object, preference_category, preference_polarity, facet_tags, canonical_entities
)
SELECT
  rowid,
  object_id, object_kind, schema_version, lifecycle_state, created_at, updated_at, created_by,
  dimension, source_kind, formation_kind, scope_class, content, domain_tags, evidence_refs,
  workspace_id, run_id, surface_id, storage_tier, activation_score, retention_score,
  manifestation_state, retention_state, decay_profile, confidence, last_used_at, last_hit_at,
  reinforcement_count, contradiction_count, superseded_by, forget_disposition,
  forget_disposition_ref, projection_schema_version, event_time_start, event_time_end,
  valid_from, valid_to, time_precision, time_source, preference_subject, preference_predicate,
  preference_object, preference_category, preference_polarity, facet_tags, canonical_entities
FROM memory_entries;

DROP TABLE memory_entries;

ALTER TABLE memory_entries_enum_checked RENAME TO memory_entries;

CREATE INDEX idx_memory_entries_workspace_id ON memory_entries(workspace_id);
CREATE INDEX idx_memory_entries_run_id ON memory_entries(run_id);
CREATE INDEX idx_memory_entries_dimension ON memory_entries(dimension);
CREATE INDEX idx_memory_entries_scope_class ON memory_entries(scope_class);
CREATE INDEX idx_memory_entries_storage_tier ON memory_entries(storage_tier);

CREATE INDEX idx_memory_entries_workspace_tier_active_created
ON memory_entries(workspace_id, storage_tier, created_at, object_id)
WHERE COALESCE(retention_state, '') != 'tombstoned'
  AND COALESCE(lifecycle_state, '') != 'dormant';

CREATE INDEX idx_memory_entries_workspace_dimension_hot_active_created
ON memory_entries(workspace_id, dimension, created_at, object_id)
WHERE storage_tier = 'hot'
  AND COALESCE(retention_state, '') != 'tombstoned'
  AND COALESCE(lifecycle_state, '') != 'dormant';

CREATE INDEX idx_memory_entries_workspace_scope_hot_active_created
ON memory_entries(workspace_id, scope_class, created_at, object_id)
WHERE storage_tier = 'hot'
  AND COALESCE(retention_state, '') != 'tombstoned'
  AND COALESCE(lifecycle_state, '') != 'dormant';

CREATE INDEX idx_memory_entries_run_active_created
ON memory_entries(run_id, created_at, object_id)
WHERE COALESCE(retention_state, '') != 'tombstoned'
  AND COALESCE(lifecycle_state, '') != 'dormant';

CREATE INDEX idx_memory_entries_event_time
  ON memory_entries(workspace_id, event_time_start, event_time_end)
  WHERE event_time_start IS NOT NULL;

CREATE INDEX idx_memory_entries_preference_profile
ON memory_entries(workspace_id, preference_subject, preference_category, preference_object)
WHERE dimension = 'preference';

CREATE INDEX idx_memory_entries_workspace_conflict_hot
  ON memory_entries(workspace_id, contradiction_count)
  WHERE contradiction_count > 0 AND storage_tier = 'hot';

CREATE INDEX idx_memory_entries_event_time_recall_active
  ON memory_entries(
    workspace_id,
    storage_tier,
    MIN(
      julianday(event_time_start),
      COALESCE(julianday(event_time_end), julianday(event_time_start))
    )
  )
  WHERE event_time_start IS NOT NULL
    AND julianday(event_time_start) IS NOT NULL
    AND (event_time_end IS NULL OR julianday(event_time_end) IS NOT NULL)
    AND COALESCE(retention_state, '') != 'tombstoned'
    AND COALESCE(lifecycle_state, '') != 'dormant';

CREATE TRIGGER memory_content_fts_ai
AFTER INSERT ON memory_entries
BEGIN
  INSERT INTO memory_content_fts (rowid, object_id, workspace_id, content)
  VALUES (new.rowid, new.object_id, new.workspace_id, new.content);
END;

CREATE TRIGGER memory_content_fts_ad
AFTER DELETE ON memory_entries
BEGIN
  DELETE FROM memory_content_fts WHERE rowid = old.rowid;
END;

CREATE TRIGGER memory_content_fts_au
AFTER UPDATE OF object_id, workspace_id, content ON memory_entries
BEGIN
  DELETE FROM memory_content_fts WHERE rowid = old.rowid;
  INSERT INTO memory_content_fts (rowid, object_id, workspace_id, content)
  VALUES (new.rowid, new.object_id, new.workspace_id, new.content);
END;

CREATE TRIGGER memory_content_fts_porter_ai
AFTER INSERT ON memory_entries
BEGIN
  INSERT INTO memory_content_fts_porter (rowid, object_id, workspace_id, content)
  VALUES (new.rowid, new.object_id, new.workspace_id, new.content);
END;

CREATE TRIGGER memory_content_fts_porter_ad
AFTER DELETE ON memory_entries
BEGIN
  DELETE FROM memory_content_fts_porter WHERE rowid = old.rowid;
END;

CREATE TRIGGER memory_content_fts_porter_au
AFTER UPDATE OF object_id, workspace_id, content ON memory_entries
BEGIN
  DELETE FROM memory_content_fts_porter WHERE rowid = old.rowid;
  INSERT INTO memory_content_fts_porter (rowid, object_id, workspace_id, content)
  VALUES (new.rowid, new.object_id, new.workspace_id, new.content);
END;

CREATE TRIGGER memory_entries_reject_erased_source_content_update
BEFORE UPDATE OF content, domain_tags, lifecycle_state, retention_state,
  manifestation_state, preference_subject, preference_predicate, preference_object,
  preference_category, preference_polarity, facet_tags, canonical_entities
ON memory_entries
WHEN NOT (
  NEW.content = 'erased' AND NEW.lifecycle_state = 'tombstone' AND
  NEW.retention_state = 'tombstoned' AND NEW.domain_tags = '[]' AND
  NEW.manifestation_state IS NULL AND NEW.preference_subject IS NULL AND
  NEW.preference_predicate IS NULL AND NEW.preference_object IS NULL AND
  NEW.preference_category IS NULL AND NEW.preference_polarity IS NULL AND
  NEW.facet_tags IS NULL AND NEW.canonical_entities IS NULL
)
AND EXISTS (
  SELECT 1 FROM memory_entry_evidence_refs AS memory_ref
  JOIN source_record_evidence_refs AS source_ref
    ON source_ref.workspace_id = memory_ref.workspace_id
   AND source_ref.evidence_object_id = memory_ref.evidence_ref
  JOIN projection_erase_barriers AS barrier
    ON barrier.workspace_id = source_ref.workspace_id
   AND barrier.subject_kind = 'source_record'
   AND barrier.subject_id = source_ref.record_id
  WHERE memory_ref.workspace_id = NEW.workspace_id
    AND memory_ref.memory_id = NEW.object_id
)
BEGIN
  SELECT RAISE(ABORT, 'erased source memory cannot store content');
END;

CREATE TRIGGER memory_entries_reject_erased_source_delete
BEFORE DELETE ON memory_entries
WHEN EXISTS (
  SELECT 1 FROM memory_entry_evidence_refs AS memory_ref
  JOIN source_record_evidence_refs AS source_ref
    ON source_ref.workspace_id = memory_ref.workspace_id
   AND source_ref.evidence_object_id = memory_ref.evidence_ref
  JOIN projection_erase_barriers AS barrier
    ON barrier.workspace_id = source_ref.workspace_id
   AND barrier.subject_kind = 'source_record'
   AND barrier.subject_id = source_ref.record_id
  WHERE memory_ref.workspace_id = OLD.workspace_id
    AND memory_ref.memory_id = OLD.object_id
)
BEGIN
  SELECT RAISE(ABORT, 'erased source memory tombstone cannot be deleted');
END;
