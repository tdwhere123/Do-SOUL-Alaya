import { describe, expect, it, vi } from "vitest";
import {
  StorageTier,
  type EventLogEntry,
  type KarmaEvent,
  type MemoryEntry,
  type RecallPolicy
} from "@do-soul/alaya-protocol";
import { DynamicsService, type DynamicsServiceDependencies } from "../../dynamics/dynamics-service.js";
import { matchesPrecomputedRankFilter } from "../../recall/runtime/recall-service-helpers.js";
import { createKarmaEvent, createMemoryEntry } from "./karma-fixtures.js";

function createDecayHarness(getNow: () => string): {
  readonly service: DynamicsService;
  readonly entriesById: Map<string, MemoryEntry>;
  readonly appendedEvents: EventLogEntry[];
} {
  const entriesById = new Map<string, MemoryEntry>();
  const appendedEvents: EventLogEntry[] = [];
  const karmaEvents: KarmaEvent[] = [];

  const dependencies: DynamicsServiceDependencies = {
    now: getNow,
    memoryRepo: {
      findById: vi.fn(async (objectId: string) => {
        const found = entriesById.get(objectId);
        return found === undefined ? null : Object.freeze({ ...found });
      }),
      findByWorkspaceId: vi.fn(async (workspaceId: string, tier?: StorageTier) =>
        [...entriesById.values()]
          .filter(
            (entry) =>
              entry.workspace_id === workspaceId && (tier === undefined || entry.storage_tier === tier)
          )
          .map((entry) => Object.freeze({ ...entry }))
      ),
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
          retention_state: fields.retention_state ?? existing.retention_state,
          updated_at: updatedAt
        };
        entriesById.set(objectId, updated);
        return Object.freeze({ ...updated });
      })
    },
    karmaEventRepo: {
      create: vi.fn(async (event: KarmaEvent) => {
        karmaEvents.push(event);
      }),
      sumByObjectId: vi.fn(async (objectId: string) =>
        karmaEvents.filter((event) => event.object_id === objectId).reduce((sum, event) => sum + event.amount, 0)
      )
    },
    eventLogRepo: {
      append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => {
        const created: EventLogEntry = {
          event_id: `event-${appendedEvents.length + 1}`,
          created_at: getNow(),
          revision: 0,
          ...entry
        };
        appendedEvents.push(created);
        return created;
      })
    },
    runtimeNotifier: {
      notifyEntry: vi.fn(async () => {})
    }
  };

  const service = new DynamicsService(dependencies);
  return { service, entriesById, appendedEvents };
}

describe("lifecycle recall feedback", () => {
  it("time-injected retention decay lowers stored activation and recall precomputed rank eligibility", async () => {
    let nowIso = "2025-06-01T00:00:00.000Z";
    const createdAt = "2025-01-01T00:00:00.000Z";
    const { service, entriesById, appendedEvents } = createDecayHarness(() => nowIso);

    entriesById.set(
      "memory-decay",
      createMemoryEntry({
        object_id: "memory-decay",
        created_at: createdAt,
        updated_at: createdAt,
        storage_tier: StorageTier.HOT,
        last_used_at: "2025-06-01T00:00:00.000Z",
        last_hit_at: "2025-06-01T00:00:00.000Z"
      })
    );

    await service.processKarmaEvent(
      createKarmaEvent({
        kind: "reuse_gain",
        object_id: "memory-decay",
        created_at: nowIso
      })
    );

    const beforeActivation = entriesById.get("memory-decay")!.activation_score ?? 0;
    const coarseFilter = {
      precomputed_rank: { min_activation_score: beforeActivation - 0.01 }
    } as RecallPolicy["coarse_filter"];
    expect(matchesPrecomputedRankFilter(entriesById.get("memory-decay")!, coarseFilter)).toBe(true);

    nowIso = "2026-07-01T00:00:00.000Z";
    const result = await service.scanRetentionDecay("workspace-1");

    expect(result.updated_count).toBe(1);
    const updated = entriesById.get("memory-decay");
    expect(updated).toBeDefined();
    expect(updated!.activation_score).toBeLessThan(beforeActivation);
    expect(matchesPrecomputedRankFilter(updated!, coarseFilter)).toBe(false);
    expect(
      appendedEvents.some((entry) => entry.event_type === "soul.memory.retention_updated")
    ).toBe(true);
  });
});
