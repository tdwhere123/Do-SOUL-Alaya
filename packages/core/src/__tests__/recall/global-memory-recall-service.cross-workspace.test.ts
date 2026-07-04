import { describe, expect, it, vi } from "vitest";
import type { EventLogEntry, GlobalMemoryEntry } from "@do-soul/alaya-protocol";
import { EventPublisher } from "../../runtime/event-publisher.js";
import {
  createGlobalMemoryRecallPort,
  type GlobalMemoryRecallInvalidationNotifier
} from "../../recall/runtime/global-memory-recall-service.js";

describe("GlobalMemoryRecallService cross-workspace invalidation", () => {
  it("invalidates cached recall entries in another workspace view via notifier delivery", async () => {
    const source = createGlobalMemorySource([
      createGlobalMemoryEntry({
        global_object_id: "memory-shared-1",
        content: "Shared recall v1",
        updated_at: "2026-04-30T00:00:00.000Z"
      })
    ]);
    const serviceWorkspaceA = createGlobalMemoryRecallPort({
      globalMemorySource: source
    });
    const serviceWorkspaceB = createGlobalMemoryRecallPort({
      globalMemorySource: source
    });
    const runtimeNotifier = createRuntimeNotifierHarness();
    const subscriptionA = serviceWorkspaceA.subscribeToInvalidations(runtimeNotifier);
    const subscriptionB = serviceWorkspaceB.subscribeToInvalidations(runtimeNotifier);
    const auditRows: EventLogEntry[] = [];
    const eventPublisher = createEventPublisher({
      auditRows,
      runtimeNotifier
    });

    await serviceWorkspaceA.recall({
      workspaceId: "workspace-a",
      queryText: "shared recall",
      limit: 5
    });
    const workspaceBCachedV1 = await serviceWorkspaceB.recall({
      workspaceId: "workspace-b",
      queryText: "shared recall",
      limit: 5
    });

    expect(workspaceBCachedV1[0]?.content).toBe("Shared recall v1");
    expect(source.list).toHaveBeenCalledTimes(2);

    source.setEntries([
      createGlobalMemoryEntry({
        global_object_id: "memory-shared-1",
        content: "Shared recall v2",
        updated_at: "2026-04-30T01:00:00.000Z"
      })
    ]);

    const workspaceBStaleBeforeInvalidation = await serviceWorkspaceB.recall({
      workspaceId: "workspace-b",
      queryText: "shared recall",
      limit: 5
    });
    expect(workspaceBStaleBeforeInvalidation[0]?.content).toBe("Shared recall v1");
    expect(source.list).toHaveBeenCalledTimes(2);

    let listenerSawAuditRow = false;
    const auditProbe = runtimeNotifier.subscribeEntries((entry) => {
      if (entry.event_type !== "soul.memory.updated") {
        return;
      }

      listenerSawAuditRow = auditRows.some((row) => row.event_id === entry.event_id);
    });

    await eventPublisher.appendManyWithMutation(
      [
        createMemoryEventInput({
        event_type: "soul.memory.updated",
        workspace_id: "workspace-a",
        entity_id: "memory-shared-1",
        payload_json: {
          workspace_id: "workspace-a",
          memory_id: "memory-shared-1"
        }
        })
      ],
      () => undefined
    );

    expect(listenerSawAuditRow).toBe(true);

    const workspaceBRefreshedAfterInvalidation = await serviceWorkspaceB.recall({
      workspaceId: "workspace-b",
      queryText: "shared recall",
      limit: 5
    });
    expect(workspaceBRefreshedAfterInvalidation[0]?.content).toBe("Shared recall v2");
    expect(source.list).toHaveBeenCalledTimes(3);

    await eventPublisher.publish(
      createMemoryEventInput({
        event_type: "soul.memory.updated",
        workspace_id: "workspace-a",
        entity_id: "memory-shared-1",
        payload_json: {
          workspace_id: "workspace-a",
          memory_id: "memory-shared-1"
        }
      })
    );
    await eventPublisher.publish(
      createMemoryEventInput({
        event_type: "soul.memory.updated",
        workspace_id: "workspace-a",
        entity_id: "memory-shared-1",
        payload_json: {
          workspace_id: "workspace-a",
          memory_id: "memory-shared-1"
        }
      })
    );

    const workspaceBRefreshedAfterDuplicateEvents = await serviceWorkspaceB.recall({
      workspaceId: "workspace-b",
      queryText: "shared recall",
      limit: 5
    });
    expect(workspaceBRefreshedAfterDuplicateEvents[0]?.content).toBe("Shared recall v2");
    expect(source.list).toHaveBeenCalledTimes(4);

    auditProbe.dispose();
    subscriptionA.dispose();
    subscriptionB.dispose();
  });

  it("accepts soul.memory.updated object_id payloads for invalidation", async () => {
    const source = createGlobalMemorySource([
      createGlobalMemoryEntry({
        global_object_id: "memory-shared-2",
        content: "Object payload v1",
        updated_at: "2026-04-30T00:00:00.000Z"
      })
    ]);
    const service = createGlobalMemoryRecallPort({
      globalMemorySource: source
    });
    const runtimeNotifier = createRuntimeNotifierHarness();
    const subscription = service.subscribeToInvalidations(runtimeNotifier);
    const auditRows: EventLogEntry[] = [];
    const eventPublisher = createEventPublisher({
      auditRows,
      runtimeNotifier
    });

    await service.recall({
      workspaceId: "workspace-b",
      queryText: "object payload",
      limit: 5
    });

    source.setEntries([
      createGlobalMemoryEntry({
        global_object_id: "memory-shared-2",
        content: "Object payload v2",
        updated_at: "2026-04-30T01:00:00.000Z"
      })
    ]);

    await eventPublisher.appendManyWithMutation(
      [
        createMemoryEventInput({
        event_type: "soul.memory.updated",
        workspace_id: "workspace-a",
        entity_id: "memory-shared-2",
        payload_json: {
          workspace_id: "workspace-a",
          object_id: "memory-shared-2"
        }
        })
      ],
      () => undefined
    );

    const refreshed = await service.recall({
      workspaceId: "workspace-b",
      queryText: "object payload",
      limit: 5
    });

    expect(refreshed[0]?.content).toBe("Object payload v2");
    expect(auditRows).toHaveLength(1);
    subscription.dispose();
  });
});

function createGlobalMemorySource(initialEntries: readonly Readonly<GlobalMemoryEntry>[]) {
  let entries = [...initialEntries];
  const list = vi.fn(async () => entries);

  return {
    list,
    setEntries(nextEntries: readonly Readonly<GlobalMemoryEntry>[]) {
      entries = [...nextEntries];
    }
  };
}

function createGlobalMemoryEntry(
  overrides: Partial<{
    readonly global_object_id: string;
    readonly content: string;
    readonly updated_at: string;
  }> = {}
): GlobalMemoryEntry {
  return {
    object_kind: "global_memory_entry",
    global_object_id: "memory-shared",
    canonical_identity: "Shared memory",
    version: 1,
    dimension: "procedure",
    scope_class: "global_domain",
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
  notify(runId: string, event: unknown): Promise<void>;
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
    notify: async () => undefined,
    notifyEntry: async (entry: EventLogEntry) => {
      for (const listener of [...entryListeners]) {
        await listener(entry);
      }
    }
  };
}

function createEventPublisher(input: {
  readonly auditRows: EventLogEntry[];
  readonly runtimeNotifier: {
    notify(runId: string, event: unknown): Promise<void>;
    notifyEntry(entry: EventLogEntry): Promise<void>;
  };
}): EventPublisher {
  return new EventPublisher({
    eventLogRepo: {
      append: vi.fn((event) => {
        const entry = createEventLogEntry(event, input.auditRows.length + 1);
        input.auditRows.push(entry);
        return entry;
      }),
      deleteById: vi.fn((eventId: string) => {
        const index = input.auditRows.findIndex((row) => row.event_id === eventId);
        if (index >= 0) {
          input.auditRows.splice(index, 1);
        }
      }),
      transactional: <T>(fn: () => T): T => fn()
    },
    runHotStateService: {
      apply: vi.fn(async () => undefined)
    },
    runtimeNotifier: input.runtimeNotifier
  });
}

function createEventLogEntry(
  event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">,
  revision: number
): EventLogEntry {
  return {
    ...event,
    event_id: `event-${revision}`,
    created_at: `2026-04-30T00:00:0${revision}.000Z`,
    revision
  };
}

function createMemoryEventInput(overrides: Partial<Omit<EventLogEntry, "event_id" | "created_at" | "revision">>): Omit<EventLogEntry, "event_id" | "created_at" | "revision"> {
  return {
    event_type: "soul.memory.updated",
    entity_type: "memory_entry",
    entity_id: "memory-shared",
    workspace_id: "workspace-a",
    run_id: null,
    caused_by: "system",
    payload_json: {
      workspace_id: "workspace-a",
      memory_id: "memory-shared"
    },
    ...overrides
  };
}
