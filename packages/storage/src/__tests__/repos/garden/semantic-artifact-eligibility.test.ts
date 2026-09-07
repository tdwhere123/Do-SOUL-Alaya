import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceKind, WorkspaceState } from "@do-soul/alaya-protocol";
import { initDatabase, type StorageDatabase } from "../../../sqlite/db.js";
import { SqliteWorkspaceRepo } from "../../../repos/runtime/workspace-repo.js";
import { SqliteGardenTaskRepo } from "../../../repos/garden/garden-task-repo.js";
import { SqliteSemanticArtifactRepo } from "../../../repos/garden/semantic-artifact-repo.js";
import { initializeSemanticArtifactCandidateSchema } from "../../../repos/garden/semantic-artifact-schema.js";

const databases = new Set<StorageDatabase>();
afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

const WS = "workspace-1";
const OBJECT = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const NOW = "2026-09-01T00:00:00.000Z";
const PROFILE = Object.freeze({
  capability: "official_api_signals:v1",
  model: "fixture",
  requestProfile: "logical-request-v1",
  promptRevision: "fixture-v1",
  outputSchema: "official-api-signals-v1"
});

function openRepo(): { database: StorageDatabase; repo: SqliteSemanticArtifactRepo } {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  initializeSemanticArtifactCandidateSchema(database.connection);
  new SqliteWorkspaceRepo(database).create({
    workspace_id: WS,
    name: "workspace one",
    root_path: "/tmp/ws1",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  database.connection.prepare(`INSERT INTO event_log(
    event_id, event_type, entity_type, entity_id, workspace_id, run_id, caused_by, payload_json, created_at, revision
  ) VALUES ('evt-1', 'soul.memory.created', 'memory_entry', ?, ?, 'run-1', 'user_action', '{}', ?, 1)`)
    .run(OBJECT, WS, NOW);
  database.connection.prepare(`INSERT INTO memory_entries(
    object_id, object_kind, schema_version, workspace_id, run_id, created_by, dimension, source_kind,
    formation_kind, scope_class, content, domain_tags, evidence_refs, lifecycle_state, created_at, updated_at
  ) VALUES (?, 'memory_entry', 1, ?, 'run-1', 'user_action', 'fact', 'user', 'explicit', 'project',
    'Alice owns Orion', '[]', '[]', 'active', ?, ?)`)
    .run(OBJECT, WS, NOW, NOW);
  const garden = new SqliteGardenTaskRepo(database.connection, {
    appendManyWithMutation: async (_events, mutate) => mutate([])
  });
  return { database, repo: new SqliteSemanticArtifactRepo(database.connection, garden, PROFILE) };
}

describe("semantic artifact source eligibility", () => {
  it("treats active+tombstoned rows as missing at source lookup, enqueue, and ready search", () => {
    const { database, repo } = openRepo();
    expect(repo.source(WS, OBJECT)).not.toBeNull();
    const taskId = database.connection.transaction(() => repo.enqueue(WS, OBJECT, PROFILE, NOW))();
    expect(taskId.length).toBeGreaterThan(0);
    database.connection.prepare("UPDATE memory_entries SET retention_state='tombstoned' WHERE object_id=?")
      .run(OBJECT);
    expect(repo.source(WS, OBJECT)).toBeNull();
    expect(() => database.connection.transaction(() => repo.enqueue(WS, OBJECT, PROFILE, NOW))())
      .toThrow(/source missing, revoked, or outside trusted scope/);
    database.connection.prepare("INSERT INTO garden_semantic_fts VALUES (?, ?, ?)")
      .run(WS, OBJECT, "Alice owns Orion");
    expect(repo.searchReady(WS, "Orion", 10)).toEqual([]);
  });
});
