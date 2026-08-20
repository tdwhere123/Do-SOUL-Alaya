import { createHash } from "node:crypto";
import {
  buildVerifiedUserAssertionReceiptPreimage,
  formatVerifiedUserAssertionSourceHash
} from "@do-soul/alaya-protocol";
import { initDatabase } from "@do-soul/alaya-storage";

const WORKSPACE_ID = "legacy-v1-workspace";
const RUN_ID = "legacy-v1-run";
const SIGNAL_ID = "legacy-v1-signal";
const EVIDENCE_ID = "legacy-v1-evidence";
const ASSERTION = "I use the legacy release channel.";
const CORPUS = `User: ${ASSERTION}`;
const CREATED_AT = "2026-07-16T00:00:00.000Z";

export function seedValidV1VerifiedAssertionReceipt(dbPath: string): void {
  const database = initDatabase({ filename: dbPath });
  try {
    insertWorkspaceAndRun(database);
    const sourceHash = buildV1SourceHash();
    insertSignal(database, sourceHash);
    insertCapsule(database, sourceHash);
    insertMaterializationEvent(database);
  } finally {
    database.close();
  }
}

function insertWorkspaceAndRun(database: ReturnType<typeof initDatabase>): void {
  database.connection.prepare(`
    INSERT INTO workspaces (
      workspace_id, name, root_path, workspace_kind, workspace_state, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(WORKSPACE_ID, "fixture", "/fixture", "project", "active", CREATED_AT);
  database.connection.prepare(`
    INSERT INTO runs (
      run_id, workspace_id, title, run_mode, run_state, created_at, last_active_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(RUN_ID, WORKSPACE_ID, "fixture", "bench", "idle", CREATED_AT, CREATED_AT);
}

function insertSignal(
  database: ReturnType<typeof initDatabase>,
  sourceHash: string
): void {
  database.connection.prepare(`
    INSERT INTO signals (
      signal_id, workspace_id, run_id, surface_id, source, signal_kind,
      object_kind, scope_hint, domain_tags_json, confidence, evidence_refs_json,
      raw_payload_json, signal_state, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    SIGNAL_ID, WORKSPACE_ID, RUN_ID, null, "garden_compile", "potential_preference",
    "fact", "project", "[]", 0.9, "[]", JSON.stringify({
      full_turn_content: CORPUS,
      source_assertion: ASSERTION,
      verified_user_assertion_source_hash: sourceHash
    }), "materialized", CREATED_AT
  );
}

function insertCapsule(
  database: ReturnType<typeof initDatabase>,
  sourceHash: string
): void {
  database.connection.prepare(`
    INSERT INTO evidence_capsules (
      object_id, object_kind, schema_version, lifecycle_state, created_at, updated_at,
      created_by, evidence_kind, semantic_anchor, physical_anchor,
      evidence_health_state, gist, excerpt, source_hash, run_id, workspace_id, surface_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    EVIDENCE_ID, "evidence_capsule", 1, "active", CREATED_AT, CREATED_AT,
    "garden_compile", "conversation_excerpt", "{}", "{}", "verified",
    CORPUS, ASSERTION, sourceHash, RUN_ID, WORKSPACE_ID, null
  );
}

function insertMaterializationEvent(database: ReturnType<typeof initDatabase>): void {
  database.connection.prepare(`
    INSERT INTO event_log (
      event_id, event_type, entity_type, entity_id, workspace_id, run_id,
      caused_by, revision, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "legacy-v1-materialized-event", "soul.signal.materialized",
    "candidate_memory_signal", SIGNAL_ID, WORKSPACE_ID, RUN_ID,
    "materialization_router", 0, JSON.stringify({
      signal_id: SIGNAL_ID,
      workspace_id: WORKSPACE_ID,
      run_id: RUN_ID,
      created_objects: [{ object_kind: "evidence_capsule", object_id: EVIDENCE_ID }],
      success: true
    }), CREATED_AT
  );
}

function buildV1SourceHash(): string {
  const preimage = buildVerifiedUserAssertionReceiptPreimage({
    workspace_id: WORKSPACE_ID,
    run_id: RUN_ID,
    surface_id: null,
    source_assertion: ASSERTION,
    source_corpus: CORPUS
  });
  return formatVerifiedUserAssertionSourceHash(
    createHash("sha256").update(preimage, "utf8").digest("hex")
  );
}
