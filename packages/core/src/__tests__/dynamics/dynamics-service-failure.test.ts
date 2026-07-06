import { describe, expect, it, vi } from "vitest";
import {
  type EventLogEntry,
  type KarmaEvent,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import { DynamicsService, type DynamicsServiceDependencies } from "../../dynamics/dynamics-service.js";
import { createKarmaEvent, createMemoryEntry } from "./karma-fixtures.js";
import { expectDefined, requireAt } from "../helpers/defined.js";

interface FailureHarnessOptions {
  readonly failFirstAppend?: boolean;
  readonly greenService?: {
    reevaluate(params: { targetObjectId: string; workspaceId: string }): Promise<unknown>;
  };
}

function createFailureHarness(entry: MemoryEntry, options: FailureHarnessOptions = {}) {
  const entriesById = new Map<string, MemoryEntry>([[entry.object_id, { ...entry }]]);
  const karmaEvents: KarmaEvent[] = [];
  const appendedEvents: EventLogEntry[] = [];

  let appendCalls = 0;
  const appendSpy = vi.fn(async (input: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => {
    appendCalls += 1;
    if (options.failFirstAppend === true && appendCalls === 1) {
      throw new Error("eventLogRepo.append failed");
    }
    const created: EventLogEntry = {
      event_id: `event-${appendedEvents.length + 1}`,
      created_at: "2026-03-23T00:00:00.000Z",
      revision: 0,
      ...input
    };
    appendedEvents.push(created);
    return created;
  });

  const updateDynamicsSpy = vi.fn(async (objectId: string, fields: Partial<MemoryEntry>, updatedAt: string) => {
    const existing = entriesById.get(objectId);
    if (existing === undefined) {
      throw new Error(`missing entry ${objectId}`);
    }
    const updated: MemoryEntry = {
      ...existing,
      activation_score: fields.activation_score ?? existing.activation_score,
      retention_score: fields.retention_score ?? existing.retention_score,
      manifestation_state: fields.manifestation_state ?? existing.manifestation_state,
      retention_state: fields.retention_state ?? existing.retention_state,
      reinforcement_count: fields.reinforcement_count ?? existing.reinforcement_count,
      updated_at: updatedAt
    };
    entriesById.set(objectId, updated);
    return Object.freeze({ ...updated });
  });

  const notifyEntrySpy = vi.fn(async () => {});

  const dependencies: DynamicsServiceDependencies = {
    now: () => "2026-03-23T00:00:00.000Z",
    memoryRepo: {
      findById: vi.fn(async (objectId: string) => {
        const found = entriesById.get(objectId);
        return found === undefined ? null : Object.freeze({ ...found });
      }),
      findByWorkspaceId: vi.fn(async () => []),
      updateDynamics: updateDynamicsSpy
    },
    karmaEventRepo: {
      create: vi.fn(async (event) => {
        const frozen = Object.freeze({ ...event });
        karmaEvents.push(frozen);
        return frozen;
      }),
      sumByObjectId: vi.fn(async (objectId) =>
        karmaEvents
          .filter((event) => event.object_id === objectId)
          .reduce((sum, event) => sum + event.amount, 0)
      ),
      sumByObjectIds: vi.fn(async () => Object.freeze({})),
      findByObjectId: vi.fn(async () => [])
    },
    eventLogRepo: {
      append: appendSpy,
      queryByEntity: vi.fn(async () => [])
    },
    runtimeNotifier: {
      notifyEntry: notifyEntrySpy
    },
    greenService: options.greenService
  };

  return {
    service: new DynamicsService(dependencies),
    appendSpy,
    updateDynamicsSpy,
    notifyEntrySpy
  };
}

describe("DynamicsService karma transition failure invariants", () => {
  it("commits the DB mutation before broadcasting (persist-then-broadcast)", async () => {
    const { service, updateDynamicsSpy, appendSpy, notifyEntrySpy } = createFailureHarness(createMemoryEntry());

    await service.processKarmaEvent(createKarmaEvent());

    expect(updateDynamicsSpy).toHaveBeenCalledTimes(1);
    expect(notifyEntrySpy.mock.calls.length).toBeGreaterThan(0);
    // invariant: the durable mutation and every audit append precede the first
    // broadcast, so a subscriber never observes an event before it is persisted.
    const firstNotifyOrder = expectDefined(requireAt(notifyEntrySpy.mock.invocationCallOrder, 0), "invocationCallOrder");
    expect(expectDefined(requireAt(updateDynamicsSpy.mock.invocationCallOrder, 0), "invocationCallOrder")).toBeLessThan(firstNotifyOrder);
    for (const appendOrder of appendSpy.mock.invocationCallOrder) {
      expect(appendOrder).toBeLessThan(firstNotifyOrder);
    }
  });

  it("aborts before broadcast when an audit append fails (no broadcast-after-failed-audit)", async () => {
    const { service, updateDynamicsSpy, notifyEntrySpy } = createFailureHarness(createMemoryEntry(), {
      failFirstAppend: true
    });

    await expect(service.processKarmaEvent(createKarmaEvent())).rejects.toThrow(
      "eventLogRepo.append failed"
    );

    // The durable mutation ran (async repos are not single-transaction here);
    // the load-bearing invariant is that a failed audit withholds the broadcast.
    expect(updateDynamicsSpy).toHaveBeenCalledTimes(1);
    expect(notifyEntrySpy).not.toHaveBeenCalled();
  });

  it("swallows a rejected green reevaluation (fire-and-forget, never fails the transition)", async () => {
    const reevaluate = vi.fn(async () => {
      throw new Error("greenService.reevaluate rejected");
    });
    const { service, notifyEntrySpy } = createFailureHarness(createMemoryEntry(), {
      greenService: { reevaluate }
    });

    await expect(service.processKarmaEvent(createKarmaEvent())).resolves.toBeUndefined();
    await Promise.resolve();
    await Promise.resolve();

    expect(reevaluate).toHaveBeenCalledWith({ targetObjectId: "memory-1", workspaceId: "workspace-1" });
    // The transition itself still broadcast its audited events.
    expect(notifyEntrySpy.mock.calls.length).toBeGreaterThan(0);
  });
});
