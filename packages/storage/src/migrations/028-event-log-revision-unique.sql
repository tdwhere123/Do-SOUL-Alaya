-- Enforce monotonically increasing, per-entity revisions in the event_log.
-- The shared writer (event-log-writer.ts) already computes MAX(revision)+1;
-- this index makes it a hard guarantee at the storage layer and closes the gap
-- where SqliteEventLogRepo.append() accepted a caller-supplied revision without
-- any uniqueness enforcement.
--
-- Step 1: Re-number revisions for existing data. Pre-patch callers hardcoded
-- revision: 0, so any entity with 2+ events has duplicate (entity_type,
-- entity_id, revision) tuples. We assign monotonically increasing revision
-- values ordered by (created_at, rowid) within each entity group.
UPDATE event_log
SET revision = (
  SELECT rn - 1
  FROM (
    SELECT rowid AS rid,
           ROW_NUMBER() OVER (
             PARTITION BY entity_type, entity_id
             ORDER BY created_at ASC, rowid ASC
           ) AS rn
    FROM event_log
  ) sub
  WHERE sub.rid = event_log.rowid
);

-- Step 2: Now that duplicates are resolved, create the unique index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_log_entity_revision
  ON event_log(entity_type, entity_id, revision);
