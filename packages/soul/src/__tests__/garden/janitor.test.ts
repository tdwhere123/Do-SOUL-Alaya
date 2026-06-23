import { describe, expect, it, vi } from "vitest";
import { GardenRole, GardenTaskKind, GardenTier, GardenEventType, type GardenTaskDescriptor } from "@do-soul/alaya-protocol";
import {
  JANITOR_CONSTANTS,
  Janitor,
  type ExpiredControlPlaneObject,
  type HotDemotionCandidate
} from "../../garden/janitor.js";
import { GardenScheduler } from "../../garden/scheduler.js";

describe("Janitor", () => {
  it("exposes the janitor role and tier", () => {
    const janitor = createJanitor().janitor;

    expect(janitor.role).toBe("janitor");
    expect(janitor.tier).toBe("tier_0");
  });

  it("runs ttl cleanup, removes expired ids, and reports completion", async () => {
    const { cleanupPort, scheduler, janitor } = createJanitor({
      expiredObjects: [
        { object_kind: "handoff_record", object_id: "handoff-1", expires_at: "2026-03-20T00:00:00.000Z" },
        { object_kind: "gap_record", object_id: "gap-1", expires_at: "2026-03-21T00:00:00.000Z" }
      ]
    });

    const result = await janitor.run(createTask({ task_kind: GardenTaskKind.TTL_CLEANUP }));

    expect(cleanupPort.findExpiredObjects).toHaveBeenCalledWith("workspace-1", "2026-03-27T00:00:00.000Z");
    expect(cleanupPort.removeExpiredObjects).toHaveBeenCalledWith("workspace-1", ["handoff-1", "gap-1"]);
    expect(result).toMatchObject({
      success: true,
      objects_affected: ["handoff-1", "gap-1"],
      audit_entries: ["ttl_cleanup: removed 2 expired objects in workspace-1"]
    });
    expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
  });

  it("does not remove anything when ttl cleanup finds no expired objects", async () => {
    const { cleanupPort, scheduler, janitor } = createJanitor();

    const result = await janitor.run(createTask({ task_kind: GardenTaskKind.TTL_CLEANUP }));

    expect(cleanupPort.removeExpiredObjects).not.toHaveBeenCalled();
    expect(result.objects_affected).toEqual([]);
    expect(result.success).toBe(true);
    expect(result.audit_entries).toEqual(["ttl_cleanup: removed 0 expired objects in workspace-1"]);
    expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
  });

  it("limits ttl cleanup to the first batch of expired objects", async () => {
    const expiredObjects = Array.from({ length: JANITOR_CONSTANTS.BATCH_SIZE + 5 }, (_, index) => ({
      object_kind: "session_override",
      object_id: `expired-${index + 1}`,
      expires_at: "2026-03-20T00:00:00.000Z"
    }));
    const { cleanupPort, janitor } = createJanitor({ expiredObjects });

    const result = await janitor.run(createTask({ task_kind: GardenTaskKind.TTL_CLEANUP }));

    expect(cleanupPort.removeExpiredObjects).toHaveBeenCalledWith(
      "workspace-1",
      expiredObjects.slice(0, JANITOR_CONSTANTS.BATCH_SIZE).map((entry) => entry.object_id)
    );
    expect(result.objects_affected).toHaveLength(JANITOR_CONSTANTS.BATCH_SIZE);
  });

  it("runs hot index demotion with threshold criteria and demotes candidate ids", async () => {
    const { tieringPort, scheduler, janitor } = createJanitor({
      hotCandidates: [
        { memory_entry_id: "memory-1", last_access_at: "2026-03-10T00:00:00.000Z", activation_score: 0.1 },
        { memory_entry_id: "memory-2", last_access_at: "2026-03-11T00:00:00.000Z", activation_score: 0.2 }
      ]
    });

    const result = await janitor.run(createTask({ task_kind: GardenTaskKind.HOT_INDEX_DEMOTION }));

    expect(tieringPort.findHotDemotionCandidates).toHaveBeenCalledWith("workspace-1", {
      maxLastHitAgeMs: JANITOR_CONSTANTS.HOT_DEMOTION_THRESHOLD_MS,
      minActivationScore: JANITOR_CONSTANTS.HOT_DEMOTION_MIN_ACTIVATION
    });
    expect(tieringPort.demoteToWarm).toHaveBeenCalledWith("workspace-1", ["memory-1", "memory-2"]);
    expect(result).toMatchObject({
      success: true,
      objects_affected: ["memory-1", "memory-2"],
      audit_entries: ["hot_index_demotion: demoted 2 entries to cold storage tier in workspace-1"]
    });
    expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
  });

  it("integrates with GardenScheduler and emits dispatch/completion audit events", async () => {
    const eventLog = {
      append: vi.fn(async () => undefined)
    };
    const scheduler = new GardenScheduler(eventLog, {
      now: () => "2026-03-27T00:00:00.000Z"
    });
    const janitor = new Janitor({
      cleanupPort: {
        findExpiredObjects: vi.fn(async () => [{ object_kind: "handoff_record", object_id: "handoff-1", expires_at: "2026-03-20T00:00:00.000Z" }]),
        removeExpiredObjects: vi.fn(async () => undefined)
      },
      tieringPort: {
        findHotDemotionCandidates: vi.fn(async () => []),
        demoteToWarm: vi.fn(async () => undefined)
      },
      scheduler,
      now: () => "2026-03-27T00:00:00.000Z"
    });
    scheduler.enqueue(createTask({ task_id: "task-janitor", task_kind: GardenTaskKind.TTL_CLEANUP }));

    const dispatched = await scheduler.dispatchNext(GardenRole.JANITOR);
    const result = await janitor.run(dispatched as GardenTaskDescriptor);

    expect(result.success).toBe(true);
    expect(eventLog.append).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        event_type: GardenEventType.SOUL_GARDEN_TASK_DISPATCHED,
        entity_id: "task-janitor"
      })
    );
    expect(eventLog.append).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        event_type: GardenEventType.SOUL_GARDEN_TASK_COMPLETED,
        entity_id: "task-janitor"
      })
    );
  });

  // Hot-index demotion commits one SOUL_MEMORY_TIER_CHANGED audit row
  // per demoted entry inside the same SQLite transaction as the
  // storage_tier UPDATE.
  it("emits SOUL_MEMORY_TIER_CHANGED for each demoted entry alongside the demote", async () => {
    const appendManyWithMutation = vi.fn(async (entries: readonly unknown[], mutate: (rows: readonly unknown[]) => unknown) => {
      const persisted = entries.map((entry, idx) => ({
        ...(entry as object),
        event_id: `evt-${idx}`,
        created_at: "2026-03-27T00:00:00.000Z",
        revision: idx
      }));
      mutate(persisted);
      return undefined;
    });
    const eventLogRepo = {
      append: vi.fn(),
      appendManyWithMutation
    };
    const tieringPort = {
      findHotDemotionCandidates: vi.fn(async () => [
        { memory_entry_id: "memory-1", last_access_at: null, activation_score: 0.1 },
        { memory_entry_id: "memory-2", last_access_at: null, activation_score: 0.2 }
      ]),
      demoteToWarm: vi.fn(() => undefined)
    };
    const cleanupPort = {
      findExpiredObjects: vi.fn(async () => []),
      removeExpiredObjects: vi.fn(async () => undefined)
    };
    const scheduler = { reportCompletion: vi.fn(async () => undefined) };
    const janitor = new Janitor({
      cleanupPort,
      tieringPort,
      scheduler,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      eventLogRepo: eventLogRepo as any,
      now: () => "2026-03-27T00:00:00.000Z"
    });

    await janitor.run(createTask({ task_kind: GardenTaskKind.HOT_INDEX_DEMOTION }));

    expect(appendManyWithMutation).toHaveBeenCalledTimes(1);
    const firstCall = appendManyWithMutation.mock.calls[0] ?? [[], () => undefined];
    const emittedEntries = firstCall[0] as readonly unknown[];
    expect(emittedEntries).toHaveLength(2);
    const eventTypes = (emittedEntries as readonly { readonly event_type: string }[]).map((entry) => entry.event_type);
    expect(eventTypes).toEqual(["soul.memory.tier_changed", "soul.memory.tier_changed"]);
    const payloads = (emittedEntries as readonly { readonly payload_json: { readonly object_id: string; readonly from_tier: string; readonly to_tier: string; readonly reason: string } }[]).map((entry) => entry.payload_json);
    expect(payloads.map((payload) => payload.object_id)).toEqual(["memory-1", "memory-2"]);
    for (const payload of payloads) {
      expect(payload.from_tier).toBe("hot");
      expect(payload.to_tier).toBe("cold");
      expect(payload.reason).toBe("hot_index_demotion");
    }
    expect(tieringPort.demoteToWarm).toHaveBeenCalledWith("workspace-1", ["memory-1", "memory-2"]);
  });

  it("does not demote anything when hot index demotion finds no candidates", async () => {
    const { tieringPort, scheduler, janitor } = createJanitor();

    const result = await janitor.run(createTask({ task_kind: GardenTaskKind.HOT_INDEX_DEMOTION }));

    expect(tieringPort.demoteToWarm).not.toHaveBeenCalled();
    expect(result.objects_affected).toEqual([]);
    expect(result.success).toBe(true);
    expect(result.audit_entries).toEqual([
      "hot_index_demotion: demoted 0 entries to cold storage tier in workspace-1"
    ]);
    expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
  });

  it("limits hot index demotion to the first batch of candidates", async () => {
    const hotCandidates: HotDemotionCandidate[] = Array.from(
      { length: JANITOR_CONSTANTS.BATCH_SIZE + 3 },
      (_, index) => ({
        memory_entry_id: `memory-${index + 1}`,
        last_access_at: "2026-03-01T00:00:00.000Z",
        activation_score: 0.2
      })
    );
    const { tieringPort, janitor } = createJanitor({ hotCandidates });

    const result = await janitor.run(createTask({ task_kind: GardenTaskKind.HOT_INDEX_DEMOTION }));

    expect(tieringPort.demoteToWarm).toHaveBeenCalledWith(
      "workspace-1",
      hotCandidates.slice(0, JANITOR_CONSTANTS.BATCH_SIZE).map((entry) => entry.memory_entry_id)
    );
    expect(result.objects_affected).toHaveLength(JANITOR_CONSTANTS.BATCH_SIZE);
  });

  it("reports failure when a port throws", async () => {
    const failure = new Error("storage unavailable");
    const { scheduler, janitor } = createJanitor({
      findExpiredObjects: vi.fn(async () => {
        throw failure;
      })
    });

    const result = await janitor.run(createTask({ task_kind: GardenTaskKind.TTL_CLEANUP }));

    expect(result).toMatchObject({
      success: false,
      error_message: "storage unavailable",
      objects_affected: [],
      audit_entries: []
    });
    expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
  });

  it("skips dormant demotion when its port is not wired", async () => {
    const { scheduler, janitor } = createJanitor();

    const result = await janitor.run(createTask({ task_kind: GardenTaskKind.DORMANT_DEMOTION }));

    expect(result).toMatchObject({
      task_kind: GardenTaskKind.DORMANT_DEMOTION,
      success: true,
      error_message: null,
      audit_entries: ["[SKIPPED] dormant_demotion: port not wired"]
    });
    expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
  });

  it("warns but still returns the original failure when reportCompletion rejects", async () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    try {
      const taskFailure = new Error("storage unavailable");
      const reportFailure = new Error("scheduler offline");
      const { janitor } = createJanitor({
        findExpiredObjects: vi.fn(async () => {
          throw taskFailure;
        }),
        reportCompletion: vi.fn(async () => {
          throw reportFailure;
        })
      });

      const result = await janitor.run(createTask({ task_kind: GardenTaskKind.TTL_CLEANUP }));

      expect(result).toMatchObject({
        success: false,
        error_message: "storage unavailable",
        objects_affected: [],
        audit_entries: []
      });

      const warnCall = emitWarning.mock.calls.find(
        ([, options]) =>
          typeof options === "object" &&
          options !== null &&
          "code" in options &&
          options.code === "ALAYA_GARDEN_REPORT_COMPLETION_FAILED"
      );
      expect(warnCall).toBeDefined();
      const detail = JSON.parse((warnCall?.[1] as { detail: string }).detail) as Record<string, unknown>;
      expect(detail.task_error).toBe("storage unavailable");
      expect(detail.report_error).toBe("scheduler offline");
    } finally {
      emitWarning.mockRestore();
    }
  });
});

function createJanitor(options: {
  readonly expiredObjects?: readonly ExpiredControlPlaneObject[];
  readonly hotCandidates?: readonly HotDemotionCandidate[];
  readonly findExpiredObjects?: (
    workspaceId: string,
    nowIso: string
  ) => Promise<readonly ExpiredControlPlaneObject[]>;
  readonly reportCompletion?: () => Promise<void>;
} = {}) {
  const cleanupPort = {
    findExpiredObjects:
      options.findExpiredObjects ??
      vi.fn(async () => options.expiredObjects ?? []),
    removeExpiredObjects: vi.fn(async () => undefined)
  };
  const tieringPort = {
    findHotDemotionCandidates: vi.fn(async () => options.hotCandidates ?? []),
    demoteToWarm: vi.fn(async () => undefined)
  };
  const scheduler = {
    reportCompletion: options.reportCompletion ?? vi.fn(async () => undefined)
  };

  return {
    cleanupPort,
    tieringPort,
    scheduler,
    janitor: new Janitor({
      cleanupPort,
      tieringPort,
      scheduler,
      now: () => "2026-03-27T00:00:00.000Z"
    })
  };
}

function createTask(overrides: Partial<GardenTaskDescriptor> = {}): GardenTaskDescriptor {
  return {
    task_id: "task-1",
    task_kind: GardenTaskKind.TTL_CLEANUP,
    required_tier: GardenTier.TIER_0,
    workspace_id: "workspace-1",
    run_id: null,
    target_object_refs: [],
    priority: 10,
    created_at: "2026-03-27T00:00:00.000Z",
    ...overrides
  };
}
