import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CandidateMemorySignal,
  DYNAMICS_CONSTANTS,
  GardenTaskKind,
  type GardenTaskDescriptor,
  type GardenTaskResult,
  type GardenTierValue
} from "@do-soul/alaya-protocol";
import type { BackgroundServiceConfig } from "../../background/bootstrap.js";

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
      taskKinds: readonly string[]
    ): Promise<GardenTaskDescriptor | null> {
      const roleTierValue = roleTier[role] ?? "tier_0";
      const taskIndex = this.queue.findIndex(
        (task) =>
          taskKinds.includes(task.task_kind) &&
          tierOrder[task.required_tier] <= tierOrder[roleTierValue]
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

type GardenRuntimeInput = Parameters<typeof createGardenRuntime>[0];
type Runtime = ReturnType<typeof createGardenRuntime>;
type ProduceFn = NonNullable<GardenRuntimeInput["enrichEdgeProducerPort"]>["produceForNewMemory"];
type DetectFn = NonNullable<
  GardenRuntimeInput["enrichConflictDetectionPort"]
>["detectAndLinkConflicts"];
type ReplaySignalRefsFn = NonNullable<
  GardenRuntimeInput["enrichSignalRefReplayPort"]
>["replaySignalRefs"];
type SourceSignalLookupFn = NonNullable<
  GardenRuntimeInput["enrichSourceSignalLookup"]
>["getById"];

interface PendingRow {
  workspaceId: string;
  memoryId: string;
  runId: string | null;
  sourceSignalId: string | null;
  claimedAt: string | null;
  processed: boolean;
  attemptCount: number;
  abandonedAt: string | null;
}

class FakeEnrichPendingRepo {
  private readonly rows: PendingRow[] = [];
  // Test-only effective claim budget. Models a small claim_batch_size so a
  // poison marker (oldest-first) can starve healthy markers behind it until it
  // dead-letters. null = honor the limit the drain passes (production behavior).
  private budgetCap: number | null = null;

  public setBudgetCap(cap: number | null): void {
    this.budgetCap = cap;
  }

  public enqueue(workspaceId: string, memoryId: string): void {
    const existing = this.rows.find((row) => row.workspaceId === workspaceId && row.memoryId === memoryId);
    if (existing !== undefined && !existing.processed) {
      return;
    }
    if (existing !== undefined) {
      existing.claimedAt = null;
      existing.processed = false;
      existing.attemptCount = 0;
      existing.abandonedAt = null;
      return;
    }
    this.rows.push({
      workspaceId,
      memoryId,
      runId: "run-1",
      sourceSignalId: `signal-${memoryId}`,
      claimedAt: null,
      processed: false,
      attemptCount: 0,
      abandonedAt: null
    });
  }

  // Mirrors the SQL claimable predicate: not processed, not in-flight, not
  // dead-lettered, and under the attempt cap.
  public claimBatch(
    workspaceId: string,
    limit: number,
    claimedAt: string,
    maxAttempts: number
  ): readonly {
    readonly workspaceId: string;
    readonly memoryId: string;
    readonly runId: string | null;
    readonly sourceSignalId: string | null;
  }[] {
    const claimable = this.rows.filter(
      (row) =>
        row.workspaceId === workspaceId &&
        !row.processed &&
        row.claimedAt === null &&
        row.abandonedAt === null &&
        row.attemptCount < maxAttempts
    );
    const effectiveLimit = this.budgetCap === null ? limit : Math.min(limit, this.budgetCap);
    const claimed = claimable.slice(0, effectiveLimit);
    for (const row of claimed) {
      row.claimedAt = claimedAt;
    }
    return claimed.map((row) => ({
      workspaceId: row.workspaceId,
      memoryId: row.memoryId,
      runId: row.runId,
      sourceSignalId: row.sourceSignalId
    }));
  }

  public markProcessed(workspaceId: string, memoryId: string): void {
    const row = this.rows.find((entry) => entry.workspaceId === workspaceId && entry.memoryId === memoryId);
    if (row !== undefined) {
      row.processed = true;
    }
  }

  // Mirrors the SQL recordFailedAttempt transaction: increment under the
  // processed/abandoned guard, then release (under cap) or dead-letter (at cap).
  public recordFailedAttempt(
    workspaceId: string,
    memoryId: string,
    maxAttempts: number,
    abandonedAt: string
  ): { readonly attemptCount: number; readonly abandoned: boolean } {
    const row = this.rows.find((entry) => entry.workspaceId === workspaceId && entry.memoryId === memoryId);
    if (row === undefined || row.processed || row.abandonedAt !== null) {
      return { attemptCount: row?.attemptCount ?? 0, abandoned: false };
    }
    row.attemptCount += 1;
    if (row.attemptCount >= maxAttempts) {
      row.abandonedAt = abandonedAt;
      return { attemptCount: row.attemptCount, abandoned: true };
    }
    row.claimedAt = null;
    return { attemptCount: row.attemptCount, abandoned: false };
  }

  public delete(workspaceId: string, memoryId: string): void {
    const index = this.rows.findIndex(
      (entry) => entry.workspaceId === workspaceId && entry.memoryId === memoryId
    );
    if (index >= 0) {
      this.rows.splice(index, 1);
    }
  }

  public countPending(workspaceId: string): number {
    return this.rows.filter((row) => row.workspaceId === workspaceId && !row.processed).length;
  }

  public reclaimStale(now: string, staleAfterMs: number): number {
    const cutoff = new Date(new Date(now).getTime() - staleAfterMs).toISOString();
    let reclaimed = 0;
    for (const row of this.rows) {
      if (
        row.claimedAt !== null &&
        !row.processed &&
        row.abandonedAt === null &&
        row.claimedAt < cutoff
      ) {
        row.claimedAt = null;
        reclaimed += 1;
      }
    }
    return reclaimed;
  }

  // Test-only: leave a row claimed-but-unprocessed to simulate a worker that
  // crashed between claimBatch and markProcessed.
  public simulateStrandedClaim(workspaceId: string, memoryId: string, claimedAt: string): void {
    const row = this.rows.find((entry) => entry.workspaceId === workspaceId && entry.memoryId === memoryId);
    if (row === undefined) {
      throw new Error(`No enrich_pending row for ${workspaceId}/${memoryId}.`);
    }
    row.claimedAt = claimedAt;
    row.processed = false;
  }
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

  it("the Librarian (15-min) pass no longer enqueues BULK_ENRICH — the cadence moved to the 60s pass (S3c I2)", async () => {
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

  it("the 60s pass enqueues AND drains a BULK_ENRICH for every workspace with pending rows in one pass (S3c I2 + I3)", async () => {
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

    // I3: a single 60s pass enqueues a per-workspace BULK_ENRICH for BOTH
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

  // invariant (codex spine-review I3): the ~60s pass drains EVERY BULK_ENRICH
  // queued in the pass, bounded by the per-pass cap, so N workspaces' pending
  // enrichment all clears in a single pass (up to the cap) rather than O(N)
  // passes. This pins the now-true ~1-min bound under a multi-workspace backlog.
  it("I3: N workspaces' BULK_ENRICH all drain within a single scheduler pass (up to the cap)", async () => {
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

  // invariant (codex spine-review B5): a TRANSIENT path-mint failure must not
  // become a processed enrich row. The governed services surface a transient
  // failure by throwing (produceForNewMemory throws when any submitCandidate
  // returns "failed"; detectAndLinkConflicts with strictNoDrop throws when a
  // candidate query throws or a mint fails transiently). The worker's
  // per-memory catch must record a TRANSIENT failed attempt — never
  // markProcessed — so the owed path is retried (under the cap), and emit NO
  // processed telemetry for the dropped row.
  it("B5: a transient path-mint failure + a conflict-repo throw records a failed attempt, keeps the row pending, and emits no processed telemetry", async () => {
    const enrichPendingRepo = new FakeEnrichPendingRepo();
    enrichPendingRepo.enqueue("workspace-1", "memory-owed");

    const recordFailedAttempt = vi.spyOn(enrichPendingRepo, "recordFailedAttempt");
    const markProcessed = vi.spyOn(enrichPendingRepo, "markProcessed");
    // produceForNewMemory throws as the real EdgeAutoProducerService does when
    // a submitCandidate returns the transient "failed" outcome.
    const produceForNewMemory = vi.fn<ProduceFn>(async () => {
      throw new Error("transient path-mint failure");
    });
    // detectAndLinkConflicts(strictNoDrop) throws as the real
    // ConflictDetectionService does when a candidate query throws.
    const detectAndLinkConflicts = vi.fn<DetectFn>(async () => {
      throw new Error("conflict repo lookup failed");
    });
    const runtime = createGardenRuntime(
      createRuntimeInput({
        enrichPendingRepo,
        findById: vi.fn(async (memoryId: string) => buildMemory(memoryId)),
        produceForNewMemory,
        detectAndLinkConflicts
      })
    );

    await dispatchBulkEnrich(runtime);

    // A single transient failure under the cap increments the attempt counter and
    // releases the claim for retry; the row is NOT processed and remains pending
    // so stale-claim recovery re-drains it. Not dead-lettered.
    expect(recordFailedAttempt).toHaveBeenCalledWith(
      "workspace-1",
      "memory-owed",
      DYNAMICS_CONSTANTS.enrich.max_attempts,
      expect.any(String)
    );
    expect(recordFailedAttempt.mock.results[0]?.value).toMatchObject({ abandoned: false });
    expect(markProcessed).not.toHaveBeenCalled();
    expect(enrichPendingRepo.countPending("workspace-1")).toBe(1);

    // No success/processed telemetry was emitted for the dropped path; the
    // completion audit records the failure, not a processed row, and no abandon.
    const completion = currentScheduler().completions.find(
      (result) => result.task_kind === GardenTaskKind.BULK_ENRICH
    );
    expect(completion?.audit_entries).toContain("bulk_enrich:processed_0");
    expect(completion?.audit_entries).toContain("bulk_enrich:failed_1");
    expect(completion?.audit_entries).toContain("bulk_enrich:abandoned_0");
    expect(
      completion?.audit_entries.some((entry) => entry === "bulk_enrich:processed_1")
    ).toBe(false);
  });

  // invariant (B4-R1): the transient-retry seam is BOUNDED. A sink that ALWAYS
  // throws transient `failed` dead-letters its marker after exactly MAX_ATTEMPTS
  // failed attempts, emits the SOUL_ENRICH_ABANDONED audit event (governance/
  // runtime drops must be auditable), and thereafter STOPS consuming the per-pass
  // claim budget — proven by a healthy marker, starved behind it under a 1-slot
  // budget, draining once the poison marker is dead-lettered.
  it("B4-R1: an always-transient-failing marker dead-letters after MAX_ATTEMPTS, emits SOUL_ENRICH_ABANDONED, and frees the budget for a healthy marker behind it", async () => {
    const enrichPendingRepo = new FakeEnrichPendingRepo();
    enrichPendingRepo.enqueue("workspace-1", "memory-poison");
    enrichPendingRepo.enqueue("workspace-1", "memory-healthy");
    // 1-slot effective budget: the oldest (poison) marker consumes the only slot
    // each claim until it is dead-lettered, starving the healthy marker behind it.
    enrichPendingRepo.setBudgetCap(1);

    const maxAttempts = DYNAMICS_CONSTANTS.enrich.max_attempts;
    const publish = vi.fn(async (entry: Record<string, unknown>) => ({
      event_id: `event-${publish.mock.calls.length + 1}`,
      created_at: "2026-05-30T12:00:00.000Z",
      revision: 1,
      ...entry
    }));
    const isAbandonEvent = (entry: unknown): boolean =>
      (entry as { readonly event_type?: string }).event_type === "soul.garden.enrich_abandoned";
    // produceForNewMemory throws transiently for the poison marker forever; the
    // healthy marker enriches cleanly.
    const produceForNewMemory = vi.fn<ProduceFn>(async (params) => {
      if (params.newMemoryId === "memory-poison") {
        throw new Error("permanent fault mis-classified as transient");
      }
    });
    const runtime = createGardenRuntime(
      createRuntimeInput({
        enrichPendingRepo,
        findById: vi.fn(async (memoryId: string) => buildMemory(memoryId)),
        produceForNewMemory,
        publish
      })
    );

    // Drain (drain-count-agnostic) until the poison marker is dead-lettered. The
    // healthy marker stays starved behind the poison until the dead-letter frees
    // the slot. A safety cap guards against an infinite loop if the bound regresses.
    const SAFETY_PASSES = maxAttempts + 5;
    let passes = 0;
    while (
      !publish.mock.calls.some(([entry]) => isAbandonEvent(entry)) &&
      passes < SAFETY_PASSES
    ) {
      await dispatchBulkEnrich(runtime);
      passes += 1;
    }

    // The poison marker failed exactly MAX_ATTEMPTS times before abandon (the cap
    // bounds the retries) and is never enriched again.
    expect(
      produceForNewMemory.mock.calls.filter((call) => call[0].newMemoryId === "memory-poison")
    ).toHaveLength(maxAttempts);

    // Exactly one auditable SOUL_ENRICH_ABANDONED event, carrying the owed-work
    // identity (memory id + signal-ref), the final attempt count, and last failure.
    const abandonEvents = publish.mock.calls.filter(([entry]) => isAbandonEvent(entry));
    expect(abandonEvents).toHaveLength(1);
    expect(abandonEvents[0]![0]).toMatchObject({
      event_type: "soul.garden.enrich_abandoned",
      entity_type: "memory",
      entity_id: "memory-poison",
      workspace_id: "workspace-1",
      payload_json: {
        workspace_id: "workspace-1",
        memory_id: "memory-poison",
        source_signal_id: "signal-memory-poison",
        attempt_count: maxAttempts,
        last_failure_kind: "permanent fault mis-classified as transient"
      }
    });

    // invariant: a dead-lettered marker is excluded from claims, so the freed
    // 1-slot budget lets the healthy marker that was starved behind it drain.
    await dispatchBulkEnrich(runtime);
    expect(
      produceForNewMemory.mock.calls.some((call) => call[0].newMemoryId === "memory-healthy")
    ).toBe(true);
    // invariant: an abandoned marker is never re-claimed (poison enrich count stays
    // capped at maxAttempts), and countPending still reports the abandoned row
    // (terminal hold, not delete) once the healthy marker has settled.
    expect(
      produceForNewMemory.mock.calls.filter((call) => call[0].newMemoryId === "memory-poison")
    ).toHaveLength(maxAttempts);
    expect(enrichPendingRepo.countPending("workspace-1")).toBe(1);
  });

  // invariant (B4-R1 x B3): a PERMANENT rejection still clean-drops — it must NOT
  // route through the attempt counter and must NOT dead-letter, so a decided "no"
  // never becomes a poison-pill nor an abandon audit event.
  it("B4-R1xB3: a permanently rejected candidate clean-drops with no attempt increment and no dead-letter", async () => {
    const enrichPendingRepo = new FakeEnrichPendingRepo();
    enrichPendingRepo.enqueue("workspace-1", "memory-rejected");

    const recordFailedAttempt = vi.spyOn(enrichPendingRepo, "recordFailedAttempt");
    const publish = vi.fn(async (entry: Record<string, unknown>) => ({
      event_id: `event-${publish.mock.calls.length + 1}`,
      created_at: "2026-05-30T12:00:00.000Z",
      revision: 1,
      ...entry
    }));
    // The governed services settle a permanent rejection silently (no throw).
    const runtime = createGardenRuntime(
      createRuntimeInput({
        enrichPendingRepo,
        findById: vi.fn(async (memoryId: string) => buildMemory(memoryId)),
        produceForNewMemory: vi.fn<ProduceFn>(async () => undefined),
        detectAndLinkConflicts: vi.fn<DetectFn>(async () => undefined),
        publish
      })
    );

    await dispatchBulkEnrich(runtime);

    // No attempt counting, no dead-letter, no abandon audit event.
    expect(recordFailedAttempt).not.toHaveBeenCalled();
    expect(
      publish.mock.calls.some(
        ([entry]) =>
          (entry as { readonly event_type?: string }).event_type === "soul.garden.enrich_abandoned"
      )
    ).toBe(false);
    expect(enrichPendingRepo.countPending("workspace-1")).toBe(0);
  });

  // invariant (codex spine-review B5 x B3 interaction): a PERMANENT rejection
  // (B3 invalid-anchor refusal) settles silently inside the governed services
  // (submitCandidate returns "rejected", the service does NOT throw), so the
  // worker MUST markProcessed it. Retrying a permanently-rejected candidate can
  // never succeed; treating it like a transient failure would create an
  // infinite poison-pill retry loop. This pins that a rejection is terminal.
  it("B5xB3: a permanently rejected candidate is marked processed (NOT retried as a poison pill)", async () => {
    const enrichPendingRepo = new FakeEnrichPendingRepo();
    enrichPendingRepo.enqueue("workspace-1", "memory-rejected");

    const recordFailedAttempt = vi.spyOn(enrichPendingRepo, "recordFailedAttempt");
    const markProcessed = vi.spyOn(enrichPendingRepo, "markProcessed");
    // The governed services swallow a permanent "rejected" outcome as settled
    // (audited via path.relation_rejected) and resolve without throwing.
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

    await dispatchBulkEnrich(runtime);

    // A decided "no" settles the row: processed, never routed through the
    // transient attempt-counting / dead-letter seam.
    expect(markProcessed).toHaveBeenCalledWith(
      "workspace-1",
      "memory-rejected",
      expect.any(String)
    );
    expect(recordFailedAttempt).not.toHaveBeenCalled();
    expect(enrichPendingRepo.countPending("workspace-1")).toBe(0);

    // A re-drain claims nothing and re-invokes no service — no poison-pill loop.
    currentScheduler().enqueue(bulkEnrichTask());
    await dispatchBulkEnrich(runtime);
    expect(produceForNewMemory).toHaveBeenCalledTimes(1);
    expect(detectAndLinkConflicts).toHaveBeenCalledTimes(1);
  });

  it("replays first-class signal refs from the persisted source signal before marking the row processed", async () => {
    const enrichPendingRepo = new FakeEnrichPendingRepo();
    enrichPendingRepo.enqueue("workspace-1", "memory-signal-ref");

    const markProcessed = vi.spyOn(enrichPendingRepo, "markProcessed");
    const sourceSignal = buildSignal("signal-memory-signal-ref");
    const getById = vi.fn<SourceSignalLookupFn>(async () => sourceSignal);
    const replaySignalRefs = vi.fn<ReplaySignalRefsFn>(async () => undefined);
    const runtime = createGardenRuntime(
      createRuntimeInput({
        enrichPendingRepo,
        findById: vi.fn(async (memoryId: string) => buildMemory(memoryId)),
        omitEnrichmentServices: true,
        sourceSignalLookup: getById,
        replaySignalRefs
      })
    );

    await dispatchBulkEnrich(runtime);

    expect(getById).toHaveBeenCalledWith("signal-memory-signal-ref");
    expect(replaySignalRefs).toHaveBeenCalledWith({
      newMemoryId: "memory-signal-ref",
      signal: sourceSignal
    });
    expect(markProcessed).toHaveBeenCalledWith(
      "workspace-1",
      "memory-signal-ref",
      expect.any(String)
    );
    expect(enrichPendingRepo.countPending("workspace-1")).toBe(0);
  });

  it("keeps signal-ref replay failures pending by recording a transient failed attempt", async () => {
    const enrichPendingRepo = new FakeEnrichPendingRepo();
    enrichPendingRepo.enqueue("workspace-1", "memory-retry-signal-ref");

    const recordFailedAttempt = vi.spyOn(enrichPendingRepo, "recordFailedAttempt");
    const markProcessed = vi.spyOn(enrichPendingRepo, "markProcessed");
    const runtime = createGardenRuntime(
      createRuntimeInput({
        enrichPendingRepo,
        findById: vi.fn(async (memoryId: string) => buildMemory(memoryId)),
        omitEnrichmentServices: true,
        sourceSignalLookup: vi.fn<SourceSignalLookupFn>(async (signalId) => buildSignal(signalId)),
        replaySignalRefs: vi.fn<ReplaySignalRefsFn>(async () => {
          throw new Error("signal-ref mint still transient");
        })
      })
    );

    await dispatchBulkEnrich(runtime);

    expect(recordFailedAttempt).toHaveBeenCalledWith(
      "workspace-1",
      "memory-retry-signal-ref",
      DYNAMICS_CONSTANTS.enrich.max_attempts,
      expect.any(String)
    );
    expect(recordFailedAttempt.mock.results[0]?.value).toMatchObject({ abandoned: false });
    expect(markProcessed).not.toHaveBeenCalled();
    expect(enrichPendingRepo.countPending("workspace-1")).toBe(1);
    const completion = currentScheduler().completions.find(
      (result) => result.task_kind === GardenTaskKind.BULK_ENRICH
    );
    expect(completion?.audit_entries).toContain("bulk_enrich:processed_0");
    expect(completion?.audit_entries).toContain("bulk_enrich:failed_1");
    expect(completion?.audit_entries).toContain("bulk_enrich:abandoned_0");
  });

  it("does not mark processed when signal-ref replay cannot load the source signal", async () => {
    const enrichPendingRepo = new FakeEnrichPendingRepo();
    enrichPendingRepo.enqueue("workspace-1", "memory-missing-signal");

    const recordFailedAttempt = vi.spyOn(enrichPendingRepo, "recordFailedAttempt");
    const markProcessed = vi.spyOn(enrichPendingRepo, "markProcessed");
    const replaySignalRefs = vi.fn<ReplaySignalRefsFn>(async () => undefined);
    const runtime = createGardenRuntime(
      createRuntimeInput({
        enrichPendingRepo,
        findById: vi.fn(async (memoryId: string) => buildMemory(memoryId)),
        omitEnrichmentServices: true,
        sourceSignalLookup: vi.fn<SourceSignalLookupFn>(async () => null),
        replaySignalRefs
      })
    );

    await dispatchBulkEnrich(runtime);

    expect(replaySignalRefs).not.toHaveBeenCalled();
    expect(recordFailedAttempt).toHaveBeenCalledWith(
      "workspace-1",
      "memory-missing-signal",
      DYNAMICS_CONSTANTS.enrich.max_attempts,
      expect.any(String)
    );
    expect(markProcessed).not.toHaveBeenCalled();
    expect(enrichPendingRepo.countPending("workspace-1")).toBe(1);
  });

  // invariant (FIX-2): the 60s GardenScheduler pass re-drives owed path mints
  // for accept->mint crash-window orphans, once per workspace, bounded. LOGs a
  // tally only when it acted on a row (scanned > 0). When the port is unwired the
  // pass is inert.
  it("the 60s pass re-drives the edge-proposal accept->mint reconcile sweep per workspace, bounded", async () => {
    const enrichPendingRepo = new FakeEnrichPendingRepo();
    const reconcileStuckAccepts = vi.fn(async (input: { readonly workspaceId: string; readonly limit: number }) => ({
      scanned: input.workspaceId === "workspace-1" ? 1 : 0,
      reminted: input.workspaceId === "workspace-1" ? 1 : 0,
      already_present: 0,
      rejected: 0,
      transient_failed: 0
    }));
    const sweepExpired = vi.fn(async (_input: { readonly workspaceId: string; readonly limit: number }) => ({
      scanned: 0,
      expired: 0,
      skipped: 0
    }));
    const warn = vi.fn();
    const runtime = createGardenRuntime({
      ...createRuntimeInput({
        enrichPendingRepo,
        findById: vi.fn(async (memoryId: string) => buildMemory(memoryId)),
        produceForNewMemory: vi.fn(async () => undefined),
        workspaceIds: ["workspace-1", "workspace-2"],
        edgeProposalReconcile: { reconcileStuckAccepts, sweepExpired }
      }),
      warn
    });

    await getService(runtime, "GardenScheduler").task();

    // Once per workspace, with the bounded per-pass limit.
    expect(reconcileStuckAccepts).toHaveBeenCalledTimes(2);
    for (const call of reconcileStuckAccepts.mock.calls) {
      expect(call[0].limit).toBe(32);
    }
    expect(reconcileStuckAccepts.mock.calls.map((call) => call[0].workspaceId).sort()).toEqual([
      "workspace-1",
      "workspace-2"
    ]);
    // The acted-on workspace logs a tally; the no-op workspace does not.
    const reconcileLogs = warn.mock.calls.filter(
      ([message]) =>
        typeof message === "string" &&
        message.includes("edge proposal accept->mint reconcile pass acted on stranded accepts")
    );
    expect(reconcileLogs).toHaveLength(1);
    expect(reconcileLogs[0]![1]).toMatchObject({ workspace_id: "workspace-1", scanned: 1, reminted: 1 });
  });

  it("the 60s pass is inert for the edge-proposal reconcile sweep when the port is unwired", async () => {
    const enrichPendingRepo = new FakeEnrichPendingRepo();
    const runtime = createGardenRuntime(
      createRuntimeInput({
        enrichPendingRepo,
        findById: vi.fn(async (memoryId: string) => buildMemory(memoryId)),
        produceForNewMemory: vi.fn(async () => undefined)
      })
    );
    // No edgeProposalReconcile wired -> the pass must not throw.
    await expect(getService(runtime, "GardenScheduler").task()).resolves.toBeUndefined();
  });
});

function buildMemory(
  memoryId: string,
  workspaceId = "workspace-1"
): Readonly<{
  readonly object_id: string;
  readonly dimension: string;
  readonly scope_class: string;
  readonly content: string;
  readonly domain_tags: readonly string[];
  readonly workspace_id: string;
  readonly run_id: string;
}> {
  return {
    object_id: memoryId,
    dimension: "fact",
    scope_class: "project",
    content: `content-for-${memoryId}`,
    domain_tags: ["rtk"],
    workspace_id: workspaceId,
    run_id: "run-1"
  };
}

function buildSignal(signalId: string): CandidateMemorySignal {
  return {
    signal_id: signalId,
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    source: "garden_compile",
    signal_kind: "potential_claim",
    object_kind: "fact",
    scope_hint: "project",
    domain_tags: ["rtk"],
    confidence: 0.9,
    evidence_refs: [],
    source_memory_refs: ["memory-source"],
    supersedes_refs: [],
    exception_to_refs: [],
    contradicts_refs: [],
    incompatible_with_refs: [],
    raw_payload: {
      distilled_fact: "Signal ref replay fact."
    },
    signal_state: "compiled",
    created_at: "2026-05-30T12:00:00.000Z"
  };
}

function bulkEnrichTask(): GardenTaskDescriptor {
  return {
    task_id: `bulk-${Math.random()}`,
    task_kind: GardenTaskKind.BULK_ENRICH,
    required_tier: "tier_2",
    workspace_id: "workspace-1",
    run_id: null,
    target_object_refs: ["workspace-1"],
    priority: 10,
    created_at: "2026-05-30T12:00:00.000Z"
  };
}

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

function createRuntimeInput(options: {
  readonly enrichPendingRepo: FakeEnrichPendingRepo;
  readonly findById: (memoryId: string) => Promise<ReturnType<typeof buildMemory> | null>;
  readonly produceForNewMemory?: ProduceFn;
  readonly detectAndLinkConflicts?: DetectFn;
  readonly sourceSignalLookup?: SourceSignalLookupFn;
  readonly replaySignalRefs?: ReplaySignalRefsFn;
  readonly omitEnrichmentServices?: boolean;
  readonly workspaceIds?: readonly string[];
  readonly edgeProposalReconcile?: NonNullable<GardenRuntimeInput["edgeProposalReconcile"]>;
  readonly publish?: ReturnType<typeof vi.fn>;
}): GardenRuntimeInput {
  const fallbackPublish = vi.fn(async (entry: Record<string, unknown>) => ({
    event_id: `event-${fallbackPublish.mock.calls.length + 1}`,
    created_at: "2026-05-30T12:00:00.000Z",
    revision: 1,
    ...entry
  }));
  const publish = options.publish ?? fallbackPublish;
  const workspaceIds = options.workspaceIds ?? ["workspace-1"];

  return {
    databaseConnection: {} as GardenRuntimeInput["databaseConnection"],
    backlogThresholds: {
      warning_queue_depth: 100,
      warning_rearm_depth: 50,
      snapshot_interval_ms: 1000
    },
    eventLogRepo: {} as GardenRuntimeInput["eventLogRepo"],
    eventPublisher: {
      publish,
      appendManyWithMutation: vi.fn()
    } as unknown as GardenRuntimeInput["eventPublisher"],
    gardenDataPorts: {} as GardenRuntimeInput["gardenDataPorts"],
    healthJournalRepo: {
      append: vi.fn(async () => undefined)
    } as unknown as GardenRuntimeInput["healthJournalRepo"],
    handoffGapRepo: {
      findExpiredObjectsByWorkspace: vi.fn(async () => []),
      deleteById: vi.fn()
    } as unknown as GardenRuntimeInput["handoffGapRepo"],
    orphanDetectionEnabled: false,
    orphanRadarRepo: null,
    pathGraphSnapshotRepo: {
      findLatest: vi.fn(async () => null),
      create: vi.fn(),
      findHistory: vi.fn(async () => []),
      deleteOlderThan: vi.fn(async () => undefined)
    } as unknown as GardenRuntimeInput["pathGraphSnapshotRepo"],
    pathRelationRepo: {
      findActive: vi.fn(async () => []),
      findByAnchors: vi.fn(async () => [])
    } as unknown as GardenRuntimeInput["pathRelationRepo"],
    strongRefService: {
      isProtected: vi.fn(async () => false)
    } as unknown as GardenRuntimeInput["strongRefService"],
    workspaceRepo: {
      list: vi.fn(async () => workspaceIds.map((workspace_id) => ({ workspace_id })))
    } as unknown as GardenRuntimeInput["workspaceRepo"],
    enrichPendingRepo: options.enrichPendingRepo as unknown as NonNullable<
      GardenRuntimeInput["enrichPendingRepo"]
    >,
    enrichMemoryLookup: { findById: options.findById },
    ...(options.replaySignalRefs === undefined
      ? {}
      : {
          enrichSourceSignalLookup: {
            getById: options.sourceSignalLookup ?? (async (signalId: string) => buildSignal(signalId))
          },
          enrichSignalRefReplayPort: {
            replaySignalRefs: options.replaySignalRefs
          }
        }),
    ...(options.edgeProposalReconcile === undefined
      ? {}
      : { edgeProposalReconcile: options.edgeProposalReconcile }),
    ...(options.omitEnrichmentServices === true
      ? {}
      : {
          enrichEdgeProducerPort: {
            produceForNewMemory: options.produceForNewMemory ?? (async () => undefined)
          },
          ...(options.detectAndLinkConflicts === undefined
            ? {}
            : { enrichConflictDetectionPort: { detectAndLinkConflicts: options.detectAndLinkConflicts } })
        })
  };
}
