import { afterEach, describe, expect, it } from "vitest";
import {
  MemoryDimension,
  ScopeClass,
  StorageTier
} from "@do-soul/alaya-protocol";
import { SqliteEnrichPendingRepo } from "../../../repos/garden/enrich-pending-repo.js";
import { SqliteEventLogRepo } from "../../../repos/runtime/event-log-repo.js";
import { prepareMemoryEntryStatements } from "../../../repos/memory-entry/sqlite-memory-entry-statements.js";
import {
  createMemoryCreatedEventInput,
  createMemoryEntry,
  createRepo,
  trackedDatabases
} from "./memory-entry-repo-fixture.js";

const databases = trackedDatabases;

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("SqliteMemoryEntryRepo", () => {
  it("creates and loads a memory entry by id", async () => {
    const { repo } = await createRepo();
    const entry = createMemoryEntry();

    await expect(repo.create(entry)).resolves.toEqual(entry);
    await expect(repo.findById(entry.object_id)).resolves.toEqual(entry);
  });

  it("createWithinTransaction commits EventLog-first, row, and co-write atomically", async () => {
    const { repo, database } = await createRepo();
    const enrichRepo = new SqliteEnrichPendingRepo(database);
    const eventLogRepo = new SqliteEventLogRepo(database);
    const entry = createMemoryEntry();
    const order: string[] = [];

    const returned = repo.createWithinTransaction(entry, {
      beforeCreate: () => {
        order.push("event_log");
        eventLogRepo.append(createMemoryCreatedEventInput(entry));
      },
      afterCreate: () => {
        order.push("enqueue");
        enrichRepo.enqueue({
          workspaceId: entry.workspace_id,
          memoryId: entry.object_id,
          runId: entry.run_id,
          sourceSignalId: "signal-1",
          enqueuedAt: "2026-03-21T00:00:00.000Z"
        });
      }
    });

    expect(returned).toEqual(entry);
    expect(order).toEqual(["event_log", "enqueue"]);
    await expect(repo.findById(entry.object_id)).resolves.toEqual(entry);
    await expect(eventLogRepo.queryByEntity("memory_entry", entry.object_id)).resolves.toHaveLength(1);
    expect(enrichRepo.countPending(entry.workspace_id)).toBe(1);
  });

  it("createWithinTransaction rolls back the EventLog row and memory row when the co-write throws", async () => {
    // invariant pinned: a created memory ALWAYS carries its enrich_pending
    // marker and audit row, or NONE land. A throw in the co-write rolls the
    // EventLog row and memory row back, so the originating signal can replay
    // rather than leave durable truth with no enrichment marker.
    const { repo, database } = await createRepo();
    const enrichRepo = new SqliteEnrichPendingRepo(database);
    const eventLogRepo = new SqliteEventLogRepo(database);
    const entry = createMemoryEntry();

    expect(() =>
      repo.createWithinTransaction(entry, {
        beforeCreate: () => {
          eventLogRepo.append(createMemoryCreatedEventInput(entry));
        },
        afterCreate: () => {
          enrichRepo.enqueue({
            workspaceId: entry.workspace_id,
            memoryId: entry.object_id,
            runId: entry.run_id,
            sourceSignalId: "signal-1",
            enqueuedAt: "2026-03-21T00:00:00.000Z"
          });
          throw new Error("co-write failed");
        }
      })
    ).toThrow("co-write failed");

    await expect(repo.findById(entry.object_id)).resolves.toBeNull();
    await expect(eventLogRepo.queryByEntity("memory_entry", entry.object_id)).resolves.toEqual([]);
    expect(enrichRepo.countPending(entry.workspace_id)).toBe(0);
  });

  it("createWithinTransaction does not insert the row or marker when the EventLog-first callback throws", async () => {
    const { repo, database } = await createRepo();
    const enrichRepo = new SqliteEnrichPendingRepo(database);
    const entry = createMemoryEntry();

    expect(() =>
      repo.createWithinTransaction(entry, {
        beforeCreate: () => {
          throw new Error("event append failed");
        },
        afterCreate: () => {
          enrichRepo.enqueue({
            workspaceId: entry.workspace_id,
            memoryId: entry.object_id,
            runId: entry.run_id,
            sourceSignalId: "signal-1",
            enqueuedAt: "2026-03-21T00:00:00.000Z"
          });
        }
      })
    ).toThrow("event append failed");

    await expect(repo.findById(entry.object_id)).resolves.toBeNull();
    expect(enrichRepo.countPending(entry.workspace_id)).toBe(0);
  });

  it("finds memory entries by ids without duplicates and skips missing ids", async () => {
    const { repo } = await createRepo();
    const first = createMemoryEntry({
      object_id: "7ab81ca8-9425-4e18-ad4a-81ab6406db55",
      run_id: "run-1"
    });
    const second = createMemoryEntry({
      object_id: "ca648194-c03c-4932-b103-3ec4d318732a",
      run_id: "run-2",
      created_at: "2026-03-21T00:00:01.000Z",
      updated_at: "2026-03-21T00:00:01.000Z"
    });

    await repo.create(first);
    await repo.create(second);

    const rows = await repo.findByIds([second.object_id, "missing-memory", first.object_id, second.object_id]);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.object_id).sort()).toEqual([first.object_id, second.object_id].sort());
  });

  it("returns hot-tier records by default in findByWorkspaceId", async () => {
    const { repo } = await createRepo();

    await repo.create(
      createMemoryEntry({
        object_id: "7ab81ca8-9425-4e18-ad4a-81ab6406db55",
        storage_tier: StorageTier.HOT,
        workspace_id: "workspace-1",
        run_id: "run-1"
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "ca648194-c03c-4932-b103-3ec4d318732a",
        storage_tier: StorageTier.COLD,
        workspace_id: "workspace-1",
        run_id: "run-2"
      })
    );

    const rows = await repo.findByWorkspaceId("workspace-1");
    expect(rows.map((row) => row.object_id)).toEqual(["7ab81ca8-9425-4e18-ad4a-81ab6406db55"]);
  });

  it("findByWorkspaceId supports limit/offset with a separate count", async () => {
    const { repo } = await createRepo();
    const ids = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333"
    ];

    for (const [index, objectId] of ids.entries()) {
      await repo.create(
        createMemoryEntry({
          object_id: objectId,
          storage_tier: StorageTier.HOT,
          workspace_id: "workspace-1",
          run_id: `run-page-${index}`,
          created_at: `2026-03-21T00:00:0${index}.000Z`,
          updated_at: `2026-03-21T00:00:0${index}.000Z`
        })
      );
    }

    const page = await repo.findByWorkspaceId("workspace-1", undefined, {
      limit: 1,
      offset: 1
    });

    expect(page.map((row) => row.object_id)).toEqual([ids[1]]);
    await expect(repo.countByWorkspaceId("workspace-1")).resolves.toBe(3);
  });

  it("uses active-row indexes for workspace, run, dimension, and scope list shapes", async () => {
    const { database } = await createRepo();
    const statements = prepareMemoryEntryStatements(database) as unknown as Record<
      keyof ReturnType<typeof prepareMemoryEntryStatements>,
      { readonly source: string }
    >;
    const indexRows = database.connection
      .prepare("PRAGMA index_list('memory_entries')")
      .all() as ReadonlyArray<{ readonly name: string }>;

    expect(indexRows.map((row) => row.name).sort()).toEqual(
      expect.arrayContaining([
        "idx_memory_entries_run_active_created",
        "idx_memory_entries_workspace_dimension_hot_active_created",
        "idx_memory_entries_workspace_scope_hot_active_created",
        "idx_memory_entries_workspace_tier_active_created"
      ])
    );

    const expectPlanUsesIndex = (
      sql: string,
      params: readonly unknown[],
      indexName: string
    ): void => {
      const plan = database.connection
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...params) as ReadonlyArray<{ readonly detail: string }>;
      const details = plan.map((step) => step.detail).join(" | ");
      expect(
        plan.some((step) => step.detail.includes(`USING INDEX ${indexName}`)),
        `expected ${indexName}, got: ${details}`
      ).toBe(true);
      expect(
        plan.some((step) => step.detail.startsWith("SCAN memory_entries")),
        `expected no memory_entries scan, got: ${details}`
      ).toBe(false);
    };

    expectPlanUsesIndex(statements.findByWorkspaceHotStatement.source, [
      "workspace-1"
    ], "idx_memory_entries_workspace_tier_active_created");
    expectPlanUsesIndex(statements.findByWorkspaceTierStatement.source, [
      "workspace-1",
      StorageTier.WARM
    ], "idx_memory_entries_workspace_tier_active_created");
    expectPlanUsesIndex(statements.countByWorkspaceHotStatement.source, [
      "workspace-1"
    ], "idx_memory_entries_workspace_tier_active_created");
    expectPlanUsesIndex(statements.countByWorkspaceTierStatement.source, [
      "workspace-1",
      StorageTier.WARM
    ], "idx_memory_entries_workspace_tier_active_created");
    expectPlanUsesIndex(statements.findByRunIdStatement.source, [
      "run-1"
    ], "idx_memory_entries_run_active_created");
    expectPlanUsesIndex(statements.findByDimensionHotStatement.source, [
      "workspace-1",
      MemoryDimension.PREFERENCE
    ], "idx_memory_entries_workspace_dimension_hot_active_created");
    expectPlanUsesIndex(statements.findByScopeClassHotStatement.source, [
      "workspace-1",
      ScopeClass.PROJECT
    ], "idx_memory_entries_workspace_scope_hot_active_created");
  });

  it("returns explicit cold-tier records when tier is provided", async () => {
    const { repo } = await createRepo();

    await repo.create(
      createMemoryEntry({
        object_id: "2501b5fa-3bc0-4759-a0da-219f805ef03f",
        storage_tier: StorageTier.HOT,
        workspace_id: "workspace-1",
        run_id: "run-1"
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "6406be93-cfed-43d3-90ac-e287facc9ed4",
        storage_tier: StorageTier.COLD,
        workspace_id: "workspace-1",
        run_id: "run-2"
      })
    );

    const rows = await repo.findByWorkspaceId("workspace-1", StorageTier.COLD);
    expect(rows.map((row) => row.object_id)).toEqual(["6406be93-cfed-43d3-90ac-e287facc9ed4"]);
  });

  it("returns explicit warm-tier records when tier is provided", async () => {
    const { repo } = await createRepo();

    await repo.create(
      createMemoryEntry({
        object_id: "2501b5fa-3bc0-4759-a0da-219f805ef03f",
        storage_tier: StorageTier.HOT,
        workspace_id: "workspace-1",
        run_id: "run-1"
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "4a2f07c4-371f-41eb-a9cb-6e842e2c2ca9",
        storage_tier: StorageTier.WARM,
        workspace_id: "workspace-1",
        run_id: "run-2"
      })
    );

    const rows = await repo.findByWorkspaceId("workspace-1", StorageTier.WARM);
    expect(rows.map((row) => row.object_id)).toEqual(["4a2f07c4-371f-41eb-a9cb-6e842e2c2ca9"]);
  });

  it("excludes tombstoned rows when explicit HOT tier is requested", async () => {
    const { repo } = await createRepo();

    await repo.create(
      createMemoryEntry({
        object_id: "7ab81ca8-9425-4e18-ad4a-81ab6406db55",
        storage_tier: StorageTier.HOT,
        workspace_id: "workspace-1",
        run_id: "run-1",
        retention_state: null
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "ca648194-c03c-4932-b103-3ec4d318732a",
        storage_tier: StorageTier.HOT,
        workspace_id: "workspace-1",
        run_id: "run-2",
        retention_state: "tombstoned"
      })
    );

    const rows = await repo.findByWorkspaceId("workspace-1", StorageTier.HOT);
    expect(rows.map((row) => row.object_id)).toEqual(["7ab81ca8-9425-4e18-ad4a-81ab6406db55"]);
  });

  it("excludes tombstoned rows when non-hot tiers are requested", async () => {
    const { repo } = await createRepo();

    await repo.create(
      createMemoryEntry({
        object_id: "4a2f07c4-371f-41eb-a9cb-6e842e2c2ca9",
        storage_tier: StorageTier.WARM,
        workspace_id: "workspace-1",
        run_id: "run-1",
        retention_state: null
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "ca648194-c03c-4932-b103-3ec4d318732a",
        storage_tier: StorageTier.COLD,
        workspace_id: "workspace-1",
        run_id: "run-2",
        retention_state: "tombstoned"
      })
    );

    const warmRows = await repo.findByWorkspaceId("workspace-1", StorageTier.WARM);
    const coldRows = await repo.findByWorkspaceId("workspace-1", StorageTier.COLD);
    expect(warmRows.map((row) => row.object_id)).toEqual(["4a2f07c4-371f-41eb-a9cb-6e842e2c2ca9"]);
    expect(coldRows).toEqual([]);
  });

  it("excludes dormant rows from the recall candidate load but keeps them fetchable by id (REVERSIBLE)", async () => {
    const { repo } = await createRepo();

    await repo.create(
      createMemoryEntry({
        object_id: "7ab81ca8-9425-4e18-ad4a-81ab6406db55",
        storage_tier: StorageTier.HOT,
        workspace_id: "workspace-1",
        run_id: "run-1",
        lifecycle_state: "active"
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "ca648194-c03c-4932-b103-3ec4d318732a",
        storage_tier: StorageTier.HOT,
        workspace_id: "workspace-1",
        run_id: "run-2",
        lifecycle_state: "dormant"
      })
    );

    // invariant: dormant drops out of the recall candidate load (recall-silent).
    const rows = await repo.findByWorkspaceId("workspace-1", StorageTier.HOT);
    expect(rows.map((row) => row.object_id)).toEqual(["7ab81ca8-9425-4e18-ad4a-81ab6406db55"]);

    // invariant: dormant is NOT deleted — findById still returns it and it
    // transitions back to active (reversible).
    const dormant = await repo.findById("ca648194-c03c-4932-b103-3ec4d318732a");
    expect(dormant?.lifecycle_state).toBe("dormant");
    const revived = await repo.transitionLifecycle(
      "ca648194-c03c-4932-b103-3ec4d318732a",
      "active",
      new Date().toISOString()
    );
    expect(revived.lifecycle_state).toBe("active");
    const afterRevival = await repo.findByWorkspaceId("workspace-1", StorageTier.HOT);
    expect(afterRevival.map((row) => row.object_id).sort()).toEqual([
      "7ab81ca8-9425-4e18-ad4a-81ab6406db55",
      "ca648194-c03c-4932-b103-3ec4d318732a"
    ]);
  });

  it("excludes dormant rows from keyword (FTS) recall search", async () => {
    const { repo } = await createRepo();

    await repo.create(
      createMemoryEntry({
        object_id: "7ab81ca8-9425-4e18-ad4a-81ab6406db55",
        storage_tier: StorageTier.HOT,
        workspace_id: "workspace-1",
        run_id: "run-1",
        content: "alpha bravo charlie keyword match",
        lifecycle_state: "active"
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "ca648194-c03c-4932-b103-3ec4d318732a",
        storage_tier: StorageTier.HOT,
        workspace_id: "workspace-1",
        run_id: "run-2",
        content: "alpha bravo charlie keyword match",
        lifecycle_state: "dormant"
      })
    );

    const results = await repo.searchByKeyword("workspace-1", "keyword", 10);
    expect(results.map((result) => result.object_id)).toEqual([
      "7ab81ca8-9425-4e18-ad4a-81ab6406db55"
    ]);
  });

  it("lists entries by run id across both tiers while excluding dormant and tombstoned rows", async () => {
    const { repo } = await createRepo();

    await repo.create(
      createMemoryEntry({
        object_id: "5b32be7d-dfc7-4746-9c7d-d70c6d8f8193",
        run_id: "run-1",
        storage_tier: StorageTier.HOT
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "89debe8f-cf95-4304-8a04-77f44e40be8e",
        run_id: "run-1",
        storage_tier: StorageTier.COLD,
        created_at: "2026-03-21T00:00:01.000Z",
        updated_at: "2026-03-21T00:00:01.000Z"
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "b1e2d23b-7afb-4817-bf8e-fac7ed5ee854",
        run_id: "run-1",
        storage_tier: StorageTier.HOT,
        lifecycle_state: "dormant",
        created_at: "2026-03-21T00:00:02.000Z",
        updated_at: "2026-03-21T00:00:02.000Z"
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "2d6bbf09-a1d1-4262-9495-8317a3781b44",
        run_id: "run-1",
        storage_tier: StorageTier.HOT,
        retention_state: "tombstoned",
        created_at: "2026-03-21T00:00:03.000Z",
        updated_at: "2026-03-21T00:00:03.000Z"
      })
    );

    const rows = await repo.findByRunId("run-1");
    expect(rows.map((row) => row.object_id)).toEqual([
      "5b32be7d-dfc7-4746-9c7d-d70c6d8f8193",
      "89debe8f-cf95-4304-8a04-77f44e40be8e"
    ]);
  });

});
