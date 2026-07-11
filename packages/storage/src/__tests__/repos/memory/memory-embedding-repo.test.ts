import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { StorageDatabase, initDatabase } from "../../../sqlite/db.js";
import { SqliteMemoryEmbeddingRepo } from "../../../repos/memory/memory-embedding-repo.js";
import {
  createEmbeddingRecord,
  createMemoryEntry,
  createRepoContext,
  getColumnNames,
  seedWorkspaceFixture,
  trackedDatabases
} from "./memory-embedding-repo-fixture.js";

const databases = trackedDatabases;

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("Memory embedding storage repo", () => {
  it("applies migration 052, exports the repo, and persists embeddings keyed by memory object id", async () => {
    const storage = (await import("../../../index.js")) as Record<string, unknown>;
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
      new URL("../../../migrations/052-memory-embeddings.sql", import.meta.url),
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

  it("pushes the schema_version filter into listByWorkspace so cross-schema rows are dropped at the SQL layer", async () => {
    const { workspaceId, repo } = await createRepoContext();

    await repo.upsert(
      createEmbeddingRecord({
        object_id: "11111111-1111-4111-8111-111111111111",
        workspace_id: workspaceId,
        schema_version: 1,
        embedding: new Float32Array([1, 0, 0])
      })
    );
    await repo.upsert(
      createEmbeddingRecord({
        object_id: "22222222-2222-4222-8222-222222222222",
        workspace_id: workspaceId,
        schema_version: 2,
        embedding: new Float32Array([0, 1, 0])
      })
    );

    const schemaOneRows = await repo.listByWorkspace(workspaceId, { schemaVersion: 1 });
    expect(schemaOneRows.map((row) => row.object_id)).toEqual([
      "11111111-1111-4111-8111-111111111111"
    ]);

    const schemaTwoRows = await repo.listByWorkspace(workspaceId, { schemaVersion: 2 });
    expect(schemaTwoRows.map((row) => row.object_id)).toEqual([
      "22222222-2222-4222-8222-222222222222"
    ]);

    const unfiltered = await repo.listByWorkspace(workspaceId);
    expect(unfiltered.map((row) => row.object_id).sort()).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222"
    ]);
  });

  it("drops dormant and tombstoned backing memories from filtered workspace scans", async () => {
    const { workspaceId, repo, memoryRepo } = await createRepoContext();
    const activeId = "11111111-1111-4111-8111-111111111111";
    const dormantId = "33333333-3333-4333-8333-333333333333";
    const tombstonedId = "44444444-4444-4444-8444-444444444444";

    await memoryRepo.create(createMemoryEntry({
      object_id: dormantId,
      lifecycle_state: "dormant"
    }));
    await memoryRepo.create(createMemoryEntry({
      object_id: tombstonedId,
      lifecycle_state: "tombstone",
      retention_state: "tombstoned"
    }));
    for (const objectId of [activeId, dormantId, tombstonedId]) {
      await repo.upsert(
        createEmbeddingRecord({
          object_id: objectId,
          workspace_id: workspaceId,
          embedding: new Float32Array([1, 0, 0])
        })
      );
    }

    const filtered = await repo.listByWorkspace(workspaceId, {
      tierFilter: ["hot"],
      providerKind: "openai",
      modelId: "text-embedding-3-small",
      schemaVersion: 1
    });
    expect(filtered.map((row) => row.object_id)).toEqual([activeId]);

    const unfiltered = await repo.listByWorkspace(workspaceId);
    expect(unfiltered.map((row) => row.object_id).sort()).toEqual([
      activeId,
      dormantId,
      tombstonedId
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

  it("soft-misses guarded upserts when current memory content is empty", async () => {
    const { database, repo, workspaceId } = await createRepoContext();
    const objectId = "11111111-1111-4111-8111-111111111111";

    database.connection
      .prepare("UPDATE memory_entries SET content = ? WHERE object_id = ?")
      .run("", objectId);

    await expect(
      repo.upsertIfContentHashMatchesCurrentMemory(
        createEmbeddingRecord({
          object_id: objectId,
          workspace_id: workspaceId,
          content_hash: "sha256:any-hash",
          embedding: new Float32Array([0.4, 0.5, 0.6])
        })
      )
    ).resolves.toBeNull();
    await expect(repo.findByObjectId(objectId)).resolves.toBeNull();
  });

  it("returns metadata for requested object ids without the embedding vector", async () => {
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

    const metadata = await repo.findMetadataByObjectIds([
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
      "11111111-1111-4111-8111-111111111111"
    ]);

    expect(metadata).toEqual([
      expect.objectContaining({
        object_id: "11111111-1111-4111-8111-111111111111",
        content_hash: "sha256:first",
        provider_kind: "openai",
        model_id: "text-embedding-3-small",
        schema_version: 1,
        dimensions: 3
      }),
      expect.objectContaining({
        object_id: "22222222-2222-4222-8222-222222222222",
        content_hash: "sha256:second"
      })
    ]);
    // The metadata projection never carries the embedding vector.
    for (const record of metadata) {
      expect(record).not.toHaveProperty("embedding");
    }
    expect(await repo.findMetadataByObjectIds([])).toEqual([]);
  });

  it("chunks large metadata lookups below SQLite's bind-parameter ceiling", async () => {
    const { workspaceId, repo } = await createRepoContext();
    const existingIds = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222"
    ];

    for (const objectId of existingIds) {
      await repo.upsert(
        createEmbeddingRecord({
          object_id: objectId,
          workspace_id: workspaceId,
          content_hash: `sha256:${objectId}`
        })
      );
    }

    const oversizedLookup = Array.from(
      { length: 32_767 },
      (_, index) => `missing-${String(index).padStart(5, "0")}`
    );
    oversizedLookup[17] = existingIds[1]!;
    oversizedLookup[5_001] = existingIds[0]!;
    oversizedLookup[20_000] = existingIds[1]!;
    oversizedLookup[20_001] = existingIds[0]!;

    const metadata = await repo.findMetadataByObjectIds(oversizedLookup);
    const hydrated = await repo.listByObjectIds(workspaceId, oversizedLookup);

    expect(metadata.map((record) => record.object_id)).toEqual([...existingIds].sort());
    expect(hydrated.map((record) => record.object_id)).toEqual([...existingIds].sort());
    for (const record of metadata) {
      expect(record).not.toHaveProperty("embedding");
    }
  });

  it("hydrates object ids on a connection that never created the legacy filter temp table", async () => {
    const dbDirectory = mkdtempSync(join(tmpdir(), "alaya-embedding-repo-"));
    const dbPath = join(dbDirectory, "alaya.db");
    const objectId = "11111111-1111-4111-8111-111111111111";
    const writerDatabase = initDatabase({ filename: dbPath });
    const reader = new BetterSqlite3(dbPath);

    try {
      seedWorkspaceFixture(writerDatabase);
      await new SqliteMemoryEmbeddingRepo(writerDatabase).upsert(
        createEmbeddingRecord({
          object_id: objectId,
          workspace_id: "workspace-1",
          embedding: new Float32Array([0.1, 0.2, 0.3])
        })
      );

      // Second connection to the same file never ran the legacy temp-table DDL:
      // listByObjectIds must not depend on per-connection temp state.
      const readerRepo = new SqliteMemoryEmbeddingRepo(new StorageDatabase(`${dbPath}#reader`, reader));
      const hydrated = await readerRepo.listByObjectIds("workspace-1", [objectId]);

      expect(hydrated.map((record) => record.object_id)).toEqual([objectId]);
      expect(Array.from(hydrated[0]!.embedding).map((value) => Number(value.toFixed(6)))).toEqual([
        0.1, 0.2, 0.3
      ]);
    } finally {
      reader.close();
      writerDatabase.close();
      rmSync(dbDirectory, { recursive: true, force: true });
    }
  });

  it("rejects corrupt memory embedding rows on read", async () => {
    const { database, workspaceId, repo } = await createRepoContext();
    const objectId = "11111111-1111-4111-8111-111111111111";

    createMemoryEntry(database, workspaceId, objectId);
    database.connection
      .prepare(
        `
        INSERT INTO memory_embeddings (
          object_id, workspace_id, content_hash, provider_kind, model_id,
          schema_version, dimensions, embedding_blob, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        objectId,
        workspaceId,
        "sha256:bad",
        "openai",
        "text-embedding-3-small",
        0,
        2,
        Buffer.from(new Float32Array([0.1, 0.2]).buffer),
        "2026-03-22T00:00:00.000Z",
        "2026-03-22T00:00:00.000Z"
      );

    await expect(repo.findByObjectId(objectId)).rejects.toMatchObject({
      code: "VALIDATION_FAILED"
    });
  });
});
