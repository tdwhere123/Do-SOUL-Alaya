import { afterEach, describe, expect, it } from "vitest";
import type { MemoryHqRepo } from "../../../repos/memory/memory-hq-repo.js";
import {
  createEmbeddingRecord,
  createRepoContext,
  getColumnNames,
  trackedDatabases
} from "./memory-embedding-repo-fixture.js";

const databases = trackedDatabases;
const MEM_A = "11111111-1111-4111-8111-111111111111";
const MEM_B = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-04-23T00:00:00.000Z";

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

async function createHqRepo(database: Parameters<typeof getColumnNames>[0]): Promise<MemoryHqRepo> {
  const storage = (await import("../../../index.js")) as Record<string, unknown>;
  expect(storage.SqliteMemoryHqRepo).toBeTypeOf("function");
  const Ctor = storage.SqliteMemoryHqRepo as new (db: typeof database) => MemoryHqRepo;
  return new Ctor(database);
}

describe("Memory HQ storage repo", () => {
  it("applies migration 097 with the expected columns", async () => {
    const { database } = await createRepoContext();

    const versions = database.connection
      .prepare("SELECT version FROM schema_version WHERE version = 97")
      .all() as ReadonlyArray<{ readonly version: number }>;

    expect(versions.map((entry) => entry.version)).toEqual([97]);
    expect(getColumnNames(database, "memory_hq")).toEqual([
      "object_id",
      "workspace_id",
      "hqs_json",
      "created_at",
      "updated_at"
    ]);
  });

  it("round-trips HQs by object id and omits ids without rows", async () => {
    const { database, workspaceId } = await createRepoContext();
    const repo = await createHqRepo(database);

    await repo.upsert({
      object_id: MEM_A,
      workspace_id: workspaceId,
      hqs: ["What workflow is pinned?", "Which repository?"],
      created_at: NOW,
      updated_at: NOW
    });

    const map = await repo.getHqByObjectIds([MEM_A, MEM_B]);
    expect(map.get(MEM_A)).toEqual(["What workflow is pinned?", "Which repository?"]);
    expect(map.has(MEM_B)).toBe(false);
  });

  it("replaces HQs on object_id conflict", async () => {
    const { database, workspaceId } = await createRepoContext();
    const repo = await createHqRepo(database);

    await repo.upsert({ object_id: MEM_A, workspace_id: workspaceId, hqs: ["old"], created_at: NOW, updated_at: NOW });
    await repo.upsert({ object_id: MEM_A, workspace_id: workspaceId, hqs: ["new one", "new two"], created_at: NOW, updated_at: NOW });

    const map = await repo.getHqByObjectIds([MEM_A]);
    expect(map.get(MEM_A)).toEqual(["new one", "new two"]);
  });

  it("isolates cosine spaces: schema_version filter never mixes d2q and non-d2q vectors", async () => {
    const { workspaceId, repo: embeddingRepo } = await createRepoContext();

    await embeddingRepo.upsert(
      createEmbeddingRecord({ object_id: MEM_A, workspace_id: workspaceId, schema_version: 1 })
    );
    await embeddingRepo.upsert(
      createEmbeddingRecord({ object_id: MEM_B, workspace_id: workspaceId, schema_version: 2 })
    );

    const d2q = await embeddingRepo.listByWorkspace(workspaceId, { schemaVersion: 2 });
    const nonD2q = await embeddingRepo.listByWorkspace(workspaceId, { schemaVersion: 1 });

    expect(d2q.map((record) => record.object_id)).toEqual([MEM_B]);
    expect(nonD2q.map((record) => record.object_id)).toEqual([MEM_A]);
  });
});
