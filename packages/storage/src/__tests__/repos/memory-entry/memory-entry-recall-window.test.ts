import { afterEach, describe, expect, it } from "vitest";
import { StorageTier } from "@do-soul/alaya-protocol";
import {
  createMemoryEntry,
  createRepo,
  trackedDatabases
} from "./memory-entry-repo-fixture.js";

afterEach(() => {
  for (const database of trackedDatabases) database.close();
  trackedDatabases.clear();
});

describe("SqliteMemoryEntryRepo recall tier window", () => {
  it.each([0, 499, 500])("returns %i rows without a continuation", async (rowCount) => {
    const { repo } = await createRepo();
    await seedRows(repo, rowCount);

    const result = await repo.findRecallTierWindow!({
      workspaceId: "workspace-1",
      tier: StorageTier.HOT,
      limit: 500
    });

    expect(result.memories).toHaveLength(rowCount);
    expect(result.next_cursor).toBeNull();
    expect(result.truncated).toBe(false);
  }, 30_000);

  it("returns a stable created-at/object-id cursor at cap plus one", async () => {
    const { repo } = await createRepo();
    await seedRows(repo, 501, { sameCreatedAt: true });

    const first = await repo.findRecallTierWindow!({
      workspaceId: "workspace-1",
      tier: StorageTier.HOT,
      limit: 500
    });
    const second = await repo.findRecallTierWindow!({
      workspaceId: "workspace-1",
      tier: StorageTier.HOT,
      limit: 500,
      cursor: first.next_cursor ?? undefined
    });

    expect(first.memories).toHaveLength(500);
    expect(first.truncated).toBe(true);
    expect(first.next_cursor).toEqual({
      created_at: "2026-03-21T00:00:00.000Z",
      object_id: "00000500-1111-4111-8111-111111111111"
    });
    expect(second.memories.map((entry) => entry.object_id)).toEqual([
      "00000501-1111-4111-8111-111111111111"
    ]);
    expect(second.next_cursor).toBeNull();
  }, 30_000);

  it("consumes every row across multiple window pages", async () => {
    const { repo } = await createRepo();
    await seedRows(repo, 1_250);

    const memories = [];
    let cursor: { readonly created_at: string; readonly object_id: string } | undefined;
    let pages = 0;
    for (;;) {
      const page = await repo.findRecallTierWindow!({
        workspaceId: "workspace-1",
        tier: StorageTier.HOT,
        limit: 500,
        ...(cursor === undefined ? {} : { cursor })
      });
      pages += 1;
      memories.push(...page.memories);
      if (!page.truncated) break;
      expect(page.next_cursor).not.toBeNull();
      cursor = page.next_cursor ?? undefined;
    }

    expect(pages).toBe(3);
    expect(memories).toHaveLength(1_250);
    expect(memories.map((entry) => entry.object_id)).toEqual(
      Array.from({ length: 1_250 }, (_, index) =>
        `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`
      )
    );
  }, 30_000);

  it("preserves tier and lifecycle filtering plus chronological ordering", async () => {
    const { repo } = await createRepo();
    await repo.create(createMemoryEntry({
      object_id: "00000001-1111-4111-8111-111111111111",
      created_at: "2026-03-20T00:00:00.000Z",
      storage_tier: StorageTier.HOT
    }));
    await repo.create(createMemoryEntry({
      object_id: "00000002-1111-4111-8111-111111111111",
      created_at: "2026-03-22T00:00:00.000Z",
      storage_tier: StorageTier.HOT,
      lifecycle_state: "archived"
    }));
    await repo.create(createMemoryEntry({
      object_id: "00000003-1111-4111-8111-111111111111",
      storage_tier: StorageTier.WARM
    }));
    await repo.create(createMemoryEntry({
      object_id: "00000004-1111-4111-8111-111111111111",
      storage_tier: StorageTier.HOT,
      lifecycle_state: "dormant"
    }));
    await repo.create(createMemoryEntry({
      object_id: "00000005-1111-4111-8111-111111111111",
      storage_tier: StorageTier.HOT,
      retention_state: "tombstoned"
    }));

    const result = await repo.findRecallTierWindow!({
      workspaceId: "workspace-1",
      tier: StorageTier.HOT,
      limit: 10
    });

    expect(result.memories.map((entry) => entry.object_id)).toEqual([
      "00000001-1111-4111-8111-111111111111",
      "00000002-1111-4111-8111-111111111111"
    ]);
  });
});

async function seedRows(
  repo: Awaited<ReturnType<typeof createRepo>>["repo"],
  count: number,
  options: { readonly sameCreatedAt?: boolean } = {}
): Promise<void> {
  for (let index = 1; index <= count; index += 1) {
    await repo.create(createMemoryEntry({
      object_id: `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
      created_at: options.sameCreatedAt === true
        ? "2026-03-21T00:00:00.000Z"
        : new Date(Date.UTC(2026, 2, 21, 0, 0, index)).toISOString()
    }));
  }
}
