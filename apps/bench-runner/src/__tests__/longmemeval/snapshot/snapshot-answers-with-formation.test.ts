import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase } from "@do-soul/alaya-storage";
import { afterEach, describe, expect, it } from "vitest";
import { assertSnapshotAnswersWithFormation } from
  "../../../longmemeval/snapshot/current/snapshot-answers-with-formation.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe("snapshot answers_with formation readiness", () => {
  it("requires an eligible active positive governed answers_with row", async () => {
    const root = await mkdtemp(join(tmpdir(), "snapshot-answers-with-"));
    roots.push(root);
    const dbPath = join(root, "snapshot.db");
    const database = initDatabase({ filename: dbPath });
    seedWorkspace(database.connection);
    insertEligibleAnswersWith(database.connection);

    expect(() => assertSnapshotAnswersWithFormation(dbPath))
      .toThrow(/eligible.*answers_with|answers_with.*eligible/iu);

    seedHqEndpoint(database.connection, "memory-a");
    seedHqEndpoint(database.connection, "memory-b");

    expect(() => assertSnapshotAnswersWithFormation(
      dbPath,
      ["longmemeval-q-1"]
    )).not.toThrow();
    expect(() => assertSnapshotAnswersWithFormation(
      dbPath,
      ["longmemeval-q-1", "longmemeval-q-2"]
    )).toThrow(/coverage mismatch/u);
    database.close();
  });
});

type SqliteConnection = ReturnType<typeof initDatabase>["connection"];

function seedWorkspace(db: SqliteConnection): void {
  db.prepare(`INSERT INTO workspaces (
    workspace_id, name, root_path, workspace_kind, default_engine_binding,
    workspace_state, created_at, archived_at, default_engine_class
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "longmemeval-q-1",
    "Snapshot Formation Workspace",
    "/tmp/longmemeval-q-1",
    "local_repo",
    null,
    "active",
    "2026-07-30T00:00:00.000Z",
    null,
    null
  );
}

function insertEligibleAnswersWith(db: SqliteConnection): void {
  const generation = "fixture-answers-with";
  const asOf = "2026-07-30T00:00:00.000Z";
  const digest = "e".repeat(64);
  db.prepare(`INSERT INTO temporal_projection_generations (
    generation, assertion_schema_generation, assertion_event_contract_generation,
    projection_schema_generation, projection_policy_id, projection_policy_sha256,
    history_digest, as_of, projection_count, projection_digest, status,
    created_at, verified_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'verified', ?, ?)`).run(
    generation,
    "relation_assertion_v2",
    "relation_assertion_event_v2",
    "relation_path_projection_v1",
    "relation-path-projection-v1",
    digest,
    digest,
    asOf,
    digest,
    asOf,
    asOf
  );
  const path = {
    path_id: "path-answers-with",
    workspace_id: "longmemeval-q-1",
    anchors: {
      source_anchor: { kind: "object", object_id: "memory-a" },
      target_anchor: { kind: "object", object_id: "memory-b" }
    },
    constitution: {
      relation_kind: "answers_with",
      why_this_relation_exists: ["answer overlap"]
    },
    effect_vector: {
      salience: 1,
      recall_bias: 1,
      verification_bias: 0,
      unfinishedness_bias: 0,
      default_manifestation_preference: "lens_entry"
    },
    plasticity_state: {
      strength: 1,
      direction_bias: "source_to_target",
      stability_class: "stable",
      support_events_count: 1,
      contradiction_events_count: 0
    },
    lifecycle: { status: "active", retirement_rule: "manual" },
    legitimacy: {
      evidence_basis: ["answer overlap"],
      governance_class: "recall_allowed"
    },
    created_at: asOf,
    updated_at: asOf
  };
  db.prepare(`INSERT INTO relation_assertions (
    assertion_id, workspace_id, admission_event_id, identity_key,
    anchors_json, relation_kind, validity_json, formation_receipt_json, admitted_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "assertion-answers-with",
    path.workspace_id,
    "admission-answers-with",
    "identity-answers-with",
    JSON.stringify(path.anchors),
    path.constitution.relation_kind,
    JSON.stringify({ kind: "open", valid_from: asOf }),
    JSON.stringify({}),
    asOf
  );
  db.prepare(`INSERT INTO relation_path_projections (
    generation, path_id, assertion_id, workspace_id, projection_json
  ) VALUES (?, ?, ?, ?, ?)`).run(
    generation,
    path.path_id,
    "assertion-answers-with",
    path.workspace_id,
    JSON.stringify(path)
  );
  db.prepare(`UPDATE temporal_schema_state
    SET active_projection_generation = ?, active_as_of = ?,
        history_digest = ?, projection_count = 1, projection_digest = ?,
        status = 'ready', updated_at = ?
    WHERE state_id = 1`).run(
    generation,
    asOf,
    digest,
    digest,
    asOf
  );
}

function seedHqEndpoint(db: SqliteConnection, objectId: string): void {
  db.prepare(`INSERT INTO memory_entries (
    object_id, created_at, updated_at, created_by, dimension, source_kind,
    formation_kind, scope_class, content, workspace_id, run_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    objectId,
    "2026-07-30T00:00:00.000Z",
    "2026-07-30T00:00:00.000Z",
    "system",
    "procedure",
    "user",
    "explicit",
    "project",
    objectId,
    "longmemeval-q-1",
    "run-q-1"
  );
  db.prepare(`INSERT INTO memory_hq (
    object_id, workspace_id, hqs_json, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?)`).run(
    objectId,
    "longmemeval-q-1",
    JSON.stringify([objectId]),
    "2026-07-30T00:00:00.000Z",
    "2026-07-30T00:00:00.000Z"
  );
}
