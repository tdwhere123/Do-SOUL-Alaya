import { describe, expect, it, vi } from "vitest";
import {
  FormationKind,
  MemoryDimension,
  ScopeClass,
  SourceKind,
  StorageTier,
  type EventLogEntry,
  type KarmaEvent,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import { DynamicsService, type DynamicsServiceDependencies } from "../dynamics-service.js";

function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: "memory-1",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-20T00:00:00.000Z",
    updated_at: "2026-03-20T00:00:00.000Z",
    created_by: "user",
    dimension: MemoryDimension.FACT,
    source_kind: SourceKind.USER,
    formation_kind: FormationKind.EXPLICIT,
    scope_class: ScopeClass.PROJECT,
    content: "content",
    domain_tags: ["workflow"],
    evidence_refs: ["evidence-1"],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: StorageTier.HOT,
    activation_score: 0.2,
    retention_score: 0.2,
    manifestation_state: "hint",
    retention_state: "working",
    decay_profile: "normal",
    confidence: 0.9,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: 0,
    contradiction_count: 0,
    superseded_by: null,
    ...overrides
  };
}

function createKarmaEvent(overrides: Partial<KarmaEvent> = {}): KarmaEvent {
  return {
    event_id: "event-1",
    kind: "accept_gain",
    object_id: "memory-1",
    amount: 0.15,
    created_at: "2026-03-23T00:00:00.000Z",
    workspace_id: "workspace-1",
    ...overrides
  };
}

function createHarness(memoryEntries: readonly MemoryEntry[], options: { readonly greenService?: { reevaluate(params: { targetObjectId: string; workspaceId: string; }): Promise<unknown>; } } = {}): {
  readonly service: DynamicsService;
  readonly entriesById: Map<string, MemoryEntry>;
  readonly karmaEvents: KarmaEvent[];
  readonly appendedEvents: EventLogEntry[];
  readonly appendSpy: ReturnType<typeof vi.fn>;
  readonly notifyEntrySpy: ReturnType<typeof vi.fn>;
} {
  const entriesById = new Map(memoryEntries.map((entry) => [entry.object_id, { ...entry }]));
  const karmaEvents: KarmaEvent[] = [];
  const appendedEvents: EventLogEntry[] = [];
  const notifyEntrySpy = vi.fn(async () => {});
  const appendSpy = vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at">) => {
    const created: EventLogEntry = {
      event_id: `event-${appendedEvents.length + 1}`,
      created_at: "2026-03-23T00:00:00.000Z",
      ...entry
    };
    appendedEvents.push(created);
    return created;
  });

  const dependencies: DynamicsServiceDependencies = {
    now: () => "2026-03-23T00:00:00.000Z",
    memoryRepo: {
      findById: vi.fn(async (objectId: string) => {
        const found = entriesById.get(objectId);
        return found === undefined ? null : Object.freeze({ ...found });
      }),
      findByWorkspaceId: vi.fn(async (workspaceId: string, tier?: StorageTier) => {
        const values = [...entriesById.values()].filter(
          (entry) =>
            entry.workspace_id === workspaceId && (tier === undefined || entry.storage_tier === tier)
        );
        return values.map((entry) => Object.freeze({ ...entry }));
      }),
      updateDynamics: vi.fn(async (objectId, fields, updatedAt) => {
        const existing = entriesById.get(objectId);

        if (existing === undefined) {
          throw new Error(`missing entry ${objectId}`);
        }

        const updated: MemoryEntry = {
          ...existing,
          activation_score: fields.activation_score,
          retention_score: fields.retention_score,
          manifestation_state: fields.manifestation_state,
          last_used_at: fields.last_used_at ?? existing.last_used_at,
          last_hit_at: fields.last_hit_at ?? existing.last_hit_at,
          reinforcement_count: fields.reinforcement_count ?? existing.reinforcement_count,
          contradiction_count: fields.contradiction_count ?? existing.contradiction_count,
          superseded_by: fields.superseded_by ?? existing.superseded_by,
          updated_at: updatedAt
        };

        entriesById.set(objectId, updated);
        return Object.freeze({ ...updated });
      })
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
      sumByObjectIds: vi.fn(async (objectIds) => {
        const totals: Record<string, number> = {};

        for (const objectId of objectIds) {
          totals[objectId] = karmaEvents
            .filter((event) => event.object_id === objectId)
            .reduce((sum, event) => sum + event.amount, 0);
        }

        return Object.freeze(totals);
      }),
      findByObjectId: vi.fn(async (objectId) =>
        karmaEvents.filter((event) => event.object_id === objectId).map((event) => Object.freeze({ ...event }))
      )
    },
    eventLogRepo: {
      append: appendSpy,
      queryByEntity: vi.fn(async (entityType, entityId) =>
        appendedEvents.filter((entry) => entry.entity_type === entityType && entry.entity_id === entityId)
      )
    },
    runtimeNotifier: {
      notifyEntry: notifyEntrySpy
    },
    greenService: options.greenService
  };

  return {
    service: new DynamicsService(dependencies),
    entriesById,
    karmaEvents,
    appendedEvents,
    appendSpy,
    notifyEntrySpy
  };
}

describe("DynamicsService", () => {
  it("assigns initial dynamics by dimension and formation kind", () => {
    const { service } = createHarness([]);

    const hazard = service.assignInitialDynamics({
      dimension: MemoryDimension.HAZARD,
      formation_kind: FormationKind.EXPLICIT,
      created_at: "2026-03-23T00:00:00.000Z"
    });
    const episode = service.assignInitialDynamics({
      dimension: MemoryDimension.EPISODE,
      formation_kind: FormationKind.INFERRED,
      created_at: "2026-03-23T00:00:00.000Z"
    });
    const glossary = service.assignInitialDynamics({
      dimension: MemoryDimension.GLOSSARY,
      formation_kind: FormationKind.IMPORTED,
      created_at: "2026-03-23T00:00:00.000Z"
    });

    expect(hazard.decay_profile).toBe("hazard");
    expect(hazard.confidence).toBe(0.9);
    expect(hazard.retention_state).toBe("working");
    expect(hazard.activation_score).toBe(0.45);

    expect(episode.decay_profile).toBe("volatile");
    expect(episode.confidence).toBe(0.4);

    expect(glossary.decay_profile).toBe("pinned");
    expect(glossary.confidence).toBe(0.7);
  });

  it("processKarmaEvent increases retention and emits retention + manifestation events on threshold crossing", async () => {
    const { service, entriesById, appendedEvents, appendSpy, notifyEntrySpy } = createHarness([createMemoryEntry()]);

    await service.processKarmaEvent(createKarmaEvent());

    const updated = entriesById.get("memory-1");
    expect(updated).toBeDefined();
    expect(updated?.retention_score).toBeGreaterThan(0.2);
    expect(updated?.reinforcement_count).toBe(1);

    const eventTypes = appendedEvents.map((entry) => entry.event_type);
    expect(eventTypes).toContain("soul.memory.retention_updated");
    expect(eventTypes).toContain("soul.memory.manifestation_changed");
    expect(notifyEntrySpy).toHaveBeenCalledTimes(appendedEvents.length);
    expect(notifyEntrySpy.mock.calls.map(([entry]) => entry.event_id)).toEqual(
      appendedEvents.map((entry) => entry.event_id)
    );
    for (const [index] of appendedEvents.entries()) {
      expect(appendSpy.mock.invocationCallOrder[index]).toBeLessThan(
        notifyEntrySpy.mock.invocationCallOrder[index]
      );
    }
  });

  it("processKarmaEvent decreases retention on reject_penalty", async () => {
    const { service, entriesById } = createHarness([
      createMemoryEntry({ retention_score: 0.9, activation_score: 0.9, manifestation_state: "full_eligible" })
    ]);

    await service.processKarmaEvent(
      createKarmaEvent({ kind: "reject_penalty", amount: -0.3, event_id: "event-2" })
    );

    const updated = entriesById.get("memory-1");
    expect(updated).toBeDefined();
    expect(updated?.retention_score).toBeLessThan(0.9);
  });

  it("does not emit manifestation_changed when manifestation band is unchanged", async () => {
    const { service, appendedEvents } = createHarness([
      createMemoryEntry({
        activation_score: 0.8,
        manifestation_state: "full_eligible",
        retention_score: 0.8
      })
    ]);

    await service.processKarmaEvent(
      createKarmaEvent({ kind: "evidence_gain", amount: 0.01, event_id: "event-3" })
    );

    const manifestationEvents = appendedEvents.filter(
      (entry) => entry.event_type === "soul.memory.manifestation_changed"
    );
    expect(manifestationEvents).toHaveLength(0);
  });

  it("keeps pinned retention at floor even with penalties", async () => {
    const { service, entriesById } = createHarness([
      createMemoryEntry({
        object_id: "memory-pinned",
        decay_profile: "pinned",
        formation_kind: FormationKind.IMPORTED,
        retention_score: 0.9
      })
    ]);

    await service.processKarmaEvent(
      createKarmaEvent({
        event_id: "event-4",
        object_id: "memory-pinned",
        kind: "reject_penalty",
        amount: -2
      })
    );

    const updated = entriesById.get("memory-pinned");
    expect(updated?.retention_score).toBe(0.8);
  });

  it("computeActivationScore favors scope/domain matches", () => {
    const { service } = createHarness([createMemoryEntry()]);
    const memory = createMemoryEntry({ retention_score: 0.8, last_used_at: "2026-03-22T00:00:00.000Z" });

    const matched = service.computeActivationScore(memory, {
      currentScopeClass: ScopeClass.PROJECT,
      currentDomainTags: ["workflow"],
      now: "2026-03-23T00:00:00.000Z"
    });

    const mismatched = service.computeActivationScore(memory, {
      currentScopeClass: ScopeClass.GLOBAL_CORE,
      currentDomainTags: ["security"],
      now: "2026-03-23T00:00:00.000Z"
    });

    expect(matched).toBeGreaterThan(mismatched);
  });

  it("scanRetentionDecay updates hot memories and returns counts", async () => {
    const { service } = createHarness([
      createMemoryEntry({ object_id: "memory-a" }),
      createMemoryEntry({
        object_id: "memory-b",
        storage_tier: StorageTier.HOT,
        workspace_id: "workspace-1",
        run_id: "run-2"
      }),
      createMemoryEntry({ object_id: "memory-c", storage_tier: StorageTier.COLD })
    ]);

    await service.processKarmaEvent(
      createKarmaEvent({ event_id: "event-a", object_id: "memory-a", amount: 0.15 })
    );

    const result = await service.scanRetentionDecay("workspace-1");

    expect(result.updated_count).toBeGreaterThanOrEqual(1);
    expect(result.manifestation_changes).toBeGreaterThanOrEqual(0);
  });
  it("notifies greenService after processing a karma event", async () => {
    const reevaluateSpy = vi.fn(async () => undefined);
    const { service } = createHarness([createMemoryEntry()], {
      greenService: {
        reevaluate: reevaluateSpy
      }
    });

    await service.processKarmaEvent(createKarmaEvent());

    await Promise.resolve();
    expect(reevaluateSpy).toHaveBeenCalledWith({
      targetObjectId: "memory-1",
      workspaceId: "workspace-1"
    });
  });


});
