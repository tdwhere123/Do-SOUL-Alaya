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

describe("semantic enrichment task identity", () => {
  it("does not change the task id when profile field insertion order changes", () => {
    const { database, repo } = openRepo();
    const forward = {
      capability: "official_api_signals:v1",
      model: "fixture",
      requestProfile: "logical-request-v1",
      promptRevision: "fixture-v1",
      outputSchema: "official-api-signals-v1"
    };
    const reverse = {
      outputSchema: "official-api-signals-v1",
      promptRevision: "fixture-v1",
      requestProfile: "logical-request-v1",
      model: "fixture",
      capability: "official_api_signals:v1"
    };
    const first = database.connection.transaction(() => repo.enqueue(WS, OBJECT, forward, NOW))();
    const second = database.connection.transaction(() => repo.enqueue(WS, OBJECT, reverse, NOW))();
    expect(first).toBe(second);
    expect(first.startsWith("semantic:")).toBe(true);
  });
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
  return { database, repo: new SqliteSemanticArtifactRepo(database.connection, garden) };
}
