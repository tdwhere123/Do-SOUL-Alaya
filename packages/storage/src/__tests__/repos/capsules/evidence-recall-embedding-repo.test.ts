import { afterEach, describe, expect, it } from "vitest";
import {
  RunMode,
  RunState,
  WorkspaceKind,
  WorkspaceState
} from "@do-soul/alaya-protocol";
import { initDatabase, type StorageDatabase } from "../../../sqlite/db.js";
import { SqliteEvidenceRecallEmbeddingRepo } from "../../../repos/capsules/embedding/evidence-recall-embedding-repo.js";
import { SqliteRunRepo } from "../../../repos/runtime/run-repo.js";
import { SqliteWorkspaceRepo } from "../../../repos/runtime/workspace-repo.js";

const databases = new Set<StorageDatabase>();
const SOURCE_HASH = `sha256:garden-source-turn-fallback-v2:${"a".repeat(64)}`;

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("evidence recall embedding storage", () => {
  it("lists only recall-authority document shapes", async () => {
    const storage = (await import("../../../index.js")) as Record<string, unknown>;
    const { database, repo } = await createFixture();
    seedEvidence(database);

    expect(storage.SqliteEvidenceRecallEmbeddingRepo).toBeTypeOf("function");
    expect(database.connection.prepare("SELECT MAX(version) AS version FROM schema_version").pluck().all()).toEqual([9]);
    expect(await repo.listSourcesByWorkspace("workspace-1")).toEqual([
      expect.objectContaining({
        ownerObjectId: "evidence-1",
        documentIdentity: "assistant_observation:2",
        content: "Assistant observation."
      }),
      expect.objectContaining({
        ownerObjectId: "evidence-1",
        documentIdentity: "fact_key:3",
        content: "recommended_color=blue"
      }),
      expect.objectContaining({
        ownerObjectId: "evidence-1",
        documentIdentity: "owner",
        content: "User-owned excerpt."
      }),
      expect.objectContaining({
        ownerObjectId: "evidence-1",
        documentIdentity: "owner_gist_600",
        content: "Whole turn."
      })
    ]);
  });

  it("loads only exact content and model identities and replaces stale content in place", async () => {
    const { database, repo } = await createFixture();
    seedEvidence(database);
    const base = {
      workspaceId: "workspace-1",
      ownerObjectId: "evidence-1",
      documentIdentity: "owner",
      documentRole: "evidence_document" as const,
      providerKind: "local_onnx",
      modelId: "fixture-model",
      schemaVersion: 1,
      dimensions: 2,
      createdAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-28T00:00:00.000Z"
    };
    await repo.upsertMany([{
      ...base,
      contentHash: "sha256:first",
      embedding: new Float32Array([1, 2])
    }]);

    await expect(repo.findByDocuments({
      workspaceId: "workspace-1",
      documents: [{
        ownerObjectId: "evidence-1",
        documentIdentity: "owner",
        contentHash: "sha256:first"
      }],
      documentRole: "evidence_document",
      providerKind: "local_onnx",
      modelId: "fixture-model",
      schemaVersion: 1
    })).resolves.toHaveLength(1);

    await repo.upsertMany([{
      ...base,
      contentHash: "sha256:second",
      embedding: new Float32Array([3, 4]),
      updatedAt: "2026-07-28T00:01:00.000Z"
    }]);

    expect(database.connection.prepare(
      "SELECT COUNT(*) FROM evidence_recall_embeddings"
    ).pluck().get()).toBe(1);
    await expect(repo.findByDocuments({
      workspaceId: "workspace-1",
      documents: [{
        ownerObjectId: "evidence-1",
        documentIdentity: "owner",
        contentHash: "sha256:first"
      }],
      documentRole: "evidence_document",
      providerKind: "local_onnx",
      modelId: "fixture-model",
      schemaVersion: 1
    })).resolves.toEqual([]);
  });
});

async function createFixture() {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  await new SqliteWorkspaceRepo(database).create({
    workspace_id: "workspace-1",
    name: "workspace one",
    root_path: "/tmp/workspace-1",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  await new SqliteRunRepo(database).create({
    run_id: "run-1",
    workspace_id: "workspace-1",
    title: "run one",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
  return { database, repo: new SqliteEvidenceRecallEmbeddingRepo(database) };
}

function seedEvidence(database: StorageDatabase): void {
  database.connection.prepare(`
    INSERT INTO evidence_capsules (
      object_id, created_at, updated_at, created_by, evidence_kind,
      semantic_anchor, physical_anchor, evidence_health_state, gist, excerpt,
      source_hash, run_id, workspace_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "evidence-1",
    "2026-07-28T00:00:00.000Z",
    "2026-07-28T00:00:00.000Z",
    "garden_compile",
    "conversation_excerpt",
    "{}",
    JSON.stringify({ artifact_ref: "alaya:garden-turn-evidence:signal-1" }),
    "verified",
    "Whole turn.",
    "User-owned excerpt.",
    SOURCE_HASH,
    "run-1",
    "workspace-1"
  );
  const insertProjection = database.connection.prepare(`
    INSERT INTO evidence_search_projections (
      evidence_object_id, projection_id, projection_kind,
      workspace_id, source_hash, content
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertProjection.run(
    "evidence-1", 1, "user_assertion", "workspace-1", SOURCE_HASH, "User assertion."
  );
  insertProjection.run(
    "evidence-1", 2, "assistant_observation", "workspace-1", SOURCE_HASH,
    "Assistant observation."
  );
  insertProjection.run(
    "evidence-1", 3, "fact_key", "workspace-1", SOURCE_HASH,
    "recommended_color=blue"
  );
}
