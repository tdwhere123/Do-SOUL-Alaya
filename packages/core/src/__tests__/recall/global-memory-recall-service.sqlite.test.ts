import { afterEach, describe, expect, it } from "vitest";
import {
  GLOBAL_MEMORY_ENTRY_OBJECT_KIND,
  MemoryDimension,
  ScopeClass,
  type EventLogEntry,
  type GlobalMemoryEntry
} from "@do-soul/alaya-protocol";
import { initDatabase, SqliteGlobalMemoryRepo, type StorageDatabase } from "@do-soul/alaya-storage";
import {
  createGlobalMemoryRecallPort,
  type GlobalMemoryRecallInvalidationNotifier
} from "../../recall/runtime/global-memory-recall-service.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

describe("GlobalMemoryRecallService + SqliteGlobalMemoryRepo", () => {
  it("does not cache a SQLite select that finishes after invalidation", async () => {
    const database = initDatabase({ filename: ":memory:" });
    databases.add(database);
    const repo = new SqliteGlobalMemoryRepo(database);
    await repo.upsert(
      createGlobalMemoryEntry({
        content: "SQLite recall v1",
        updated_at: "2026-04-30T00:00:00.000Z"
      })
    );

    let releaseList!: () => void;
    let startedList!: () => void;
    const listStarted = new Promise<void>((resolve) => {
      startedList = resolve;
    });
    let listCalls = 0;
    const service = createGlobalMemoryRecallPort({
      globalMemorySource: {
        list: async () => {
          const snapshot = await repo.list();
          listCalls += 1;
          if (listCalls === 1) {
            startedList();
            await new Promise<void>((resolve) => {
              releaseList = resolve;
            });
          }
          return snapshot;
        }
      }
    });
    const runtimeNotifier = createRuntimeNotifierHarness();
    const subscription = service.subscribeToInvalidations(runtimeNotifier);

    const pending = service.recall({
      workspaceId: "workspace-b",
      queryText: "sqlite recall",
      limit: 5
    });
    await listStarted;

    await repo.upsert(
      createGlobalMemoryEntry({
        content: "SQLite recall v2",
        version: 2,
        updated_at: "2026-04-30T01:00:00.000Z"
      })
    );
    await runtimeNotifier.notifyEntry(
      createMemoryUpdatedEntry("memory-shared")
    );
    releaseList();
    await pending;

    const refreshed = await service.recall({
      workspaceId: "workspace-b",
      queryText: "sqlite recall",
      limit: 5
    });

    expect(refreshed[0]?.content).toBe("SQLite recall v2");
    expect(listCalls).toBe(2);
    subscription.dispose();
  });
});

function createGlobalMemoryEntry(overrides: Partial<GlobalMemoryEntry> = {}): GlobalMemoryEntry {
  return {
    object_kind: GLOBAL_MEMORY_ENTRY_OBJECT_KIND,
    global_object_id: "memory-shared",
    canonical_identity: "Shared memory",
    version: 1,
    dimension: MemoryDimension.PROCEDURE,
    scope_class: ScopeClass.GLOBAL_DOMAIN,
    content: "Shared recall",
    domain_tags: ["shared"],
    provenance: "test",
    activation_score: 0.9,
    created_at: "2026-04-30T00:00:00.000Z",
    updated_at: "2026-04-30T00:00:00.000Z",
    ...overrides
  };
}

function createRuntimeNotifierHarness(): GlobalMemoryRecallInvalidationNotifier & {
  notifyEntry(entry: EventLogEntry): Promise<void>;
} {
  const entryListeners = new Set<(entry: EventLogEntry) => void | Promise<void>>();
  return {
    subscribeEntries(listener) {
      entryListeners.add(listener);
      return Object.freeze({
        dispose: () => {
          entryListeners.delete(listener);
        }
      });
    },
    notifyEntry: async (entry: EventLogEntry) => {
      for (const listener of [...entryListeners]) {
        await listener(entry);
      }
    }
  };
}

function createMemoryUpdatedEntry(memoryId: string): EventLogEntry {
  return {
    event_id: "event-1",
    event_type: "soul.memory.updated",
    entity_type: "memory_entry",
    entity_id: memoryId,
    workspace_id: "workspace-a",
    run_id: null,
    caused_by: "system",
    payload_json: {
      workspace_id: "workspace-a",
      memory_id: memoryId
    },
    created_at: "2026-04-30T00:00:01.000Z",
    revision: 1
  };
}
