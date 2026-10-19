import { afterEach, describe, expect, it } from "vitest";
import {
  GardenTaskKind,
  GardenTier,
  type AuditorEventLogPort,
  type EventLogEntry,
  type GardenTaskDescriptor
} from "@do-soul/alaya-protocol";
import { Janitor } from "@do-soul/alaya-soul";
import { SqliteEventLogRepo } from "../../../repos/runtime/event-log-repo.js";
import {
  createFixture,
  seedMemoryEntry,
  trackedDatabases
} from "./garden-data-ports-fixture.js";

const databases = trackedDatabases;
const CLOCK = "2026-04-15T00:00:00.000Z";
const STALE_HIT = "2026-01-01T00:00:00.000Z";

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

describe("janitor hot index demotion EventLog transaction", () => {
  it("commits tier events and cold rows together for a normal batch", async () => {
    const { database, ports } = await createFixture();
    seedEligible(database, "memory-a");
    seedEligible(database, "memory-b");
    const janitor = createSqliteJanitor(database, ports.tieringPort);

    const result = await janitor.run(createHotDemotionTask());

    expect(result.success).toBe(true);
    expect(result.objects_affected).toEqual(["memory-a", "memory-b"]);
    expect(selectTiers(database, ["memory-a", "memory-b"])).toEqual([
      { object_id: "memory-a", storage_tier: "cold" },
      { object_id: "memory-b", storage_tier: "cold" }
    ]);
    expect(selectTierChangedIds(database)).toEqual(["memory-a", "memory-b"]);
  });

  it("rolls back events and updates when a selected candidate is no longer hot", async () => {
    const { database, ports } = await createFixture();
    seedEligible(database, "memory-keep");
    seedEligible(database, "memory-stale");
    const janitor = createSqliteJanitor(database, {
      findHotDemotionCandidates: async (workspaceId, criteria) => {
        const found = await ports.tieringPort.findHotDemotionCandidates(workspaceId, criteria);
        database.connection
          .prepare("UPDATE memory_entries SET storage_tier = 'cold' WHERE object_id = ?")
          .run("memory-stale");
        return found;
      },
      demoteToWarm: (workspaceId, memoryEntryIds) =>
        ports.tieringPort.demoteToWarm(workspaceId, memoryEntryIds)
    });

    const result = await janitor.run(createHotDemotionTask());

    expect(result.success).toBe(false);
    expect(result.objects_affected).toEqual([]);
    expect(result.error_message).toMatch(/hot index demotion applied a different id set/);
    expect(selectTiers(database, ["memory-keep", "memory-stale"])).toEqual([
      { object_id: "memory-keep", storage_tier: "hot" },
      { object_id: "memory-stale", storage_tier: "cold" }
    ]);
    expect(selectTierChangedIds(database)).toEqual([]);
  });
});

function seedEligible(
  database: Awaited<ReturnType<typeof createFixture>>["database"],
  objectId: string
): void {
  seedMemoryEntry(database, {
    objectId,
    workspaceId: "workspace-1",
    runId: "run-1",
    activationScore: 0.1,
    lastHitAt: STALE_HIT
  });
}

function createSqliteJanitor(
  database: Awaited<ReturnType<typeof createFixture>>["database"],
  tieringPort: ConstructorParameters<typeof Janitor>[0]["tieringPort"]
): Janitor {
  const eventLog = new SqliteEventLogRepo(database);
  const eventLogRepo: AuditorEventLogPort = {
    append: (entry) => eventLog.append(entry),
    appendManyWithMutation: async <T>(
      entries: readonly Omit<EventLogEntry, "event_id" | "created_at" | "revision">[],
      mutate: (rows: readonly EventLogEntry[]) => T
    ): Promise<T> =>
      eventLog.transactional(() => {
        const persisted = entries.map((entry) => {
          const row = eventLog.append(entry);
          if (row instanceof Promise) {
            throw new Error("EventLog append inside transaction must be synchronous");
          }
          return row;
        });
        return mutate(persisted);
      })
  };
  return new Janitor({
    cleanupPort: {
      findExpiredObjects: async () => [],
      removeExpiredObjects: () => undefined
    },
    tieringPort,
    scheduler: { reportCompletion: async () => undefined },
    eventLogRepo,
    now: () => CLOCK
  });
}

function createHotDemotionTask(): GardenTaskDescriptor {
  return {
    task_id: "task-1",
    task_kind: GardenTaskKind.HOT_INDEX_DEMOTION,
    required_tier: GardenTier.TIER_0,
    workspace_id: "workspace-1",
    run_id: null,
    target_object_refs: [],
    priority: 10,
    created_at: CLOCK
  };
}

function selectTiers(
  database: Awaited<ReturnType<typeof createFixture>>["database"],
  objectIds: readonly string[]
): readonly { readonly object_id: string; readonly storage_tier: string }[] {
  const placeholders = objectIds.map(() => "?").join(", ");
  return database.connection
    .prepare(
      `SELECT object_id, storage_tier FROM memory_entries WHERE object_id IN (${placeholders}) ORDER BY object_id`
    )
    .all(...objectIds) as readonly { readonly object_id: string; readonly storage_tier: string }[];
}

function selectTierChangedIds(
  database: Awaited<ReturnType<typeof createFixture>>["database"]
): readonly string[] {
  return (
    database.connection
      .prepare(
        "SELECT entity_id FROM event_log WHERE event_type = 'soul.memory.tier_changed' ORDER BY entity_id"
      )
      .all() as readonly { readonly entity_id: string }[]
  ).map((row) => row.entity_id);
}
