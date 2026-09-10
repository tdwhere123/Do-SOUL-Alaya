import { afterEach, describe, expect, it } from "vitest";
import { readBoundedEmbeddingIds } from "../../../../repos/memory/reads/memory-embedding-bounded-read.js";
import { SqliteMemoryEmbeddingRepo } from "../../../../repos/memory/memory-embedding-repo.js";
import {
  createEmbeddingRecord,
  createMemoryEntry,
  createRepoContext,
  trackedDatabases
} from "../memory-embedding-repo-fixture.js";

afterEach(() => {
  for (const database of trackedDatabases) database.close();
  trackedDatabases.clear();
});

describe("readBoundedEmbeddingIds cursor", () => {
  it("keeps the one-shot id page and concatenates advancing pages", async () => {
    const { database, workspaceId, memoryRepo, repo } = await createRepoContext();
    repo.prepareBoundedRecallIndex();
    const seeded = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222"
    ];
    for (const objectId of seeded) {
      await repo.upsert(createEmbeddingRecord({ object_id: objectId, workspace_id: workspaceId }));
    }
    const ids = [...seeded, ...await plantExtraEmbeddings(memoryRepo, repo, workspaceId, 6)];
    const profile = {
      providerKind: "openai",
      modelId: "text-embedding-3-small",
      schemaVersion: 1,
      maxRows: 512,
      maxMetadataUtf8Bytes: 256
    };
    const full = readBoundedEmbeddingIds(database, workspaceId, profile);
    expect(full.objectIds).toEqual([...ids].sort());
    expect(full.truncated).toBe(false);
    const pages: string[] = [];
    let after: string | null = null;
    for (let step = 0; step < 16; step += 1) {
      const page = readBoundedEmbeddingIds(database, workspaceId, { ...profile, maxRows: 2 }, after);
      pages.push(...page.objectIds);
      if (!page.truncated) break;
      after = page.objectIds.at(-1) ?? after;
    }
    expect(pages).toEqual(full.objectIds);
  });

  it("reports a zero-row maxRows cap as truncated, not a completed empty domain", async () => {
    const { database, workspaceId, repo } = await createRepoContext();
    repo.prepareBoundedRecallIndex();
    await repo.upsert(createEmbeddingRecord({
      object_id: "11111111-1111-4111-8111-111111111111",
      workspace_id: workspaceId
    }));
    const interrupted = readBoundedEmbeddingIds(database, workspaceId, {
      providerKind: "openai",
      modelId: "text-embedding-3-small",
      schemaVersion: 1,
      maxRows: 0,
      maxMetadataUtf8Bytes: 256
    });
    expect(interrupted.objectIds).toEqual([]);
    expect(interrupted.truncated).toBe(true);
    const empty = readBoundedEmbeddingIds(database, workspaceId, {
      providerKind: "local_onnx",
      modelId: "missing-model",
      schemaVersion: 1,
      maxRows: 16,
      maxMetadataUtf8Bytes: 256
    });
    expect(empty.objectIds).toEqual([]);
    expect(empty.truncated).toBe(false);
  });
});

describe("readUniqueEmbeddingProfile", () => {
  it("fails closed on mixed profiles and resolves a pinned model without min object_id", async () => {
    const { database, workspaceId, repo } = await createRepoContext();
    repo.prepareBoundedRecallIndex();
    const firstId = "11111111-1111-4111-8111-111111111111";
    const laterId = "22222222-2222-4222-8222-222222222222";
    await repo.upsert(createEmbeddingRecord({
      object_id: firstId,
      workspace_id: workspaceId,
      provider_kind: "openai",
      model_id: "model-a-old"
    }));
    await repo.upsert(createEmbeddingRecord({
      object_id: laterId,
      workspace_id: workspaceId,
      provider_kind: "openai",
      model_id: "model-b-new"
    }));
    const mixed = repo.readUniqueRecallProfile(workspaceId);
    expect(mixed.status).toBe("unavailable");
    expect(mixed.profile).toBeUndefined();
    const pinnedB = repo.readUniqueRecallProfile(workspaceId, "model-b-new");
    expect(pinnedB.status).toBe("unique");
    expect(pinnedB.profile).toEqual({
      providerKind: "openai",
      modelId: "model-b-new",
      schemaVersion: 1
    });
    const pinnedA = repo.readUniqueRecallProfile(workspaceId, "model-a-old");
    expect(pinnedA.profile?.modelId).toBe("model-a-old");
    expect(pinnedA.profile?.modelId).not.toBe("model-b-new");
    const missing = repo.readUniqueRecallProfile(workspaceId, "model-absent");
    expect(missing.status).toBe("missing");
    const enumeratedB = readBoundedEmbeddingIds(database, workspaceId, {
      providerKind: pinnedB.profile!.providerKind,
      modelId: pinnedB.profile!.modelId,
      schemaVersion: pinnedB.profile!.schemaVersion,
      maxRows: 16,
      maxMetadataUtf8Bytes: 256
    });
    expect(enumeratedB.objectIds).toEqual([laterId]);
    expect(enumeratedB.objectIds).not.toContain(firstId);
  });

  it("treats a single stored profile as the domain without ranking object_id", async () => {
    const { workspaceId, repo } = await createRepoContext();
    repo.prepareBoundedRecallIndex();
    await repo.upsert(createEmbeddingRecord({
      object_id: "11111111-1111-4111-8111-111111111111",
      workspace_id: workspaceId
    }));
    await repo.upsert(createEmbeddingRecord({
      object_id: "22222222-2222-4222-8222-222222222222",
      workspace_id: workspaceId
    }));
    const unique = repo.readUniqueRecallProfile(workspaceId);
    expect(unique.status).toBe("unique");
    expect(unique.profile).toEqual({
      providerKind: "openai",
      modelId: "text-embedding-3-small",
      schemaVersion: 1
    });
  });
});

async function plantExtraEmbeddings(
  memoryRepo: Awaited<ReturnType<typeof createRepoContext>>["memoryRepo"],
  repo: SqliteMemoryEmbeddingRepo,
  workspaceId: string,
  count: number
): Promise<readonly string[]> {
  const ids = Array.from({ length: count }, (_, index) =>
    `aaaaaaaa-aaaa-4aaa-8aaa-${String(index + 3).padStart(12, "0")}`
  );
  for (const objectId of ids) {
    await memoryRepo.create(createMemoryEntry({ object_id: objectId, workspace_id: workspaceId }));
    await repo.upsert(createEmbeddingRecord({ object_id: objectId, workspace_id: workspaceId }));
  }
  return ids;
}
