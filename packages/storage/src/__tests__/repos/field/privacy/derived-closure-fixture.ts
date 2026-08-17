import type { StorageDatabase } from "../../../../sqlite/db.js";

export const DERIVED_MARKER = "derivedsecret7f4d";
export const DERIVED_MEMORY_ID = "memory-private-derived";
export const DERIVED_SYNTHESIS_ID = "synthesis-private-derived";

export function seedDerivedPrivacyClosure(
  database: StorageDatabase,
  evidenceId: string
): void {
  seedMemory(database, evidenceId);
  seedMemoryArtifacts(database, evidenceId);
  seedSynthesis(database, evidenceId);
}

function seedMemory(database: StorageDatabase, evidenceId: string): void {
  database.connection.prepare(`
    INSERT INTO memory_entries (
      object_id, object_kind, schema_version, lifecycle_state, created_at, updated_at,
      created_by, dimension, source_kind, formation_kind, scope_class, content,
      domain_tags, evidence_refs, workspace_id, run_id, storage_tier,
      activation_score, retention_score, manifestation_state, retention_state,
      decay_profile, confidence, reinforcement_count, contradiction_count,
      preference_subject, preference_object, facet_tags, canonical_entities
    ) VALUES (?, 'memory_entry', 1, 'active', ?, ?, 'test', 'fact', 'user',
      'explicit', 'project', ?, ?, ?, 'workspace-1', 'run-private', 'hot',
      0.5, 0.5, 'hint', 'working', 'normal', 0.5, 0, 0, ?, ?, ?, ?)
  `).run(
    DERIVED_MEMORY_ID,
    "2026-08-16T00:00:00.000Z",
    "2026-08-16T00:00:00.000Z",
    `${DERIVED_MARKER} memory content`,
    JSON.stringify([DERIVED_MARKER]),
    JSON.stringify([evidenceId, "evidence-unrelated"]),
    `${DERIVED_MARKER} subject`,
    `${DERIVED_MARKER} object`,
    JSON.stringify([DERIVED_MARKER]),
    JSON.stringify([{ value: DERIVED_MARKER }])
  );
  database.connection.prepare(`
    INSERT INTO memory_entry_evidence_refs (workspace_id, memory_id, evidence_ref)
    VALUES ('workspace-1', ?, ?), ('workspace-1', ?, 'evidence-unrelated')
  `).run(DERIVED_MEMORY_ID, evidenceId, DERIVED_MEMORY_ID);
}

function seedMemoryArtifacts(database: StorageDatabase, evidenceId: string): void {
  database.connection.prepare(`
    INSERT INTO memory_embeddings (
      object_id, workspace_id, content_hash, provider_kind, model_id, schema_version,
      dimensions, embedding_blob, created_at, updated_at, vector_valid
    ) VALUES (?, 'workspace-1', ?, 'local', 'test', 1, 1, ?, ?, ?, 1)
  `).run(
    DERIVED_MEMORY_ID,
    DERIVED_MARKER,
    Buffer.from([0, 0, 128, 63]),
    "2026-08-16T00:00:00.000Z",
    "2026-08-16T00:00:00.000Z"
  );
  database.connection.prepare(`
    INSERT INTO memory_object_keys (
      workspace_id, owner_id, key_id, key_type, surface, normalized_surface,
      language, source_kind, source_ref
    ) VALUES ('workspace-1', ?, 'key-private', 'gist_remainder', ?, ?, 'en',
      'stored_text', ?)
  `).run(DERIVED_MEMORY_ID, DERIVED_MARKER, DERIVED_MARKER, evidenceId);
  database.connection.prepare(`
    INSERT INTO memory_hq (object_id, workspace_id, hqs_json, created_at, updated_at)
    VALUES (?, 'workspace-1', ?, ?, ?)
  `).run(
    DERIVED_MEMORY_ID,
    JSON.stringify([DERIVED_MARKER]),
    "2026-08-16T00:00:00.000Z",
    "2026-08-16T00:00:00.000Z"
  );
}

function seedSynthesis(database: StorageDatabase, evidenceId: string): void {
  database.connection.prepare(`
    INSERT INTO synthesis_capsules (
      object_id, object_kind, schema_version, lifecycle_state, created_at, updated_at,
      created_by, topic_key, synthesis_type, summary, evidence_refs,
      source_memory_refs, workspace_id, run_id, synthesis_status
    ) VALUES (?, 'synthesis_capsule', 1, 'active', ?, ?, 'test', ?,
      'phase_synthesis', ?, ?, ?, 'workspace-1', 'run-private', 'working')
  `).run(
    DERIVED_SYNTHESIS_ID,
    "2026-08-16T00:00:00.000Z",
    "2026-08-16T00:00:00.000Z",
    `${DERIVED_MARKER}.topic`,
    `${DERIVED_MARKER} synthesis summary`,
    JSON.stringify(["evidence-unrelated"]),
    JSON.stringify([DERIVED_MEMORY_ID])
  );
}

export function readDerivedPrivacyState(database: StorageDatabase): unknown {
  const memory = database.connection.prepare(`
    SELECT content, domain_tags, lifecycle_state, retention_state, manifestation_state,
      preference_subject, preference_object, facet_tags, canonical_entities
    FROM memory_entries WHERE object_id = ?
  `).get(DERIVED_MEMORY_ID);
  const synthesis = database.connection.prepare(`
    SELECT lifecycle_state, synthesis_status, topic_key, summary
    FROM synthesis_capsules WHERE object_id = ?
  `).get(DERIVED_SYNTHESIS_ID);
  const hq = database.connection.prepare(
    "SELECT hqs_json FROM memory_hq WHERE object_id = ?"
  ).get(DERIVED_MEMORY_ID);
  return { memory, synthesis, hq };
}

export function derivedPrivacyArtifactCounts(database: StorageDatabase): readonly number[] {
  return [
    count(database, "memory_embeddings", "object_id", DERIVED_MEMORY_ID),
    count(database, "memory_object_keys", "owner_id", DERIVED_MEMORY_ID),
    ftsCount(database, "memory_content_fts", DERIVED_MARKER),
    ftsCount(database, "memory_object_key_fts", DERIVED_MARKER),
    ftsCount(database, "synthesis_capsule_fts", DERIVED_MARKER)
  ];
}

export function restoreDerivedMemoryContent(database: StorageDatabase): void {
  database.connection.prepare(
    "UPDATE memory_entries SET content = 'restored private content' WHERE object_id = ?"
  ).run(DERIVED_MEMORY_ID);
}

export function restoreDerivedMemoryEmbedding(database: StorageDatabase): void {
  database.connection.prepare(`
    INSERT INTO memory_embeddings (
      object_id, workspace_id, content_hash, provider_kind, model_id, schema_version,
      dimensions, embedding_blob, created_at, updated_at, vector_valid
    ) VALUES (?, 'workspace-1', 'restored', 'local', 'test', 1, 1, ?, ?, ?, 1)
  `).run(
    DERIVED_MEMORY_ID,
    Buffer.from([0, 0, 128, 63]),
    "2026-08-16T00:00:00.000Z",
    "2026-08-16T00:00:00.000Z"
  );
}

export function restoreDerivedSynthesis(database: StorageDatabase): void {
  database.connection.prepare(
    "UPDATE synthesis_capsules SET summary = 'restored private summary' WHERE object_id = ?"
  ).run(DERIVED_SYNTHESIS_ID);
}

export function restoreDerivedPreference(database: StorageDatabase): void {
  database.connection.prepare(
    "UPDATE memory_entries SET preference_subject = 'restored private subject' WHERE object_id = ?"
  ).run(DERIVED_MEMORY_ID);
}

export function restoreDerivedHq(database: StorageDatabase): void {
  database.connection.prepare(
    "UPDATE memory_hq SET hqs_json = '[\"restored private HQ\"]' WHERE object_id = ?"
  ).run(DERIVED_MEMORY_ID);
}

export function restoreDerivedRouting(database: StorageDatabase): void {
  database.connection.prepare(`
    INSERT INTO recall_routing_key_owners (
      workspace_id, owner_id, owner_kind, signal_id, materialized_at
    ) VALUES ('workspace-1', ?, 'memory_entry', 'restored-signal', ?)
  `).run(DERIVED_MEMORY_ID, "2026-08-16T00:00:00.000Z");
}

export function restoreDerivedHqObservation(
  database: StorageDatabase,
  evidenceId: string
): void {
  database.connection.prepare(`
    INSERT INTO memory_hq_observations (
      observation_id, object_id, workspace_id, evidence_id, source_event_type,
      source_event_id, source_occurred_at, producer_id, hqs_json,
      hq_content_sha256, observation_sha256, recorded_at
    ) VALUES ('restored-observation', ?, 'workspace-1', ?, 'test', 'restored-event',
      ?, 'test', '["restored private HQ"]', 'restored-content', 'restored-observation', ?)
  `).run(
    DERIVED_MEMORY_ID,
    evidenceId,
    "2026-08-16T00:00:00.000Z",
    "2026-08-16T00:00:00.000Z"
  );
}

export function restoreSourceMemorySynthesis(database: StorageDatabase): void {
  database.connection.prepare(`
    INSERT INTO synthesis_capsules (
      object_id, object_kind, schema_version, lifecycle_state, created_at, updated_at,
      created_by, topic_key, synthesis_type, summary, evidence_refs, source_memory_refs,
      workspace_id, run_id, synthesis_status
    ) VALUES ('restored-synthesis', 'synthesis_capsule', 1, 'active', ?, ?, 'test',
      'restored-private', 'phase_synthesis', 'restored private synthesis', '[]', ?,
      'workspace-1', 'run-private', 'working')
  `).run(
    "2026-08-16T00:00:00.000Z",
    "2026-08-16T00:00:00.000Z",
    JSON.stringify([DERIVED_MEMORY_ID])
  );
}

export function restoreSourceMemorySynthesisRouting(database: StorageDatabase): void {
  database.connection.prepare(`
    INSERT INTO recall_routing_key_owners (
      workspace_id, owner_id, owner_kind, signal_id, materialized_at
    ) VALUES ('workspace-1', ?, 'synthesis_capsule', 'restored-synthesis-signal', ?)
  `).run(DERIVED_SYNTHESIS_ID, "2026-08-16T00:00:00.000Z");
}

function count(database: StorageDatabase, table: string, column: string, value: string): number {
  return (database.connection.prepare(
    `SELECT count(*) AS count FROM ${table} WHERE ${column} = ?`
  ).get(value) as { count: number }).count;
}

function ftsCount(database: StorageDatabase, table: string, query: string): number {
  return (database.connection.prepare(
    `SELECT count(*) AS count FROM ${table} WHERE ${table} MATCH ?`
  ).get(query) as { count: number }).count;
}
