import { afterEach, describe, expect, it } from "vitest";
import type { MemoryObjectKey } from "@do-soul/alaya-protocol";
import { SqliteMemoryObjectKeyRepo } from "../../../repos/memory-entry/object-key-repo.js";
import {
  createMemoryEntry,
  createRepo,
  trackedDatabases
} from "./memory-entry-repo-fixture.js";

afterEach(() => {
  for (const database of trackedDatabases) {
    database.close();
  }
  trackedDatabases.clear();
});

describe("SqliteMemoryObjectKeyRepo", () => {
  it("replaces owner keys and keeps them FTS-addressable apart from content", async () => {
    const { database, repo } = await createRepo();
    const memory = await repo.create(createMemoryEntry({
      object_id: "11111111-1111-4111-8111-111111111111",
      content: "I took my niece to the museum."
    }));
    const keys = new SqliteMemoryObjectKeyRepo(database);
    const key = objectKey({
      owner_id: memory.object_id,
      key_id: "gist-retriever",
      key_type: "gist_remainder",
      surface: "Golden Retriever",
      source_ref: "evidence:capsule-1:gist:0:16"
    });

    keys.replaceOwnerKeys(memory.workspace_id, memory.object_id, [key]);

    expect(keys.listByOwner(memory.workspace_id, memory.object_id)).toEqual([key]);
    expect(keys.summarize()).toEqual({ object_count: 1, key_count: 1 });
    expect(database.connection.prepare(`
      SELECT owner_id FROM memory_object_key_fts
      WHERE memory_object_key_fts MATCH ?
    `).all('content:"Retriever"')).toEqual([{ owner_id: memory.object_id }]);
    const hits = await repo.searchByKeyword(memory.workspace_id, "Retriever", 5);
    expect(hits.map((hit) => hit.object_id)).toEqual([memory.object_id]);
    expect(hits[0]?.object_key_rank).toBeGreaterThan(0);
  });
});

function objectKey(
  overrides: Pick<MemoryObjectKey, "owner_id" | "key_id" | "key_type" | "surface" | "source_ref">
): MemoryObjectKey {
  return {
    schema_version: 1,
    workspace_id: "workspace-1",
    language: "en",
    source_kind: "evidence_gist",
    normalized_surface: overrides.surface.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase(),
    ...overrides
  };
}
