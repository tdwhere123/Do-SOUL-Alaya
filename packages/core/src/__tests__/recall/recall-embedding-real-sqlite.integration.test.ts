import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryDimension } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { readBoundedEmbeddingIds } from "../../../../storage/src/repos/memory/reads/memory-embedding-bounded-read.js";
import { RecallService } from "../../recall/recall-service.js";
import { hashMemoryContent } from "../embedding-recall/embedding-recall-test-helpers.js";
import { createSourceBoundRecallFixture, createTaskSurface } from "./recall-service-test-fixtures.js";

const databases = new Set<StorageDatabase>();
afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});
const LEXICAL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000294";
const VECTOR_ID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000295";
const OTHER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000296";
const NOW = "2026-09-06T12:00:00.000Z";

async function createFixture(seedVectors: boolean) {
  const fixture = await createSourceBoundRecallFixture((database) => databases.add(database));
  await fixture.writeMemory(LEXICAL_ID, "kubernetes deployment checklist", MemoryDimension.FACT);
  await fixture.writeMemory(VECTOR_ID, "opaque archival payload", MemoryDimension.FACT);
  fixture.database.connection.prepare(`INSERT INTO workspaces(workspace_id,name,root_path,workspace_kind,created_at)
    VALUES ('workspace-other','foreign workspace','/tmp/foreign','local_repo',?)`).run(NOW);
  await fixture.writeSource({ objectId: OTHER_ID, workspaceId: "workspace-other", content: "foreign vector payload" });
  fixture.storage.memoryEmbeddingRepo.prepareBoundedRecallIndex();
  if (seedVectors) {
    for (const [objectId, workspaceId, content] of [
      [LEXICAL_ID, "workspace-1", "kubernetes deployment checklist"],
      [VECTOR_ID, "workspace-1", "opaque archival payload"],
      [OTHER_ID, "workspace-other", "foreign vector payload"]
    ]) {
      await fixture.storage.memoryEmbeddingRepo.upsert({
        object_id: objectId!, workspace_id: workspaceId!, content_hash: hashMemoryContent(content!),
        provider_kind: "openai", model_id: "stored-fixture", schema_version: 1,
        dimensions: 2, embedding: new Float32Array([1, 0]), created_at: NOW, updated_at: NOW
      });
    }
  }
  const embeddingIds = vi.fn((input: { workspaceId: string; afterObjectId: string | null; maxRows: number }) =>
    readBoundedEmbeddingIds(fixture.database, input.workspaceId, {
      providerKind: "openai", modelId: "stored-fixture", schemaVersion: 1,
      maxRows: input.maxRows, maxMetadataUtf8Bytes: 65536
    }, input.afterObjectId));
  const service = new RecallService({
    ...fixture.dependencies,
    observerReaders: { ...fixture.dependencies.observerReaders, embeddingIds }
  });
  return { ...fixture, service, embeddingIds };
}

async function recall(service: RecallService, workspaceId = "workspace-1") {
  return service.recall({
    workspaceId, taskSurface: { ...createTaskSurface(), display_name: "kubernetes" },
    queryText: "kubernetes", strategy: "chat", pageBudget: 800
  });
}

describe("conditional Recall with real SQLite stored embeddings", () => {
  it("enumerates persisted workspace vectors without promoting vector-only objects or calling a provider", async () => {
    const fixture = await createFixture(true);
    const before = fixture.database.connection.prepare("SELECT COUNT(*) AS count FROM garden_tasks").get();
    const result = await recall(fixture.service);
    expect(fixture.embeddingIds).toHaveBeenCalled();
    expect(result.provider_calls).toBe(0);
    const observedIds = fixture.embeddingIds.mock.results.flatMap((result) =>
      result.type === "return" ? result.value.objectIds : []);
    expect(observedIds).toContain(LEXICAL_ID);
    expect(observedIds).toContain(VECTOR_ID);
    expect(observedIds).not.toContain(OTHER_ID);
    expect(result.index.entries.some((entry) => entry.object_id === LEXICAL_ID)).toBe(true);
    expect(result.index.entries.some((entry) => entry.object_id === VECTOR_ID)).toBe(false);
    expect(result.candidates.some((candidate) => candidate.object_id === OTHER_ID)).toBe(false);
    expect(fixture.database.connection.prepare("SELECT COUNT(*) AS count FROM garden_tasks").get()).toEqual(before);
  });

  it("retains lexical source availability when no stored vectors or optional measurement capability exists", async () => {
    const fixture = await createFixture(false);
    const withEmptyStore = await recall(fixture.service);
    const withoutCapability = await recall(new RecallService(fixture.dependencies));
    expect(withEmptyStore.index.entries.map((entry) => entry.object_id))
      .toEqual(withoutCapability.index.entries.map((entry) => entry.object_id));
    expect(withEmptyStore.index.entries.some((entry) => entry.object_id === LEXICAL_ID)).toBe(true);
    expect(fixture.embeddingIds.mock.results.every((result) =>
      result.type === "return" && result.value.objectIds.length === 0)).toBe(true);
  });

  it("keeps stored-vector enumeration scoped and does not deliver revoked sources", async () => {
    const fixture = await createFixture(true);
    const foreign = fixture.embeddingIds({ workspaceId: "workspace-other", afterObjectId: null, maxRows: 10 });
    expect(foreign.objectIds).toEqual([OTHER_ID]);
    const missing = fixture.embeddingIds({ workspaceId: "workspace-absent", afterObjectId: null, maxRows: 10 });
    expect(missing.objectIds).toEqual([]);
    fixture.database.connection.prepare("UPDATE memory_entries SET lifecycle_state='tombstone' WHERE object_id=?")
      .run(LEXICAL_ID);
    const result = await recall(fixture.service);
    expect(result.index.entries.some((entry) => entry.object_id === LEXICAL_ID)).toBe(false);
  });
});
