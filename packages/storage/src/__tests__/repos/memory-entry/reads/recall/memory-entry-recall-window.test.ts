import { afterEach, describe, expect, it } from "vitest";
import { StorageTier } from "@do-soul/alaya-protocol";
import {
  createMemoryEntry,
  createRepo,
  trackedDatabases
} from "../../memory-entry-repo-fixture.js";
import { prepareRecallEventTimeWindowStatements } from "../../../../../repos/memory-entry/statements/recall/event-time-window-statements.js";

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

describe("SqliteMemoryEntryRepo event-time window", () => {
  it("returns only active same-workspace and same-tier overlapping intervals", async () => {
    const { repo } = await createRepo();
    await Promise.all([
      repo.create(createMemoryEntry({
        object_id: "10000001-1111-4111-8111-111111111111",
        event_time_start: "2026-03-10T00:00:00.000Z",
        event_time_end: "2026-03-12T00:00:00.000Z"
      })),
      repo.create(createMemoryEntry({
        object_id: "10000002-1111-4111-8111-111111111111",
        event_time_start: "2026-03-11T12:00:00.000Z",
        event_time_end: null
      })),
      repo.create(createMemoryEntry({
        object_id: "10000003-1111-4111-8111-111111111111",
        event_time_start: "2026-03-14T00:00:00.000Z"
      })),
      repo.create(createMemoryEntry({
        object_id: "10000004-1111-4111-8111-111111111111",
        event_time_start: "2026-03-11T00:00:00.000Z",
        storage_tier: StorageTier.WARM
      })),
      repo.create(createMemoryEntry({
        object_id: "10000005-1111-4111-8111-111111111111",
        event_time_start: "2026-03-11T00:00:00.000Z",
        lifecycle_state: "dormant"
      })),
      repo.create(createMemoryEntry({
        object_id: "10000006-1111-4111-8111-111111111111",
        workspace_id: "workspace-2",
        run_id: "run-3",
        event_time_start: "2026-03-11T00:00:00.000Z"
      })),
      repo.create(createMemoryEntry({
        object_id: "10000007-1111-4111-8111-111111111111",
        event_time_start: "2026-03-12T00:00:00.000Z",
        event_time_end: "2026-03-10T00:00:00.000Z"
      }))
    ]);

    const result = await repo.findByEventTimeWindow({
      workspaceId: "workspace-1",
      tier: StorageTier.HOT,
      startTime: "2026-03-11T00:00:00.000Z",
      endTime: "2026-03-12T23:59:59.999Z",
      limit: 10
    });

    expect(result.map((entry) => entry.object_id)).toEqual([
      "10000001-1111-4111-8111-111111111111",
      "10000002-1111-4111-8111-111111111111",
      "10000007-1111-4111-8111-111111111111"
    ]);
  });

  it("uses activation then stable identity order and enforces the limit", async () => {
    const { repo } = await createRepo();
    await Promise.all([
      repo.create(createMemoryEntry({
        object_id: "20000001-1111-4111-8111-111111111111",
        activation_score: 0.2,
        event_time_start: "2026-03-11T00:00:00.000Z"
      })),
      repo.create(createMemoryEntry({
        object_id: "20000002-1111-4111-8111-111111111111",
        activation_score: 0.9,
        event_time_start: "2026-03-11T00:00:00.000Z"
      }))
    ]);

    const result = await repo.findByEventTimeWindow({
      workspaceId: "workspace-1",
      tier: StorageTier.HOT,
      startTime: "2026-03-10T00:00:00.000Z",
      endTime: "2026-03-12T00:00:00.000Z",
      limit: 1
    });

    expect(result.map((entry) => entry.object_id)).toEqual([
      "20000002-1111-4111-8111-111111111111"
    ]);
  });

  it("uses semantic identity before replay-local IDs at the temporal limit", async () => {
    const { repo } = await createRepo();
    await Promise.all([
      repo.create(createMemoryEntry({
        object_id: "f0000001-1111-4111-8111-111111111111",
        content: "Alpha temporal recall fixture.",
        activation_score: 0.9,
        created_at: "2026-03-11T00:00:00.000Z",
        event_time_start: "2026-03-11T00:00:00.000Z"
      })),
      repo.create(createMemoryEntry({
        object_id: "00000001-1111-4111-8111-111111111111",
        content: "Zebra temporal recall fixture.",
        activation_score: 0.9,
        created_at: "2026-03-11T00:00:00.000Z",
        event_time_start: "2026-03-11T00:00:00.000Z"
      }))
    ]);

    const result = await repo.findByEventTimeWindow({
      workspaceId: "workspace-1",
      tier: StorageTier.HOT,
      startTime: "2026-03-10T00:00:00.000Z",
      endTime: "2026-03-12T00:00:00.000Z",
      limit: 1
    });

    expect(result.map((entry) => entry.content)).toEqual([
      "Alpha temporal recall fixture."
    ]);
  });

  it("normalizes drift-sensitive activation scores before the temporal limit", async () => {
    const { repo } = await createRepo();
    await Promise.all([
      repo.create(createMemoryEntry({
        object_id: "f0000001-1111-4111-8111-111111111111",
        content: "Alpha drift-stable temporal recall fixture.",
        activation_score: 0.9324999963147926,
        event_time_start: "2026-03-11T00:00:00.000Z"
      })),
      repo.create(createMemoryEntry({
        object_id: "00000001-1111-4111-8111-111111111111",
        content: "Zebra drift-stable temporal recall fixture.",
        activation_score: 0.9324999985083684,
        event_time_start: "2026-03-11T00:00:00.000Z"
      }))
    ]);

    const result = await repo.findByEventTimeWindow({
      workspaceId: "workspace-1",
      tier: StorageTier.HOT,
      startTime: "2026-03-10T00:00:00.000Z",
      endTime: "2026-03-12T00:00:00.000Z",
      limit: 1
    });

    expect(result.map((entry) => entry.content)).toEqual([
      "Alpha drift-stable temporal recall fixture."
    ]);
  });

  it.each([
    [
      "no fractional seconds",
      "2026-03-11T00:00:00Z",
      "2026-03-11T00:00:00Z",
      "2026-03-11T00:00:00.150Z"
    ],
    [
      "one fractional digit",
      "2026-03-11T00:00:00.1Z",
      "2026-03-11T00:00:00Z",
      "2026-03-11T00:00:00.150Z"
    ],
    [
      "three fractional digits",
      "2026-03-11T00:00:00.100Z",
      "2026-03-11T00:00:00Z",
      "2026-03-11T00:00:00.150Z"
    ],
    [
      "timezone offset",
      "2026-03-11T00:00:00.100Z",
      "2026-03-11T02:00:00+02:00",
      "2026-03-11T02:00:00.150+02:00"
    ]
  ])("normalizes %s with SQLite time semantics", async (
    _label,
    eventTime,
    startTime,
    endTime
  ) => {
    const { repo } = await createRepo();
    await repo.create(createMemoryEntry({
      object_id: "30000001-1111-4111-8111-111111111111",
      event_time_start: eventTime
    }));

    const result = await repo.findByEventTimeWindow({
      workspaceId: "workspace-1",
      tier: StorageTier.HOT,
      startTime,
      endTime,
      limit: 10
    });

    expect(result.map((entry) => entry.object_id)).toEqual([
      "30000001-1111-4111-8111-111111111111"
    ]);
  });

  it("rejects limits above the shared temporal candidate bound", async () => {
    const { repo } = await createRepo();
    await expect(repo.findByEventTimeWindow({
      workspaceId: "workspace-1",
      tier: StorageTier.HOT,
      startTime: "2026-03-11T00:00:00Z",
      endTime: "2026-03-12T00:00:00Z",
      limit: 501
    })).rejects.toThrow(/limit/);
  });

  it("uses the active event-time expression index", async () => {
    const { database } = await createRepo();
    const statement = prepareRecallEventTimeWindowStatements(database)
      .findByEventTimeWindowStatement as unknown as { readonly source: string };
    const plan = database.connection
      .prepare(`EXPLAIN QUERY PLAN ${statement.source}`)
      .all(
        "workspace-1",
        StorageTier.HOT,
        "2026-03-12T00:00:00.000Z",
        "2026-03-11T00:00:00.000Z",
        10
      ) as ReadonlyArray<{ readonly detail: string }>;
    const details = plan.map((step) => step.detail).join(" | ");

    expect(
      plan.some((step) =>
        step.detail.includes("USING INDEX idx_memory_entries_event_time_recall_active")
      ),
      `expected event-time expression index, got: ${details}`
    ).toBe(true);
    expect(
      plan.some((step) => step.detail.startsWith("SCAN memory_entries")),
      `expected no memory_entries scan, got: ${details}`
    ).toBe(false);
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
