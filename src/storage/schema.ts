import type { DatabaseSync } from "node:sqlite";
import { StorageError } from "./errors.js";

export const BASELINE_SCHEMA_VERSION = 1;

const BASELINE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS storage_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scopes (
  scope_id TEXT PRIMARY KEY,
  plane TEXT NOT NULL CHECK (plane IN ('global_personal', 'project_local')),
  scope_kind TEXT NOT NULL,
  scope_ref TEXT NOT NULL,
  parent_scope_id TEXT REFERENCES scopes(scope_id) ON DELETE SET NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  memory_id TEXT PRIMARY KEY,
  plane TEXT NOT NULL CHECK (plane IN ('global_personal', 'project_local')),
  scope_id TEXT REFERENCES scopes(scope_id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'active'
    CHECK (lifecycle_state IN ('active', 'rejected', 'retired')),
  governance_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (governance_state IN ('pending', 'accepted', 'rejected', 'retired')),
  strength REAL NOT NULL DEFAULT 1,
  sensitivity TEXT NOT NULL DEFAULT 'normal'
    CHECK (sensitivity IN ('normal', 'sensitive')),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence (
  evidence_id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memories(memory_id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  audit_event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  actor_ref TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_edges (
  edge_id TEXT PRIMARY KEY,
  from_memory_id TEXT NOT NULL REFERENCES memories(memory_id) ON DELETE CASCADE,
  to_memory_id TEXT NOT NULL REFERENCES memories(memory_id) ON DELETE CASCADE,
  edge_type TEXT NOT NULL,
  strength REAL NOT NULL DEFAULT 1,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_sessions (
  session_id TEXT PRIMARY KEY,
  agent_kind TEXT NOT NULL,
  client_version TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('connect', 'attach', 'gateway')),
  host_ref TEXT,
  project_ref TEXT,
  workspace_ref TEXT,
  context_pack_id TEXT,
  usage_state TEXT NOT NULL DEFAULT 'pending',
  post_run_ingest_state TEXT NOT NULL DEFAULT 'pending',
  violation_summary_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(violation_summary_json)),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS context_packs (
  context_pack_id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES memory_sessions(session_id) ON DELETE SET NULL,
  request_id TEXT,
  query_text TEXT NOT NULL,
  task_summary TEXT,
  plane_policy_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(plane_policy_json)),
  recall_policy_version TEXT NOT NULL,
  included_count INTEGER NOT NULL DEFAULT 0,
  excluded_count INTEGER NOT NULL DEFAULT 0,
  explanation_summary TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS context_pack_entries (
  entry_id TEXT PRIMARY KEY,
  context_pack_id TEXT NOT NULL REFERENCES context_packs(context_pack_id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL REFERENCES memories(memory_id) ON DELETE CASCADE,
  memory_plane TEXT NOT NULL CHECK (memory_plane IN ('global_personal', 'project_local')),
  usage_recommendation TEXT NOT NULL CHECK (usage_recommendation IN ('blocking', 'advisory', 'historical')),
  score REAL NOT NULL DEFAULT 0,
  rank INTEGER NOT NULL,
  reason TEXT NOT NULL,
  source_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_refs_json)),
  is_stale INTEGER NOT NULL DEFAULT 0 CHECK (is_stale IN (0, 1)),
  is_sensitive INTEGER NOT NULL DEFAULT 0 CHECK (is_sensitive IN (0, 1)),
  has_conflict INTEGER NOT NULL DEFAULT 0 CHECK (has_conflict IN (0, 1)),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recall_exclusions (
  exclusion_id TEXT PRIMARY KEY,
  context_pack_id TEXT REFERENCES context_packs(context_pack_id) ON DELETE CASCADE,
  memory_id TEXT REFERENCES memories(memory_id) ON DELETE SET NULL,
  source_plane TEXT NOT NULL CHECK (source_plane IN ('global_personal', 'project_local')),
  reason TEXT NOT NULL,
  evidence_id TEXT REFERENCES evidence(evidence_id) ON DELETE SET NULL,
  lifecycle_state TEXT,
  conflict_ref TEXT,
  superseded_by_memory_id TEXT REFERENCES memories(memory_id) ON DELETE SET NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_usage_events (
  usage_event_id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES memory_sessions(session_id) ON DELETE SET NULL,
  context_pack_id TEXT REFERENCES context_packs(context_pack_id) ON DELETE SET NULL,
  memory_id TEXT REFERENCES memories(memory_id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  proof_ref TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_ingest_events (
  ingest_event_id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES memory_sessions(session_id) ON DELETE SET NULL,
  memory_id TEXT REFERENCES memories(memory_id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  outcome TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_contract_violations (
  violation_id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES memory_sessions(session_id) ON DELETE CASCADE,
  violation_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
  summary TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS export_import_metadata (
  metadata_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  operation_type TEXT NOT NULL CHECK (operation_type IN ('export', 'import', 'backup', 'restore')),
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
  file_path TEXT,
  bundle_version TEXT,
  item_counts_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(item_counts_json)),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_memories_plane_scope ON memories(plane, scope_id);
CREATE INDEX IF NOT EXISTS idx_memories_lifecycle ON memories(lifecycle_state, governance_state);
CREATE INDEX IF NOT EXISTS idx_evidence_memory ON evidence(memory_id);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events(entity_type, entity_id, created_at);
CREATE INDEX IF NOT EXISTS idx_memory_edges_from ON memory_edges(from_memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_edges_to ON memory_edges(to_memory_id);
CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON memory_sessions(workspace_ref, started_at);
CREATE INDEX IF NOT EXISTS idx_context_packs_session ON context_packs(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_context_entries_pack ON context_pack_entries(context_pack_id, rank);
CREATE INDEX IF NOT EXISTS idx_recall_exclusions_pack ON recall_exclusions(context_pack_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_session ON memory_usage_events(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ingest_events_session ON memory_ingest_events(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_violations_session ON agent_contract_violations(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_export_import_operation ON export_import_metadata(operation_id, operation_type);
`;

export function migrateStorage(db: DatabaseSync, now: () => string): void {
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("BEGIN IMMEDIATE");
    db.exec(BASELINE_SCHEMA_SQL);

    const row = db
      .prepare("SELECT version FROM storage_migrations WHERE version = ?")
      .get(BASELINE_SCHEMA_VERSION);

    if (row === undefined) {
      db.prepare(
        "INSERT INTO storage_migrations (version, name, applied_at) VALUES (?, ?, ?)"
      ).run(BASELINE_SCHEMA_VERSION, "001_baseline_soul_memory_storage", now());
    }

    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignore rollback failures so the original migration error is preserved.
    }

    throw new StorageError("MIGRATION_FAILED", "Failed to migrate SOUL Memory storage.", error);
  }
}

export function getSchemaVersion(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT MAX(version) AS version FROM storage_migrations")
    .get() as { readonly version: number | null } | undefined;

  return row?.version ?? 0;
}
