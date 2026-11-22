import { expect, it } from "vitest";
import { WorkspaceRunEventType } from "@do-soul/alaya-protocol";
import { SqliteEventLogRepo } from "../../../repos/runtime/event-log-repo.js";
import { SqliteWorkspaceRepo } from "../../../repos/runtime/workspace-repo.js";
import { SqliteClaimElectionLeaseRepo } from "../../../repos/lease/reconciliation-lease-repo.js";
import { initializeSemanticArtifactCandidateSchema } from "../../../repos/garden/semantic-artifact-schema.js";
import { createLexicalDomain, lexicalDomainTables } from "../../../repos/source-index/lexical-domain.js";
import { initDatabase, type SqliteConnection } from "../../../sqlite/db.js";
import { seedWorkspaceRow } from "../../migrations/apply-baseline.js";

const NOW = "2026-11-01T00:00:00.000Z";
const TABLES = [
  "garden_tasks", "garden_embedding_backfill_runs",
  "garden_semantic_artifacts", "garden_semantic_attempts", "garden_semantic_intents",
  "garden_semantic_work_claims", "garden_semantic_bindings", "garden_semantic_fts",
  "garden_semantic_projections", "garden_index_revisions", "garden_projection_cursor",
  "host_session_messages", "host_session_rounds", "host_session_containers",
  "host_session_tail_boundaries", "host_session_planning", "host_session_sweeps",
  "source_index_epochs", "source_index_roots", "source_index_dependencies",
  "source_index_selections", "source_index_generations", "source_index_targets",
  "source_index_text", "source_index_windows", "source_index_vectors",
  "source_index_lexical_selections", "source_index_lexical_generations",
  "source_index_lexical_targets", "source_index_lexical_projections", "source_index_lexical_progress"
] as const;

it("deletes the workspace runtime closure and retains its audit with foreign keys enabled", async () => {
  const database = initDatabase({ filename: ":memory:" });
  try {
    const { connection } = database;
    initializeSemanticArtifactCandidateSchema(connection);
    seedWorkspaceRow(connection, "remove");
    seedWorkspaceRow(connection, "keep");
    seedRuntime(connection, "keep");
    seedRuntime(connection, "remove");
    const leases = new SqliteClaimElectionLeaseRepo(database);
    const keepKey = 'claim-election:["keep","claim"]';
    const removeKey = 'claim-election:["remove","claim"]';
    const expires = "2026-11-01T00:05:00.000Z";
    expect(leases.tryAcquire(keepKey, "holder", NOW, expires)).not.toBeNull();
    expect(leases.tryAcquire(removeKey, "holder", NOW, expires)).not.toBeNull();
    connection.prepare(`
      INSERT INTO source_records
        (workspace_id, record_id, source_id, source_version, content_digest, recorded_at, operator_id, source_body)
      VALUES ('remove', 'independent-source', 'independent-source', '1', 'digest', ?, 'test', 'retained source')
    `).run(NOW);
    const events = new SqliteEventLogRepo(database);
    const audit = await events.append({
      event_type: WorkspaceRunEventType.RUN_CREATED, workspace_id: "remove",
      entity_type: "run", entity_id: "run", run_id: "run", caused_by: "test",
      payload_json: { run_id: "run", workspace_id: "remove", title: "run" }
    });
    expectRuntimeRows(connection, ["keep", "remove"]);

    new SqliteWorkspaceRepo(database).delete("remove");

    expectRuntimeRows(connection, ["keep"]);
    expect(leases.findByKey(removeKey)).toBeNull();
    expect(leases.findByKey(keepKey)).not.toBeNull();
    expect(connection.prepare("SELECT workspace_id FROM workspaces").pluck().all()).toEqual(["keep"]);
    expect(connection.prepare("SELECT workspace_id FROM source_records").all()).toEqual([]);
    await expect(events.queryByWorkspace("remove")).resolves.toEqual([audit]);
    expect(connection.pragma("foreign_key_check")).toEqual([]);
  } finally {
    database.close();
  }
});

function expectRuntimeRows(db: SqliteConnection, workspaceIds: readonly string[]): void {
  for (const table of TABLES) {
    expect(db.prepare(`SELECT workspace_id FROM ${table} ORDER BY workspace_id`).pluck().all(), table).toEqual(workspaceIds);
  }
  const objects = db.prepare("SELECT task_id FROM garden_embedding_backfill_objects ORDER BY task_id").pluck().all();
  expect(objects).toEqual(workspaceIds);
  for (const fts of ["source_index_fts", "source_index_fts_trigram"]) {
    expect(db.prepare(`SELECT rowid FROM ${fts} WHERE ${fts} MATCH 'searchable'`).all(), fts).toHaveLength(workspaceIds.length);
  }
  for (const workspace of ["keep", "remove"] as const) {
    for (const fts of Object.values(lexicalDomainTables(generationFor(workspace)))) {
      const exists = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(fts);
      expect(exists !== undefined, fts).toBe(workspaceIds.includes(workspace));
      if (exists !== undefined) {
        expect(db.prepare(`SELECT rowid FROM ${fts} WHERE ${fts} MATCH 'searchable'`).all()).toHaveLength(1);
      }
    }
  }
}

function seedRuntime(db: SqliteConnection, workspace: "keep" | "remove"): void {
  db.exec(`
    INSERT INTO garden_tasks (id, workspace_id, role, kind, payload_json, status, created_at)
      VALUES ('${workspace}', '${workspace}', 'janitor', 'embedding_backfill', '{}', 'pending', '${NOW}');
    INSERT INTO garden_embedding_backfill_runs (task_id, workspace_id, state, mode, updated_at)
      VALUES ('${workspace}', '${workspace}', 'pending', 'production', '${NOW}');
    INSERT INTO garden_embedding_backfill_objects (task_id, object_id, content_hash)
      VALUES ('${workspace}', 'memory', 'digest');
    INSERT INTO host_session_messages
      (workspace_id, container_key, message_id, position, container_scope, container_id, role,
        completeness, fidelity, content_digest, run_id, producer, admitted_at, pending_body)
      VALUES ('${workspace}', 'container', 'message', 1, 'scope', 'host', 'user',
        'complete', 'original_bytes', 'digest', 'run', 'cli', '${NOW}', 'capture');
    INSERT INTO host_session_rounds VALUES ('${workspace}', 'container', 1, 'root', 'pending');
    INSERT INTO host_session_tail_boundaries VALUES ('${workspace}', 'container', 1, 'pending');
    INSERT INTO host_session_planning VALUES ('${workspace}', 'container', 1, 1, 1, '[]', NULL, '[]');
    INSERT INTO host_session_sweeps VALUES ('${workspace}', 'container', 'idle', 1, NULL);
  `);
  seedGardenAttachments(db, workspace);
  seedSourceIndex(db, workspace);
}

function seedGardenAttachments(db: SqliteConnection, workspace: "keep" | "remove"): void {
  db.exec(`
    INSERT INTO garden_semantic_artifacts VALUES ('${workspace}', 'artifact', '{}', '{}', 'searchable', 'digest', NULL);
    INSERT INTO garden_semantic_attempts (id, task_id, workspace_id, artifact_key, state, ordinal)
      VALUES ('${workspace}', '${workspace}', '${workspace}', 'artifact', 'received', 1);
    INSERT INTO garden_semantic_intents VALUES ('${workspace}', 'memory', '${workspace}');
    INSERT INTO garden_semantic_work_claims VALUES ('${workspace}', 'artifact', '${workspace}');
    INSERT INTO garden_semantic_bindings VALUES ('${workspace}', 'memory', 'revision', 'occurrence', 'artifact', '{}');
    INSERT INTO garden_semantic_fts VALUES ('${workspace}', 'memory', 'searchable');
    INSERT INTO garden_semantic_projections VALUES
      ('${workspace}', 'memory', 'revision', 'publication', '${workspace}', 'content', 'searchable', '${NOW}', '[]', '${NOW}', 0);
    INSERT INTO garden_index_revisions VALUES
      ('${workspace}', 'memory', 0, 'content', '[]', '${NOW}', NULL, NULL, 0, '${NOW}');
  `);
}

function generationFor(workspace: "keep" | "remove"): string {
  return `sha256:${(workspace === "keep" ? "a" : "b").repeat(64)}`;
}

function seedSourceIndex(db: SqliteConnection, workspace: "keep" | "remove"): void {
  const generation = generationFor(workspace);
  createLexicalDomain(db, workspace, generation);
  db.exec(`
    INSERT INTO source_index_epochs VALUES ('${workspace}', 1);
    INSERT INTO source_index_roots VALUES ('${workspace}', 'root', 'source_record', 'indexed', 'source', '{}');
    INSERT INTO source_index_dependencies VALUES ('${workspace}', 'root', 'source_record', 'indexed', 'source');
    INSERT INTO source_index_selections VALUES ('${workspace}', 1, 'config', 'profile', '{}', 'gen');
    INSERT INTO source_index_generations
      (workspace_id, generation_id, selection_revision, config_id, profile_id, configuration_json, source_epoch, status)
      VALUES ('${workspace}', 'gen', 1, 'config', 'profile', '{}', 1, 'building');
    INSERT INTO source_index_targets (workspace_id, generation_id, root_key) VALUES ('${workspace}', 'gen', 'root');
    INSERT INTO source_index_text (workspace_id, root_key, content_digest, body_bytes, body)
      VALUES ('${workspace}', 'root', 'digest', 10, 'searchable');
    INSERT INTO source_index_windows VALUES ('${workspace}', 'gen', 'root', 'window', 0, 0, 10, 'digest', 'searchable');
    INSERT INTO source_index_vectors VALUES ('${workspace}', 'gen', 'root', 'window', 1, zeroblob(4), 1);
    INSERT INTO source_index_lexical_selections VALUES ('${workspace}', 1, 'segmented-unicode61.v2', '${generation}');
    INSERT INTO source_index_lexical_generations
      (workspace_id, generation_id, selection_revision, representation, source_epoch, status)
      VALUES ('${workspace}', '${generation}', 1, 'segmented-unicode61.v2', 1, 'building');
    INSERT INTO source_index_lexical_targets VALUES ('${workspace}', '${generation}', 'root', 0);
    INSERT INTO source_index_lexical_projections (workspace_id, generation_id, root_key, content_digest, body_bytes, projection)
      VALUES ('${workspace}', '${generation}', 'root', 'digest', 10, 'searchable');
    INSERT INTO source_index_lexical_progress VALUES ('${workspace}', '${generation}', 'root', 0, 10, 'searchable', 'searchable', '');
  `);
}
