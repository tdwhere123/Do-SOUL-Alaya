import { describe, expect, it, vi } from "vitest";
import {
  GardenTaskKind,
  GardenTier,
  type GardenTaskDescriptor,
  type GardenTaskKindValue
} from "@do-soul/alaya-protocol";
import { JANITOR_CONSTANTS, Janitor } from "../garden/janitor.js";

describe("Janitor GC task kinds", () => {
  it("runs dormant demotion through its port and reports completion", async () => {
    const dormantDemotionPort = {
      findLowActivityActiveMemories: vi.fn(async () => [{ memory_id: "memory-1" }, { memory_id: "memory-2" }]),
      setLifecycleDormant: vi.fn(async () => undefined)
    };
    const scheduler = {
      reportCompletion: vi.fn(async () => undefined)
    };
    const janitor = new Janitor({
      cleanupPort: {
        findExpiredObjects: vi.fn(async () => []),
        removeExpiredObjects: vi.fn(async () => undefined)
      },
      tieringPort: {
        findHotDemotionCandidates: vi.fn(async () => []),
        demoteToWarm: vi.fn(async () => undefined)
      },
      dormantDemotionPort,
      scheduler,
      now: () => "2026-03-28T00:00:00.000Z"
    } as ConstructorParameters<typeof Janitor>[0]);

    const result = await janitor.run(createTask(GardenTaskKind.DORMANT_DEMOTION));

    expect(dormantDemotionPort.findLowActivityActiveMemories).toHaveBeenCalledWith("workspace-1");
    expect(dormantDemotionPort.setLifecycleDormant).toHaveBeenCalledTimes(2);
    expect(result.audit_entries).toEqual(["dormant_demotion: 2 memories transitioned to lifecycle_state=dormant"]);
    expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
  });

  it("runs tombstone gc through its port and respects batch size", async () => {
    const tombstoneGcPort = {
      findTombstonedMemories: vi.fn(
        async () =>
          Array.from({ length: JANITOR_CONSTANTS.BATCH_SIZE + 3 }, (_, index) => ({
            memory_id: `memory-${index + 1}`
          }))
      ),
      hardDelete: vi.fn(async () => undefined)
    };
    const janitor = new Janitor({
      cleanupPort: {
        findExpiredObjects: vi.fn(async () => []),
        removeExpiredObjects: vi.fn(async () => undefined)
      },
      tieringPort: {
        findHotDemotionCandidates: vi.fn(async () => []),
        demoteToWarm: vi.fn(async () => undefined)
      },
      tombstoneGcPort,
      scheduler: {
        reportCompletion: vi.fn(async () => undefined)
      },
      now: () => "2026-03-28T00:00:00.000Z"
    } as ConstructorParameters<typeof Janitor>[0]);

    const result = await janitor.run(createTask("tombstone_gc"));

    expect(tombstoneGcPort.hardDelete).toHaveBeenCalledTimes(JANITOR_CONSTANTS.BATCH_SIZE);
    expect(result.objects_affected).toHaveLength(JANITOR_CONSTANTS.BATCH_SIZE);
    expect(result.audit_entries).toEqual([
      `tombstone_gc: ${JANITOR_CONSTANTS.BATCH_SIZE} tombstoned memories hard-deleted`
    ]);
  });

  it("skips tombstone gc deletions for strong-ref protected memories", async () => {
    const tombstoneGcPort = {
      findTombstonedMemories: vi.fn(async () => [{ memory_id: "memory-1" }, { memory_id: "memory-2" }]),
      hardDelete: vi.fn(async () => undefined)
    };
    const strongRefProtectionPort = {
      isProtected: vi.fn(async (_workspaceId: string, _targetEntityType: string, targetEntityId: string) => targetEntityId === "memory-1")
    };
    const janitor = new Janitor({
      cleanupPort: {
        findExpiredObjects: vi.fn(async () => []),
        removeExpiredObjects: vi.fn(async () => undefined)
      },
      tieringPort: {
        findHotDemotionCandidates: vi.fn(async () => []),
        demoteToWarm: vi.fn(async () => undefined)
      },
      tombstoneGcPort,
      strongRefProtectionPort,
      scheduler: {
        reportCompletion: vi.fn(async () => undefined)
      },
      now: () => "2026-03-28T00:00:00.000Z"
    } as ConstructorParameters<typeof Janitor>[0]);

    const result = await janitor.run(createTask("tombstone_gc"));

    expect(strongRefProtectionPort.isProtected).toHaveBeenCalledTimes(2);
    expect(tombstoneGcPort.hardDelete).toHaveBeenCalledTimes(1);
    expect(tombstoneGcPort.hardDelete).toHaveBeenCalledWith("memory-2", "task-1");
    expect(result.objects_affected).toEqual(["memory-2"]);
    expect(result.audit_entries).toEqual([
      "[SKIPPED] tombstone_gc: memory-1 protected by strong ref",
      "tombstone_gc: 1 tombstoned memories hard-deleted"
    ]);
  });
});

function createTask(taskKind: GardenTaskKindValue | "tombstone_gc"): GardenTaskDescriptor {
  return {
    task_id: "task-1",
    task_kind: taskKind as GardenTaskKindValue,
    required_tier: GardenTier.TIER_0,
    workspace_id: "workspace-1",
    run_id: null,
    target_object_refs: [],
    priority: 10,
    created_at: "2026-03-28T00:00:00.000Z"
  };
}
