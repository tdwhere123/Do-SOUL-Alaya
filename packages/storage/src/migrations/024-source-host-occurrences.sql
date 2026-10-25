-- The startup migration owner disables incoming FKs for this atomic table rebuild.
CREATE TABLE source_spans_host (
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  span_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  purpose TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, span_id),
  FOREIGN KEY (workspace_id, record_id) REFERENCES source_records(workspace_id, record_id) ON DELETE CASCADE,
  CHECK (start_offset >= 0 AND end_offset > start_offset),
  CHECK (purpose IN ('native_structure', 'sentence', 'line', 'proposed_subspan', 'claim_citation', 'message')),
  UNIQUE (workspace_id, record_id, start_offset, end_offset, purpose, producer_version)
);
INSERT INTO source_spans_host SELECT * FROM source_spans;
DROP TABLE source_spans;
ALTER TABLE source_spans_host RENAME TO source_spans;
CREATE INDEX idx_source_spans_workspace_record ON source_spans(workspace_id, record_id);
CREATE TRIGGER source_spans_reject_erased_insert
BEFORE INSERT ON source_spans
WHEN EXISTS (
  SELECT 1 FROM projection_erase_barriers WHERE workspace_id = NEW.workspace_id
    AND ((subject_kind = 'source_span' AND subject_id = NEW.span_id) OR
         (subject_kind = 'source_record' AND subject_id = NEW.record_id))
)
BEGIN
  SELECT RAISE(ABORT, 'erased source span cannot be admitted');
END;

-- Inventory is retained separately; a scrubbed root keeps only its equality descriptor.
ALTER TABLE source_records ADD COLUMN host_structure_json TEXT;
CREATE TABLE source_host_inventories (
  workspace_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  canonical_inventory TEXT NOT NULL CHECK (octet_length(canonical_inventory) <= 65536),
  PRIMARY KEY (workspace_id, record_id),
  FOREIGN KEY (workspace_id, record_id) REFERENCES source_records(workspace_id, record_id) ON DELETE CASCADE
);
