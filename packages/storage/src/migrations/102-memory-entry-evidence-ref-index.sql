CREATE TABLE IF NOT EXISTS memory_entry_evidence_refs (
  workspace_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  PRIMARY KEY (workspace_id, memory_id, evidence_ref),
  FOREIGN KEY (memory_id) REFERENCES memory_entries(object_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memory_entry_evidence_refs_lookup
ON memory_entry_evidence_refs(workspace_id, evidence_ref, memory_id);

INSERT OR IGNORE INTO memory_entry_evidence_refs(workspace_id, memory_id, evidence_ref)
SELECT memory_entries.workspace_id, memory_entries.object_id, evidence_ref.value
FROM memory_entries, json_each(memory_entries.evidence_refs) AS evidence_ref
WHERE evidence_ref.type = 'text'
  AND evidence_ref.value != '';
