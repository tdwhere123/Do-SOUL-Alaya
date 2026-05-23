import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  MemoryDimension,
  RunMode,
  RunState,
  ScopeClass,
  WorkspaceKind,
  WorkspaceState,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import { initDatabase } from "../db.js";
import { SqliteMemoryEntryRepo } from "../repos/memory-entry-repo.js";
import { SqliteRunRepo } from "../repos/run-repo.js";
import { SqliteWorkspaceRepo } from "../repos/workspace-repo.js";
import type { MemoryEmbeddingRecord } from "../repos/memory-embedding-repo.js";

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("Memory embedding storage repo", () => {
  it("applies migration 052, exports the repo, and persists embeddings keyed by memory object id", async () => {
    const storage = (await import("../index.js")) as Record<string, unknown>;
    const { database, workspaceId, repo } = await createRepoContext();

    expect(storage.SqliteMemoryEmbeddingRepo).toBeTypeOf("function");

    const versions = database.connection
      .prepare("SELECT version FROM schema_version WHERE version = 52")
      .all() as ReadonlyArray<{ readonly version: number }>;
    const columns = getColumnNames(database, "memory_embeddings");

    expect(versions.map((entry) => entry.version)).toEqual([52]);
    expect(columns).toEqual([
      "object_id",
      "workspace_id",
      "content_hash",
      "provider_kind",
      "model_id",
      "schema_version",
      "dimensions",
      "embedding_blob",
      "created_at",
      "updated_at"
    ]);

    const persisted = await repo.upsert(
      createEmbeddingRecord({
        object_id: "11111111-1111-4111-8111-111111111111",
        workspace_id: workspaceId,
        embedding: new Float32Array([0.25, -0.5, 0.75])
      })
    );

    expect(persisted).toMatchObject({
      object_id: "11111111-1111-4111-8111-111111111111",
      workspace_id: workspaceId,
      content_hash: "sha256:11111111-1111-4111-8111-111111111111",
      provider_kind: "openai",
      model_id: "text-embedding-3-small",
      schema_version: 1,
      dimensions: 3,
      created_at: "2026-04-23T00:00:00.000Z",
      updated_at: "2026-04-23T00:00:00.000Z"
    });
    expect(Array.from(persisted.embedding)).toEqual([0.25, -0.5, 0.75]);
    await expect(repo.findByObjectId("11111111-1111-4111-8111-111111111111")).resolves.toMatchObject({
      object_id: "11111111-1111-4111-8111-111111111111",
      workspace_id: workspaceId,
      dimensions: 3
    });
    expect(Array.from((await repo.findByObjectId("11111111-1111-4111-8111-111111111111"))!.embedding)).toEqual([
      0.25,
      -0.5,
      0.75
    ]);
    await expect(repo.listByWorkspace(workspaceId)).resolves.toEqual([persisted]);
  });

  it("allows migration 052 DDL to be re-run without failing on existing objects", async () => {
    const { database } = await createRepoContext();
    const migrationSql = readFileSync(
      new URL("../migrations/052-memory-embeddings.sql", import.meta.url),
      "utf8"
    );

    expect(() => database.connection.exec(migrationSql)).not.toThrow();
  });

  it("updates existing rows in place and lists only requested object ids", async () => {
    const { workspaceId, repo } = await createRepoContext();

    await repo.upsert(
      createEmbeddingRecord({
        object_id: "11111111-1111-4111-8111-111111111111",
        workspace_id: workspaceId,
        content_hash: "sha256:first",
        embedding: new Float32Array([1, 0, 0])
      })
    );
    await repo.upsert(
      createEmbeddingRecord({
        object_id: "22222222-2222-4222-8222-222222222222",
        workspace_id: workspaceId,
        content_hash: "sha256:second",
        embedding: new Float32Array([0, 1, 0])
      })
    );

    const updated = await repo.upsert(
      createEmbeddingRecord({
        object_id: "11111111-1111-4111-8111-111111111111",
        workspace_id: workspaceId,
        content_hash: "sha256:updated",
        embedding: new Float32Array([0.1, 0.2, 0.3]),
        created_at: "2026-04-23T00:00:00.000Z",
        updated_at: "2026-04-23T01:00:00.000Z"
      })
    );

    expect(updated.content_hash).toBe("sha256:updated");
    expect(updated.updated_at).toBe("2026-04-23T01:00:00.000Z");
    expect(Array.from(updated.embedding).map((value) => Number(value.toFixed(6)))).toEqual([
      0.1,
      0.2,
      0.3
    ]);

    await expect(
      repo.listByObjectIds(workspaceId, [
        "22222222-2222-4222-8222-222222222222",
        "33333333-3333-4333-8333-333333333333",
        "11111111-1111-4111-8111-111111111111"
      ])
    ).resolves.toEqual([
      expect.objectContaining({
        object_id: "11111111-1111-4111-8111-111111111111",
        content_hash: "sha256:updated"
      }),
      expect.objectContaining({
        object_id: "22222222-2222-4222-8222-222222222222",
        content_hash: "sha256:second"
      })
    ]);
  });

  it("isolates listByWorkspace results by (provider_kind, model_id) so cross-provider rows never compete for the workspace scan cap", async () => {
    const { workspaceId, repo } = await createRepoContext();

    await repo.upsert(
      createEmbeddingRecord({
        object_id: "11111111-1111-4111-8111-111111111111",
        workspace_id: workspaceId,
        provider_kind: "openai",
        model_id: "text-embedding-3-small",
        embedding: new Float32Array([1, 0, 0])
      })
    );
    await repo.upsert(
      createEmbeddingRecord({
        object_id: "22222222-2222-4222-8222-222222222222",
        workspace_id: workspaceId,
        provider_kind: "local_onnx",
        model_id: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
        embedding: new Float32Array([0, 1, 0])
      })
    );

    const openaiRows = await repo.listByWorkspace(workspaceId, {
      providerKind: "openai",
      modelId: "text-embedding-3-small"
    });
    expect(openaiRows.map((row) => row.object_id)).toEqual([
      "11111111-1111-4111-8111-111111111111"
    ]);

    const localRows = await repo.listByWorkspace(workspaceId, {
      providerKind: "local_onnx",
      modelId: "Xenova/paraphrase-multilingual-MiniLM-L12-v2"
    });
    expect(localRows.map((row) => row.object_id)).toEqual([
      "22222222-2222-4222-8222-222222222222"
    ]);

    const wrongModelRows = await repo.listByWorkspace(workspaceId, {
      providerKind: "local_onnx",
      modelId: "some-other-model"
    });
    expect(wrongModelRows).toEqual([]);

    // No filter falls back to the original behavior: returns both rows.
    const unfiltered = await repo.listByWorkspace(workspaceId);
    expect(unfiltered.map((row) => row.object_id).sort()).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222"
    ]);
  });

  it("skips guarded upserts when the current memory content no longer matches the candidate hash", async () => {
    const { repo, memoryRepo, workspaceId } = await createRepoContext();
    const objectId = "11111111-1111-4111-8111-111111111111";

    await memoryRepo.update(objectId, {
      content: "Updated memory content after embedding generation.",
      updated_at: "2026-04-23T01:00:00.000Z"
    });

    await expect(
      repo.upsertIfContentHashMatchesCurrentMemory(
        createEmbeddingRecord({
          object_id: objectId,
          workspace_id: workspaceId,
          content_hash: "sha256:stale-hash",
          embedding: new Float32Array([0.4, 0.5, 0.6])
        })
      )
    ).resolves.toBeNull();
    await expect(repo.findByObjectId(objectId)).resolves.toBeNull();
  });
});

async function createRepoContext(): Promise<{
  readonly database: ReturnType<typeof initDatabase>;
  readonly workspaceId: string;
  readonly memoryRepo: SqliteMemoryEntryRepo;
  readonly repo: {
    upsert(record: MemoryEmbeddingRecord): Promise<Readonly<MemoryEmbeddingRecord>>;
    upsertIfContentHashMatchesCurrentMemory(
      record: MemoryEmbeddingRecord
    ): Promise<Readonly<MemoryEmbeddingRecord> | null>;
    findByObjectId(objectId: string): Promise<Readonly<MemoryEmbeddingRecord> | null>;
    listByWorkspace(
      workspaceId: string,
      options?: {
        readonly tierFilter?: readonly ("hot" | "warm" | "cold")[];
        readonly limit?: number;
        readonly providerKind?: string;
        readonly modelId?: string;
      }
    ): Promise<readonly Readonly<MemoryEmbeddingRecord>[]>;
    listByObjectIds(
      workspaceId: string,
      objectIds: readonly string[]
    ): Promise<readonly Readonly<MemoryEmbeddingRecord>[]>;
  };
}> {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);

  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const memoryRepo = new SqliteMemoryEntryRepo(database);
  const { SqliteMemoryEmbeddingRepo } = await import("../index.js");

  await workspaceRepo.create({
    workspace_id: "workspace-1",
    name: "Embedding Repo Workspace",
    root_path: "/tmp/embedding-repo-workspace",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    default_engine_class: "conversation_engine",
    workspace_state: WorkspaceState.ACTIVE
  });
  await runRepo.create({
    run_id: "run-1",
    workspace_id: "workspace-1",
    title: "Embedding Repo Run",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
  await memoryRepo.create(createMemoryEntry({ object_id: "11111111-1111-4111-8111-111111111111" }));
  await memoryRepo.create(createMemoryEntry({ object_id: "22222222-2222-4222-8222-222222222222" }));

  return {
    database,
    workspaceId: "workspace-1",
    memoryRepo,
    repo: new SqliteMemoryEmbeddingRepo(database)
  };
}

function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: overrides.object_id ?? "11111111-1111-4111-8111-111111111111",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-04-23T00:00:00.000Z",
    updated_at: "2026-04-23T00:00:00.000Z",
    created_by: "system",
    dimension: overrides.dimension ?? MemoryDimension.PROCEDURE,
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: overrides.scope_class ?? ScopeClass.PROJECT,
    content:
      overrides.content ??
      `Embedding source content for ${overrides.object_id ?? "11111111-1111-4111-8111-111111111111"}.`,
    domain_tags: [],
    evidence_refs: [],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: "hot",
    activation_score: 0.5,
    retention_score: null,
    manifestation_state: null,
    retention_state: null,
    decay_profile: null,
    confidence: null,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: null,
    contradiction_count: null,
    superseded_by: null,
    ...overrides
  };
}

function createEmbeddingRecord(
  overrides: Partial<MemoryEmbeddingRecord> & Pick<MemoryEmbeddingRecord, "object_id" | "workspace_id">
): MemoryEmbeddingRecord {
  return {
    object_id: overrides.object_id,
    workspace_id: overrides.workspace_id,
    content_hash: overrides.content_hash ?? `sha256:${overrides.object_id}`,
    provider_kind: overrides.provider_kind ?? "openai",
    model_id: overrides.model_id ?? "text-embedding-3-small",
    schema_version: overrides.schema_version ?? 1,
    dimensions: overrides.dimensions ?? overrides.embedding?.length ?? 3,
    embedding: overrides.embedding ?? new Float32Array([1, 0, 0]),
    created_at: overrides.created_at ?? "2026-04-23T00:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-04-23T00:00:00.000Z"
  };
}

function getColumnNames(database: ReturnType<typeof initDatabase>, tableName: string): string[] {
  return (database.connection
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as ReadonlyArray<{ readonly name: string }>).map((column) => column.name);
}
