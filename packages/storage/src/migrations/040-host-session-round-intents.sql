-- A round's membership and source identity are fixed before source admission can have effects.
CREATE TABLE host_session_rounds (
  workspace_id TEXT NOT NULL,
  container_key TEXT NOT NULL,
  round_index INTEGER NOT NULL CHECK (round_index >= 0),
  root_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'done', 'erased_pending', 'erased')),
  PRIMARY KEY (workspace_id, container_key, round_index),
  UNIQUE (workspace_id, container_key, root_id)
) WITHOUT ROWID;
CREATE INDEX idx_host_session_rounds_pending ON host_session_rounds(workspace_id, container_key, state, round_index);

INSERT INTO host_session_rounds
SELECT workspace_id, container_key, round_index, round_root_id, 'done'
FROM host_session_messages WHERE round_root_id IS NOT NULL
GROUP BY workspace_id, container_key, round_index, round_root_id;

-- Reassociate receipts stranded by the old audit/bind gap using the retained host
-- inventory, never source text or identities from a different workspace/producer.
INSERT OR IGNORE INTO host_session_rounds
SELECT m.workspace_id, m.container_key,
  CAST(substr(s.source_id, length('host-session:' || m.container_key || ':r') + 1) AS INTEGER),
  s.record_id, 'pending'
FROM source_records s JOIN source_host_inventories i
  ON i.workspace_id = s.workspace_id AND i.record_id = s.record_id
JOIN json_each(i.canonical_inventory, '$.occurrences') o
JOIN host_session_messages m ON m.workspace_id = s.workspace_id
  AND m.message_id = json_extract(o.value, '$.occurrence_id')
  AND m.position = json_extract(o.value, '$.upstream_position')
  AND m.container_scope = json_extract(o.value, '$.container_ref.scope')
  AND m.container_id = json_extract(o.value, '$.container_ref.id')
  AND m.producer = json_extract(i.canonical_inventory, '$.issuer.producer')
  AND m.round_root_id IS NULL
WHERE s.source_version = 'host-session-v1'
  AND json_extract(i.canonical_inventory, '$.issuer.basis') = 'host_session'
  AND s.source_id = 'host-session:' || m.container_key || ':r' ||
    CAST(substr(s.source_id, length('host-session:' || m.container_key || ':r') + 1) AS INTEGER)
GROUP BY m.workspace_id, m.container_key, s.record_id
HAVING COUNT(*) = json_array_length(i.canonical_inventory, '$.occurrences');

-- Rebuild the check: pending intent members may have both a root identity and a
-- body; erased members retain their id/digest with no body, including legacy rows.
CREATE TABLE host_session_messages_new (
  workspace_id TEXT NOT NULL, container_key TEXT NOT NULL, message_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0), container_scope TEXT NOT NULL, container_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  completeness TEXT NOT NULL CHECK (completeness IN ('complete', 'excerpt')),
  fidelity TEXT NOT NULL CHECK (fidelity IN ('original_bytes', 'normalized', 'unknown')),
  host_reported_at TEXT, content_digest TEXT NOT NULL, run_id TEXT NOT NULL, producer TEXT NOT NULL,
  admitted_at TEXT NOT NULL, pending_body TEXT, round_index INTEGER CHECK (round_index IS NULL OR round_index >= 0),
  round_root_id TEXT, erased INTEGER NOT NULL DEFAULT 0 CHECK (erased IN (0, 1)),
  PRIMARY KEY (workspace_id, container_key, message_id), UNIQUE (workspace_id, container_key, position),
  CHECK ((round_root_id IS NULL) = (round_index IS NULL)),
  CHECK (erased = 0 OR pending_body IS NULL),
  CHECK (round_root_id IS NOT NULL OR pending_body IS NOT NULL OR erased = 1)
);
INSERT INTO host_session_messages_new
SELECT m.*, 0 FROM host_session_messages m;
DROP TABLE host_session_messages;
ALTER TABLE host_session_messages_new RENAME TO host_session_messages;
CREATE INDEX idx_host_session_messages_admitted ON host_session_messages(admitted_at);
CREATE INDEX idx_host_session_messages_round ON host_session_messages(workspace_id, container_key, round_index);
CREATE INDEX idx_host_session_messages_root ON host_session_messages(workspace_id, round_root_id);

-- Keep one logical, workspace-copyable idle candidate per container rather than
-- aggregating its entire message history on every sweep.
CREATE TABLE host_session_containers (
  workspace_id TEXT NOT NULL, container_key TEXT NOT NULL, producer TEXT NOT NULL,
  newest_position INTEGER NOT NULL, newest_admitted_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, container_key)
) WITHOUT ROWID;
INSERT INTO host_session_containers
SELECT workspace_id, container_key, MIN(producer), MAX(position), MAX(admitted_at)
FROM host_session_messages GROUP BY workspace_id, container_key;
CREATE INDEX idx_host_session_containers_idle ON host_session_containers(newest_admitted_at);
CREATE TRIGGER host_session_message_container_insert AFTER INSERT ON host_session_messages BEGIN
  INSERT INTO host_session_containers VALUES (NEW.workspace_id, NEW.container_key, NEW.producer, NEW.position, NEW.admitted_at)
  ON CONFLICT(workspace_id, container_key) DO UPDATE SET
    newest_position = MAX(newest_position, excluded.newest_position),
    newest_admitted_at = MAX(newest_admitted_at, excluded.newest_admitted_at);
END;

DROP INDEX idx_garden_tasks_statement_session_container;
CREATE INDEX idx_garden_tasks_statement_session_container ON garden_tasks(workspace_id, kind,
  (CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.container_key') END),
  (CASE WHEN json_valid(payload_json) THEN CAST(json_extract(payload_json, '$.chunk_index') AS INTEGER) END) DESC, id DESC)
  WHERE kind = 'source_statement_session';

UPDATE host_session_messages AS m SET
  round_index = (SELECT r.round_index FROM host_session_rounds r JOIN source_host_inventories i
    ON i.workspace_id = r.workspace_id AND i.record_id = r.root_id
    JOIN json_each(i.canonical_inventory, '$.occurrences') o
    WHERE r.workspace_id = m.workspace_id AND r.container_key = m.container_key AND r.state = 'pending'
      AND json_extract(o.value, '$.occurrence_id') = m.message_id LIMIT 1),
  round_root_id = (SELECT r.root_id FROM host_session_rounds r JOIN source_host_inventories i
    ON i.workspace_id = r.workspace_id AND i.record_id = r.root_id
    JOIN json_each(i.canonical_inventory, '$.occurrences') o
    WHERE r.workspace_id = m.workspace_id AND r.container_key = m.container_key AND r.state = 'pending'
      AND json_extract(o.value, '$.occurrence_id') = m.message_id LIMIT 1)
WHERE m.round_index IS NULL AND EXISTS (SELECT 1 FROM host_session_rounds r JOIN source_host_inventories i
  ON i.workspace_id = r.workspace_id AND i.record_id = r.root_id
  JOIN json_each(i.canonical_inventory, '$.occurrences') o
  WHERE r.workspace_id = m.workspace_id AND r.container_key = m.container_key AND r.state = 'pending'
    AND json_extract(o.value, '$.occurrence_id') = m.message_id);

-- A host/idle tail closure remains fixed even while a later capture arrives.
CREATE TABLE host_session_tail_boundaries (
  workspace_id TEXT NOT NULL, container_key TEXT NOT NULL, round_index INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'done')),
  PRIMARY KEY (workspace_id, container_key, round_index)
) WITHOUT ROWID;
-- A stranded single-user receipt with no successor, or an adjacent assistant
-- appended later, proves that the original tail was explicitly or idly closed.
INSERT INTO host_session_tail_boundaries
SELECT r.workspace_id, r.container_key, r.round_index, 'pending'
FROM host_session_rounds r JOIN host_session_messages m ON m.workspace_id = r.workspace_id
  AND m.container_key = r.container_key AND m.round_index = r.round_index
WHERE r.state = 'pending' AND m.role = 'user'
  AND 1 = (SELECT COUNT(*) FROM host_session_messages member WHERE member.workspace_id = r.workspace_id
    AND member.container_key = r.container_key AND member.round_index = r.round_index)
  AND (NOT EXISTS (SELECT 1 FROM host_session_messages later WHERE later.workspace_id = m.workspace_id
        AND later.container_key = m.container_key AND later.position > m.position)
    OR EXISTS (SELECT 1 FROM host_session_messages later WHERE later.workspace_id = m.workspace_id
        AND later.container_key = m.container_key AND later.position = m.position + 1 AND later.role = 'assistant'));

-- Planning progress includes raw-only gaps, and commits with any queued chunks.
CREATE TABLE host_session_planning (
  workspace_id TEXT NOT NULL, container_key TEXT NOT NULL,
  round_index INTEGER NOT NULL, occurrence_end INTEGER NOT NULL,
  scan_round INTEGER NOT NULL, pending_json TEXT NOT NULL CHECK (json_valid(pending_json)),
  context_before INTEGER, context_json TEXT NOT NULL CHECK (json_valid(context_json)),
  PRIMARY KEY (workspace_id, container_key)
) WITHOUT ROWID;

-- The old checkpoint held an implicit rowid and cannot be trusted after copying.
DROP TABLE host_session_sweeps;
CREATE TABLE host_session_sweeps (
  workspace_id TEXT NOT NULL, container_key TEXT NOT NULL, sweeper TEXT NOT NULL,
  swept_through INTEGER NOT NULL, retry_after TEXT,
  PRIMARY KEY (workspace_id, container_key, sweeper)
) WITHOUT ROWID;
