import { afterEach, describe, expect, it } from "vitest";
import {
  createEmbeddingRecord,
  createRepoContext,
  trackedDatabases
} from "./memory-embedding-repo-fixture.js";

afterEach(() => {
  for (const database of trackedDatabases) database.close();
  trackedDatabases.clear();
});

describe("Memory embedding vector validity", () => {
  it("hides invalid vectors from embedding consumers but exposes them to backfill metadata", async () => {
    const { database, workspaceId, repo } = await createRepoContext();
    const objectId = "11111111-1111-4111-8111-111111111111";
    const validObjectId = "22222222-2222-4222-8222-222222222222";
    database.connection.prepare(`
      INSERT INTO memory_embeddings (
        object_id, workspace_id, content_hash, provider_kind, model_id,
        schema_version, dimensions, embedding_blob, vector_valid, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      objectId,
      workspaceId,
      "sha256:invalid",
      "local_onnx",
      "test-model",
      1,
      2,
      Buffer.from(new Float32Array([0, 0]).buffer),
      "2026-03-22T00:00:00.000Z",
      "2026-03-22T00:00:00.000Z"
    );
    await repo.upsert(createEmbeddingRecord({
      object_id: validObjectId,
      workspace_id: workspaceId,
      provider_kind: "local_onnx",
      model_id: "test-model",
      schema_version: 1,
      embedding: new Float32Array([0.25, 0.5]),
      dimensions: 2
    }));

    await expect(repo.findByObjectId(objectId)).resolves.toBeNull();
    await expect(repo.findByObjectId(validObjectId)).resolves.toMatchObject({
      object_id: validObjectId
    });
    await expect(repo.listByWorkspace(workspaceId)).resolves.toEqual([
      expect.objectContaining({ object_id: validObjectId })
    ]);
    await expect(repo.listByWorkspace(workspaceId, {
      providerKind: "local_onnx",
      modelId: "test-model",
      schemaVersion: 1
    })).resolves.toEqual([
      expect.objectContaining({ object_id: validObjectId })
    ]);
    await expect(repo.listByObjectIds(
      workspaceId, [objectId, validObjectId]
    )).resolves.toEqual([
      expect.objectContaining({ object_id: validObjectId })
    ]);
    await expect(repo.findMetadataByObjectIds(
      [objectId, validObjectId]
    )).resolves.toEqual([
      expect.objectContaining({ object_id: objectId, vector_valid: false }),
      expect.objectContaining({ object_id: validObjectId, vector_valid: true })
    ]);
  });
});
