-- Trust-state persistence records delivered-vs-used context receipts as
-- auditable SQL rows tied one-to-one to EventLog entries.
-- `delivery_id` remains the primary key so duplicate delivery messages cannot
-- overwrite the original row. `audit_event_id` is also UNIQUE so every durable
-- trust row maps to exactly one EventLog entry and INSERT OR REPLACE cannot
-- silently reuse a stale audit id. The migration is forward-only; rollback
-- would discard operator-visible trust evidence and must be handled by a
-- later explicit migration if the storage contract changes.
CREATE TABLE IF NOT EXISTS trust_context_delivery (
  delivery_id TEXT PRIMARY KEY,
  agent_target TEXT NOT NULL,
  workspace_id TEXT,
  run_id TEXT,
  delivered_object_ids_json TEXT NOT NULL CHECK (json_valid(delivered_object_ids_json)),
  delivered_at TEXT NOT NULL,
  audit_event_id TEXT NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_trust_context_delivery_agent_target_delivered_at
ON trust_context_delivery(agent_target, delivered_at, delivery_id);

CREATE TABLE IF NOT EXISTS trust_usage_proof (
  delivery_id TEXT PRIMARY KEY,
  usage_state TEXT NOT NULL CHECK (usage_state IN ('used', 'skipped', 'not_applicable')),
  used_object_ids_json TEXT NOT NULL CHECK (json_valid(used_object_ids_json)),
  reason TEXT,
  reported_at TEXT NOT NULL,
  audit_event_id TEXT NOT NULL UNIQUE,
  FOREIGN KEY(delivery_id) REFERENCES trust_context_delivery(delivery_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_trust_usage_proof_usage_state
ON trust_usage_proof(usage_state);
