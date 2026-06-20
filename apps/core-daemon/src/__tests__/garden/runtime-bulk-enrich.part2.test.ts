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

  it("the count threshold enqueues a BULK_ENRICH task once the pending count crosses batch_trigger_count (accumulated-count trigger)", async () => {
    const enrichPendingRepo = new FakeEnrichPendingRepo();
    const count = DYNAMICS_CONSTANTS.enrich.batch_trigger_count;
    for (let i = 0; i < count; i += 1) {
      enrichPendingRepo.enqueue("workspace-1", `memory-${i}`);
    }

    const produceForNewMemory = vi.fn<ProduceFn>(async () => undefined);
    const runtime = createGardenRuntime(
      createRuntimeInput({
        enrichPendingRepo,
        findById: vi.fn(async (memoryId: string) => buildMemory(memoryId)),
        produceForNewMemory
      })
    );

    // The 60s GardenScheduler pass both enqueues the threshold-triggered task
    // and dispatches+drains it in the same pass, so the trigger is proven by a
    // reported BULK_ENRICH completion and the pending count draining to zero.
    await getService(runtime, "GardenScheduler").task();

    const completions = currentScheduler().completions.filter(
      (result) => result.task_kind === GardenTaskKind.BULK_ENRICH
    );
    expect(completions).toHaveLength(1);
    expect(completions[0].workspace_id).toBe("workspace-1");
    expect(produceForNewMemory).toHaveBeenCalledTimes(count);
    expect(enrichPendingRepo.countPending("workspace-1")).toBe(0);
  });

  it("below batch_trigger_count the unconditional 60s drain still enriches (S3c I2: ~1-min bound, not held for the threshold)", async () => {
    const enrichPendingRepo = new FakeEnrichPendingRepo();
    const belowThreshold = DYNAMICS_CONSTANTS.enrich.batch_trigger_count - 1;
    for (let i = 0; i < belowThreshold; i += 1) {
      enrichPendingRepo.enqueue("workspace-1", `memory-${i}`);
    }

    const produceForNewMemory = vi.fn<ProduceFn>(async () => undefined);
    const runtime = createGardenRuntime(
      createRuntimeInput({
        enrichPendingRepo,
        findById: vi.fn(async (memoryId: string) => buildMemory(memoryId)),
        produceForNewMemory
      })
    );

    // The count-threshold trigger would NOT fire below batch_trigger_count, but
    // the unconditional per-workspace drain (now on the 60s pass) does — exactly
    // one BULK_ENRICH cycle, draining the below-threshold backlog. The threshold
    // trigger does not also stack a second task (the already-queued guard).
    await getService(runtime, "GardenScheduler").task();

    expect(
      currentScheduler().completions.filter(
        (result) => result.task_kind === GardenTaskKind.BULK_ENRICH
      )
    ).toHaveLength(1);
    expect(produceForNewMemory).toHaveBeenCalledTimes(belowThreshold);
    expect(enrichPendingRepo.countPending("workspace-1")).toBe(0);
  });

  it("an empty workspace enqueues no BULK_ENRICH on the 60s pass (countPending>0 guard keeps the all-workspace check near-free)", async () => {
    const enrichPendingRepo = new FakeEnrichPendingRepo();
    const produceForNewMemory = vi.fn<ProduceFn>(async () => undefined);
    const runtime = createGardenRuntime(
      createRuntimeInput({
        enrichPendingRepo,
        findById: vi.fn(async (memoryId: string) => buildMemory(memoryId)),
        produceForNewMemory,
        workspaceIds: ["workspace-1", "workspace-2"]
      })
    );

    await getService(runtime, "GardenScheduler").task();

    expect(
      currentScheduler().queue.filter((task) => task.task_kind === GardenTaskKind.BULK_ENRICH)
    ).toHaveLength(0);
    expect(
      currentScheduler().completions.filter(
        (result) => result.task_kind === GardenTaskKind.BULK_ENRICH
      )
    ).toHaveLength(0);
    expect(produceForNewMemory).not.toHaveBeenCalled();
  });

  it("does not enqueue BULK_ENRICH when no enrichment service is wired (enrichment disabled)", async () => {
    const enrichPendingRepo = new FakeEnrichPendingRepo();
    enrichPendingRepo.enqueue("workspace-1", "memory-1");

    const runtime = createGardenRuntime(
      createRuntimeInput({
        enrichPendingRepo,
        findById: vi.fn(async (memoryId: string) => buildMemory(memoryId)),
        // no produceForNewMemory and no detectAndLinkConflicts -> disabled
        omitEnrichmentServices: true
      })
    );

    await getService(runtime, "Librarian").task();

    expect(
      currentScheduler().queue.filter((task) => task.task_kind === GardenTaskKind.BULK_ENRICH)
    ).toHaveLength(0);
  });

  it("the unconditional per-workspace drain runs on the ~60s GardenScheduler pass and skips empty workspaces", async () => {
    const enrichPendingRepo = new FakeEnrichPendingRepo();
    enrichPendingRepo.enqueue("workspace-1", "memory-1");
    // workspace-2 has no pending row -> the near-free countPending>0 guard skips it.
    const produceForNewMemory = vi.fn<ProduceFn>(async () => undefined);
    const runtime = createGardenRuntime(
      createRuntimeInput({
        enrichPendingRepo,
        findById: vi.fn(async (memoryId: string) => buildMemory(memoryId)),
        produceForNewMemory,
        workspaceIds: ["workspace-1", "workspace-2"]
      })
    );

    // A single 60s pass enqueues the drain for the pending workspace, dispatches
    // it, and drains it — no Librarian (15-min) pass needed. The ~1-min bound.
    await getService(runtime, "GardenScheduler").task();

    const completions = currentScheduler().completions.filter(
      (result) => result.task_kind === GardenTaskKind.BULK_ENRICH
    );
    expect(completions.map((result) => result.workspace_id)).toEqual(["workspace-1"]);
    expect(produceForNewMemory).toHaveBeenCalledTimes(1);
    expect(enrichPendingRepo.countPending("workspace-1")).toBe(0);
  });

  it("B1 closure: a claim stranded by a crash (no markProcessed) is reclaimed by the scheduler pass and re-drains", async () => {
    const enrichPendingRepo = new FakeEnrichPendingRepo();
    enrichPendingRepo.enqueue("workspace-1", "memory-stranded");

    const produceForNewMemory = vi.fn<ProduceFn>(async () => undefined);
    const detectAndLinkConflicts = vi.fn<DetectFn>(async () => undefined);
    const runtime = createGardenRuntime(
      createRuntimeInput({
        enrichPendingRepo,
        findById: vi.fn(async (memoryId: string) => buildMemory(memoryId)),
        produceForNewMemory,
        detectAndLinkConflicts
      })
    );

    // Simulate a worker that claimed the row and then crashed before
    // markProcessed: claimed_at is set far enough in the past to be past the
    // claim_stale_after_ms TTL. The row is now NOT claimable (claimed_at set)
    // and would be stranded forever without reclaim.
    enrichPendingRepo.claimBatch(
      "workspace-1",
      50,
      "2020-01-01T00:00:00.000Z",
      DYNAMICS_CONSTANTS.enrich.max_attempts
    );
    enrichPendingRepo.simulateStrandedClaim(
      "workspace-1",
      "memory-stranded",
      "2020-01-01T00:00:00.000Z"
    );
    expect(
      enrichPendingRepo.claimBatch(
        "workspace-1",
        50,
        new Date().toISOString(),
        DYNAMICS_CONSTANTS.enrich.max_attempts
      )
    ).toHaveLength(0);
    // I1 guard: countPending still sees the stranded (unprocessed) row, so the
    // count-threshold path would otherwise busy-loop on a row it can never claim.
    expect(enrichPendingRepo.countPending("workspace-1")).toBe(1);

    // The 60s GardenScheduler pass reclaims the stale claim (claim_stale_after_ms
    // past), enqueues + dispatches a BULK_ENRICH, and the previously stranded row
    // is now drained: enrichment is not silently lost on a daemon crash/restart.
    await getService(runtime, "GardenScheduler").task();

    expect(produceForNewMemory).toHaveBeenCalledTimes(1);
    expect(produceForNewMemory.mock.calls[0][0].newMemoryId).toBe("memory-stranded");
    expect(detectAndLinkConflicts).toHaveBeenCalledTimes(1);
    expect(enrichPendingRepo.countPending("workspace-1")).toBe(0);
  });

  it("B1: a fresh claim younger than the TTL is NOT reclaimed (a live in-flight cycle is never pulled out from under itself)", async () => {
    const enrichPendingRepo = new FakeEnrichPendingRepo();
    enrichPendingRepo.enqueue("workspace-1", "memory-1");
    const runtime = createGardenRuntime(
      createRuntimeInput({
        enrichPendingRepo,
        findById: vi.fn(async (memoryId: string) => buildMemory(memoryId)),
        produceForNewMemory: vi.fn<ProduceFn>(async () => undefined)
      })
    );
    void runtime;

    // Claim with a fresh (now) timestamp, then reclaim with the production TTL.
    enrichPendingRepo.claimBatch(
      "workspace-1",
      50,
      new Date().toISOString(),
      DYNAMICS_CONSTANTS.enrich.max_attempts
    );
    const reclaimed = enrichPendingRepo.reclaimStale(
      new Date().toISOString(),
      DYNAMICS_CONSTANTS.enrich.claim_stale_after_ms
    );
    expect(reclaimed).toBe(0);
    // Still in-flight (claimed), so a re-claim finds nothing.
    expect(
      enrichPendingRepo.claimBatch(
        "workspace-1",
        50,
        new Date().toISOString(),
        DYNAMICS_CONSTANTS.enrich.max_attempts
      )
    ).toHaveLength(0);
  });

  it("workspace-targeted bulk-enrich no-ops for fresh in-flight claims", async () => {
    const enrichPendingRepo = new FakeEnrichPendingRepo();
    enrichPendingRepo.enqueue("workspace-1", "memory-1");
    const produceForNewMemory = vi.fn<ProduceFn>(async () => undefined);
    const runtime = createGardenRuntime(
      createRuntimeInput({
        enrichPendingRepo,
        findById: vi.fn(async (memoryId: string) => buildMemory(memoryId)),
        produceForNewMemory
      })
    );

    enrichPendingRepo.claimBatch(
      "workspace-1",
      50,
      new Date().toISOString(),
      DYNAMICS_CONSTANTS.enrich.max_attempts
    );

    await runtime.runBulkEnrichPass("workspace-1");

    expect(produceForNewMemory).not.toHaveBeenCalled();
    expect(currentScheduler().completions).toHaveLength(0);
    expect(currentScheduler().queue).toHaveLength(0);
    expect(enrichPendingRepo.countPending("workspace-1")).toBe(1);
    expect(
      enrichPendingRepo.claimBatch(
        "workspace-1",
        50,
        new Date().toISOString(),
        DYNAMICS_CONSTANTS.enrich.max_attempts
      )
    ).toHaveLength(0);
  });
});
