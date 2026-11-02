-- Captured host messages per container. A body stays here only until its round root is admitted;
-- the digest and host facts remain so a repeated window admits nothing and an erased message stays erased.
CREATE TABLE host_session_messages (
  workspace_id TEXT NOT NULL,
  container_key TEXT NOT NULL,
  message_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  container_scope TEXT NOT NULL,
  container_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  completeness TEXT NOT NULL CHECK (completeness IN ('complete', 'excerpt')),
  fidelity TEXT NOT NULL CHECK (fidelity IN ('original_bytes', 'normalized', 'unknown')),
  host_reported_at TEXT,
  content_digest TEXT NOT NULL,
  run_id TEXT NOT NULL,
  producer TEXT NOT NULL,
  admitted_at TEXT NOT NULL,
  pending_body TEXT,
  round_index INTEGER CHECK (round_index IS NULL OR round_index >= 0),
  round_root_id TEXT,
  PRIMARY KEY (workspace_id, container_key, message_id),
  UNIQUE (workspace_id, container_key, position),
  CHECK ((round_root_id IS NULL) = (round_index IS NULL)),
  CHECK ((round_root_id IS NULL) = (pending_body IS NOT NULL))
);

CREATE INDEX idx_host_session_messages_admitted ON host_session_messages(admitted_at);
CREATE INDEX idx_host_session_messages_round ON host_session_messages(workspace_id, container_key, round_index);

-- Idle tail sweep checkpoint: a container qualifies again only after a newer message is admitted.
CREATE TABLE host_session_sweeps (
  workspace_id TEXT NOT NULL,
  container_key TEXT NOT NULL,
  swept_through INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, container_key)
) WITHOUT ROWID;

-- Statement sessions plan over a container's round roots and resume after its last chunk.
DROP INDEX idx_garden_tasks_statement_session_run;
CREATE INDEX idx_garden_tasks_statement_session_container ON garden_tasks(workspace_id, kind,
  (CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.container_key') END))
  WHERE kind = 'source_statement_session';

DROP TABLE statement_session_sweeps;
