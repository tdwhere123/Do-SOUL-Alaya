-- Erased evidence cannot become a new reference of a live memory, even if an
-- admission was validated before the erase transaction committed.
CREATE TRIGGER memory_entries_reject_tombstoned_evidence_insert
BEFORE INSERT ON memory_entries
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.evidence_refs) AS ref
  JOIN evidence_capsules AS evidence ON evidence.object_id = ref.value
    AND evidence.workspace_id = NEW.workspace_id
  WHERE evidence.lifecycle_state = 'tombstone'
)
BEGIN
  SELECT RAISE(ABORT, 'tombstoned evidence cannot be attached');
END;

CREATE TRIGGER memory_entries_reject_tombstoned_evidence_update
BEFORE UPDATE OF evidence_refs ON memory_entries
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.evidence_refs) AS ref
  JOIN evidence_capsules AS evidence ON evidence.object_id = ref.value
    AND evidence.workspace_id = NEW.workspace_id
  WHERE evidence.lifecycle_state = 'tombstone'
)
BEGIN
  SELECT RAISE(ABORT, 'tombstoned evidence cannot be attached');
END;
