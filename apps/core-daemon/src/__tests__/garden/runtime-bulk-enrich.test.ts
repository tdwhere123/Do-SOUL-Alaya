import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DYNAMICS_CONSTANTS,
  GardenTaskKind,
  type GardenTaskDescriptor,
  type GardenTaskResult,
  type GardenTierValue
} from "@do-soul/alaya-protocol";

import type { BackgroundServiceConfig } from "../../background/bootstrap.js";

import {
  FakeEnrichPendingRepo,
  buildMemory,
  buildSignal,
  bulkEnrichTask,
  createGardenDataPorts,
  createRuntimeInput,
  type DetectFn,
  type ProduceFn,
  type ReplaySignalRefsFn,
  type SourceSignalLookupFn
} from "./runtime-bulk-enrich-fixture.js";

// invariant: BULK_ENRICH drain worker test (S3c). Pins that the Garden claims
// enrich_pending rows, runs both governed enrichment services per memory, marks
// them processed, is idempotent on a re-drain, and is triggered by BOTH the
// periodic Librarian pass (bulk-import-complete style: enqueue for all
// workspaces) AND the accumulated-count threshold (OQ5).
// see also: apps/core-daemon/src/garden/runtime.ts runBulkEnrichTask
// see also: packages/storage/src/repos/enrich-pending-repo.ts
const hoisted = vi.hoisted(() => {
  const schedulers: Array<FakeGardenScheduler> = [];
  const tierOrder: Record<GardenTierValue, number> = { tier_0: 0, tier_1: 1, tier_2: 2 };
  const roleTier: Record<string, GardenTierValue> = {
    janitor: "tier_0",
    auditor: "tier_1",
    librarian: "tier_2"
  };

  class FakeGardenScheduler {
    public readonly queue: GardenTaskDescriptor[] = [];
    public readonly completions: GardenTaskResult[] = [];

    public constructor() {
      schedulers.push(this);
    }

    public enqueue(descriptor: GardenTaskDescriptor): void {
      this.queue.push(descriptor);
    }

    public async dispatchNextMatchingTaskKind(
      role: string,
      taskKinds: readonly string[],
      workspaceId?: string
    ): Promise<GardenTaskDescriptor | null> {
      const roleTierValue = roleTier[role] ?? "tier_0";
      const taskIndex = this.queue.findIndex(
        (task) =>
          taskKinds.includes(task.task_kind) &&
          tierOrder[task.required_tier] <= tierOrder[roleTierValue] &&
          (workspaceId === undefined || task.workspace_id === workspaceId)
      );
      if (taskIndex < 0) {
        return null;
      }
      const [task] = this.queue.splice(taskIndex, 1);
      return task ?? null;
    }

    public async reportCompletion(result: GardenTaskResult): Promise<void> {
      this.completions.push(result);
    }

    public getBacklogSnapshot() {
      return {
        workspace_id: null,
        observed_at: "2026-05-30T12:00:00.000Z",
        queue_depth_total: this.queue.length,
        queue_depth_by_tier: { tier_0: 0, tier_1: 0, tier_2: this.queue.length } as Record<
          GardenTierValue,
          number
        >,
        in_flight_total: 0,
        warning_active: false
      };
    }

    public peekBacklogWarningTransition(): null {
      return null;
    }

    public peekLastBacklogWarningTransitionId(): null {
      return null;
    }

    public acknowledgeBacklogWarningTransition(): boolean {
      return false;
    }
  }

  return { FakeGardenScheduler, schedulers };
});

vi.mock("@do-soul/alaya-soul", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@do-soul/alaya-soul")>();
  return {
    ...actual,
    GardenScheduler: hoisted.FakeGardenScheduler
  };
});

import { createGardenRuntime } from "../../garden/runtime.js";

type Runtime = ReturnType<typeof createGardenRuntime>;

async function dispatchBulkEnrich(runtime: Runtime): Promise<void> {
  currentScheduler().enqueue(bulkEnrichTask());
  await getService(runtime, "GardenScheduler").task();
}

function currentScheduler(): InstanceType<typeof hoisted.FakeGardenScheduler> {
  const scheduler = hoisted.schedulers[0];
  if (scheduler === undefined) {
    throw new Error("GardenScheduler was not constructed.");
  }
  return scheduler;
}

function getService(runtime: Runtime, name: string): BackgroundServiceConfig {
  const services = (
    runtime.backgroundManager as unknown as { readonly services: readonly BackgroundServiceConfig[] }
  ).services;
  const service = services.find((candidate) => candidate.name === name);
  if (service === undefined) {
    throw new Error(`Missing background service ${name}.`);
  }
  return service;
}

describe("garden runtime BULK_ENRICH drain worker", () => {

  beforeEach(() => {
    hoisted.schedulers.splice(0, hoisted.schedulers.length);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("drains claimed pending rows: invokes detectAndLinkConflicts + produceForNewMemory per memory and marks processed", async () => {
    const enrichPendingRepo = new FakeEnrichPendingRepo();
    enrichPendingRepo.enqueue("workspace-1", "memory-1");
    enrichPendingRepo.enqueue("workspace-1", "memory-2");

    const produceForNewMemory = vi.fn<ProduceFn>(async () => undefined);
    const detectAndLinkConflicts = vi.fn<DetectFn>(async () => undefined);
    const findById = vi.fn(async (memoryId: string) => buildMemory(memoryId));

    const runtime = createGardenRuntime(
      createRuntimeInput({
        enrichPendingRepo,
        findById,
        produceForNewMemory,
        detectAndLinkConflicts
      })
    );

    await dispatchBulkEnrich(runtime);

    expect(findById).toHaveBeenCalledTimes(2);
    expect(produceForNewMemory).toHaveBeenCalledTimes(2);
    expect(detectAndLinkConflicts).toHaveBeenCalledTimes(2);
    expect(produceForNewMemory.mock.calls.map((call) => call[0].newMemoryId).sort()).toEqual([
      "memory-1",
      "memory-2"
    ]);
    // detectAndLinkConflicts reconstructs the conflict-scan params from the
    // persisted memory row, not from a re-passed signal.
    expect(detectAndLinkConflicts.mock.calls[0][0]).toMatchObject({
      newMemoryDimension: "fact",
      newMemoryContent: "content-for-memory-1"
    });
    expect(enrichPendingRepo.countPending("workspace-1")).toBe(0);
  });

  it("is idempotent: a re-drain after processing claims nothing and re-invokes no service", async () => {
    const enrichPendingRepo = new FakeEnrichPendingRepo();
    enrichPendingRepo.enqueue("workspace-1", "memory-1");

    const produceForNewMemory = vi.fn(async () => undefined);
    const detectAndLinkConflicts = vi.fn(async () => undefined);
    const runtime = createGardenRuntime(
      createRuntimeInput({
        enrichPendingRepo,
        findById: vi.fn(async (memoryId: string) => buildMemory(memoryId)),
        produceForNewMemory,
        detectAndLinkConflicts
      })
    );

    await dispatchBulkEnrich(runtime);
    expect(produceForNewMemory).toHaveBeenCalledTimes(1);

    // A second dispatch with a freshly enqueued BULK_ENRICH task finds nothing
    // claimable — the processed marker prevents a duplicate enrichment.
    currentScheduler().enqueue(bulkEnrichTask());
    await dispatchBulkEnrich(runtime);
    expect(produceForNewMemory).toHaveBeenCalledTimes(1);
    expect(detectAndLinkConflicts).toHaveBeenCalledTimes(1);
  });

  it("deletes a stale row whose memory no longer exists without invoking enrichment", async () => {
    const enrichPendingRepo = new FakeEnrichPendingRepo();
    enrichPendingRepo.enqueue("workspace-1", "memory-gone");

    const produceForNewMemory = vi.fn(async () => undefined);
    const runtime = createGardenRuntime(
      createRuntimeInput({
        enrichPendingRepo,
        findById: vi.fn(async () => null),
        produceForNewMemory
      })
    );

    await dispatchBulkEnrich(runtime);

    expect(produceForNewMemory).not.toHaveBeenCalled();
    expect(enrichPendingRepo.countPending("workspace-1")).toBe(0);
  });

  it("the Librarian (15-min) pass no longer enqueues BULK_ENRICH — the cadence moved to the 60s pass", async () => {
    const enrichPendingRepo = new FakeEnrichPendingRepo();
    enrichPendingRepo.enqueue("workspace-1", "memory-1");
    enrichPendingRepo.enqueue("workspace-2", "memory-2");
    const runtime = createGardenRuntime(
      createRuntimeInput({
        enrichPendingRepo,
        findById: vi.fn(async (memoryId: string) => buildMemory(memoryId)),
        produceForNewMemory: vi.fn(async () => undefined),
        workspaceIds: ["workspace-1", "workspace-2"]
      })
    );

    // The unconditional drain moved off the 15-min Librarian pass to the 60s
    // GardenScheduler pass to bound the conflict-suppression window to ~1 min.
    await getService(runtime, "Librarian").task();
    expect(
      currentScheduler().queue.filter((task) => task.task_kind === GardenTaskKind.BULK_ENRICH)
    ).toHaveLength(0);
  });

  it("the 60s pass enqueues AND drains a BULK_ENRICH for every workspace with pending rows in one pass", async () => {
    const enrichPendingRepo = new FakeEnrichPendingRepo();
    enrichPendingRepo.enqueue("workspace-1", "memory-1");
    enrichPendingRepo.enqueue("workspace-2", "memory-2");
    const runtime = createGardenRuntime(
      createRuntimeInput({
        enrichPendingRepo,
        findById: vi.fn(async (memoryId: string) => buildMemory(memoryId)),
        produceForNewMemory: vi.fn(async () => undefined),
        workspaceIds: ["workspace-1", "workspace-2"]
      })
    );

    // A single 60s pass enqueues a per-workspace BULK_ENRICH for BOTH
    // pending workspaces AND drains every one of them in the bounded drain loop
    // (not one-per-pass), so a multi-workspace backlog clears within the ~1-min
    // bound. Proven by completion for both workspaces and pending draining to 0.
    await getService(runtime, "GardenScheduler").task();

    const completedWorkspaces = currentScheduler()
      .completions.filter((result) => result.task_kind === GardenTaskKind.BULK_ENRICH)
      .map((result) => result.workspace_id)
      .sort();
    expect(completedWorkspaces).toEqual(["workspace-1", "workspace-2"]);
    expect(
      currentScheduler().queue.filter((task) => task.task_kind === GardenTaskKind.BULK_ENRICH)
    ).toHaveLength(0);
    expect(enrichPendingRepo.countPending("workspace-1")).toBe(0);
    expect(enrichPendingRepo.countPending("workspace-2")).toBe(0);
  });

  // invariant: the ~60s pass drains EVERY BULK_ENRICH
  // queued in the pass, bounded by the per-pass cap, so N workspaces' pending
  // enrichment all clears in a single pass (up to the cap) rather than O(N)
  // passes. This pins the now-true ~1-min bound under a multi-workspace backlog.
  it("N workspaces' BULK_ENRICH all drain within a single scheduler pass (up to the cap)", async () => {
    const enrichPendingRepo = new FakeEnrichPendingRepo();
    const workspaceIds = Array.from({ length: 10 }, (_unused, index) => `workspace-${index + 1}`);
    for (const workspaceId of workspaceIds) {
      enrichPendingRepo.enqueue(workspaceId, `memory-${workspaceId}`);
    }
    const produceForNewMemory = vi.fn<ProduceFn>(async () => undefined);
    const runtime = createGardenRuntime(
      createRuntimeInput({
        enrichPendingRepo,
        findById: vi.fn(async (memoryId: string) =>
          buildMemory(memoryId, memoryId.replace("memory-", ""))
        ),
        produceForNewMemory,
        workspaceIds
      })
    );

    await getService(runtime, "GardenScheduler").task();

    const completedWorkspaces = currentScheduler()
      .completions.filter((result) => result.task_kind === GardenTaskKind.BULK_ENRICH)
      .map((result) => result.workspace_id)
      .sort();
    expect(completedWorkspaces).toEqual([...workspaceIds].sort());
    expect(
      currentScheduler().queue.filter((task) => task.task_kind === GardenTaskKind.BULK_ENRICH)
    ).toHaveLength(0);
    for (const workspaceId of workspaceIds) {
      expect(enrichPendingRepo.countPending(workspaceId)).toBe(0);
    }
    expect(produceForNewMemory).toHaveBeenCalledTimes(workspaceIds.length);
  });

  it("workspace-targeted bulk-enrich drain leaves sibling workspaces untouched", async () => {
    const enrichPendingRepo = new FakeEnrichPendingRepo();
    enrichPendingRepo.enqueue("workspace-A", "memory-A");
    const produceForNewMemory = vi.fn<ProduceFn>(async () => undefined);
    const runtime = createGardenRuntime(
      createRuntimeInput({
        enrichPendingRepo,
        findById: vi.fn(async (memoryId: string) =>
          buildMemory(memoryId, memoryId.replace("memory-", "workspace-"))
        ),
        produceForNewMemory,
        workspaceIds: ["workspace-A", "workspace-B"]
      })
    );
    currentScheduler().enqueue({
      ...bulkEnrichTask(),
      task_id: "bulk-workspace-B",
      workspace_id: "workspace-B",
      target_object_refs: ["workspace-B"]
    });

    await runtime.runBulkEnrichPass("workspace-A");

    expect(produceForNewMemory).toHaveBeenCalledTimes(1);
    expect(enrichPendingRepo.countPending("workspace-A")).toBe(0);
    expect(runtime.getStatus().last_pass_at).toBeNull();
    expect(currentScheduler().completions).toHaveLength(0);
    expect(
      currentScheduler()
        .queue.filter((task) => task.task_kind === GardenTaskKind.BULK_ENRICH)
        .map((task) => task.workspace_id)
    ).toEqual(["workspace-B"]);
  });

  it("workspace-targeted bulk-enrich does not reclaim stale sibling claims", async () => {
    const enrichPendingRepo = new FakeEnrichPendingRepo();
    enrichPendingRepo.enqueue("workspace-A", "memory-A");
    enrichPendingRepo.enqueue("workspace-B", "memory-B");
    enrichPendingRepo.simulateStrandedClaim(
      "workspace-B",
      "memory-B",
      "2020-01-01T00:00:00.000Z"
    );
    const produceForNewMemory = vi.fn<ProduceFn>(async () => undefined);
    const runtime = createGardenRuntime(
      createRuntimeInput({
        enrichPendingRepo,
        findById: vi.fn(async (memoryId: string) =>
          buildMemory(memoryId, memoryId.replace("memory-", "workspace-"))
        ),
        produceForNewMemory,
        workspaceIds: ["workspace-A", "workspace-B"]
      })
    );

    await runtime.runBulkEnrichPass("workspace-A");

    expect(produceForNewMemory.mock.calls.map((call) => call[0].newMemoryId)).toEqual([
      "memory-A"
    ]);
    expect(
      enrichPendingRepo.claimBatch(
        "workspace-B",
        50,
        new Date().toISOString(),
        DYNAMICS_CONSTANTS.enrich.max_attempts
      )
    ).toHaveLength(0);
    expect(enrichPendingRepo.countPending("workspace-B")).toBe(1);
    expect(currentScheduler().completions).toHaveLength(0);
  });
});
