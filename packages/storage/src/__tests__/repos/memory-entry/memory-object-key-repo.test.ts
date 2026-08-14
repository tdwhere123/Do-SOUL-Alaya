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

const EXACT_KEY_SCAN_BATCH_SIZE = 200;
const STRADDLE_HEAD_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STRADDLE_TAIL_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FAT_OWNER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CJK_SURFACE = "2月";

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

  it("scans every exact-key row when an owner straddles a batch and another exceeds the batch", async () => {
    const { database, repo } = await createRepo();
    const objectKeys = new SqliteMemoryObjectKeyRepo(database);

    await repo.create(createMemoryEntry({
      object_id: STRADDLE_HEAD_ID,
      content: "Museum visit notes without a calendar fragment."
    }));
    await repo.create(createMemoryEntry({
      object_id: STRADDLE_TAIL_ID,
      run_id: "run-1",
      content: "Second visitor log without a calendar fragment."
    }));
    await repo.create(createMemoryEntry({
      object_id: FAT_OWNER_ID,
      run_id: "run-1",
      content: "Long transcript without a calendar fragment."
    }));

    objectKeys.replaceOwnerKeys("workspace-1", STRADDLE_HEAD_ID, fillerKeys(STRADDLE_HEAD_ID, 180));
    objectKeys.replaceOwnerKeys("workspace-1", STRADDLE_TAIL_ID, [
      ...fillerKeys(STRADDLE_TAIL_ID, 20),
      ...cjkKeys(STRADDLE_TAIL_ID, 21, 50)
    ]);
    objectKeys.replaceOwnerKeys("workspace-1", FAT_OWNER_ID, [
      ...fillerKeys(FAT_OWNER_ID, EXACT_KEY_SCAN_BATCH_SIZE),
      ...cjkKeys(FAT_OWNER_ID, EXACT_KEY_SCAN_BATCH_SIZE + 1, 247)
    ]);

    const hits = await repo.searchByKeyword("workspace-1", CJK_SURFACE, 5);
    expect(hits.map((hit) => hit.object_id).sort()).toEqual(
      [FAT_OWNER_ID, STRADDLE_TAIL_ID].sort()
    );
  });
});

function objectKey(
  overrides: Pick<MemoryObjectKey, "owner_id" | "key_id" | "key_type" | "surface" | "source_ref"> &
    Partial<Pick<MemoryObjectKey, "language">>
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

function fillerKeys(ownerId: string, count: number): readonly MemoryObjectKey[] {
  return Array.from({ length: count }, (_, index) => objectKey({
    owner_id: ownerId,
    key_id: paddedKeyId(index + 1),
    key_type: "gist_remainder",
    surface: `filler-${index + 1}`,
    source_ref: `evidence:capsule-1:gist:${index}:${index + 1}`
  }));
}

function cjkKeys(ownerId: string, from: number, to: number): readonly MemoryObjectKey[] {
  return Array.from({ length: to - from + 1 }, (_, offset) => {
    const index = from + offset;
    return objectKey({
      owner_id: ownerId,
      key_id: paddedKeyId(index),
      key_type: "gist_remainder",
      surface: CJK_SURFACE,
      language: "zh",
      source_ref: `evidence:capsule-1:gist:cjk:${index}`
    });
  });
}

function paddedKeyId(index: number): string {
  return `k-${String(index).padStart(4, "0")}`;
}
