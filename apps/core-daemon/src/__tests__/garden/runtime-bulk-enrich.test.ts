import {
  resetSchedulers,
  dispatchBulkEnrich,
  currentScheduler,
  getService
} from "./runtime-bulk-enrich-scheduler-fixture.js";
import { createGardenRuntime } from "../../garden/runtime/runtime.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DYNAMICS_CONSTANTS,
  GardenTaskKind,
  type GardenTaskDescriptor,
  type GardenTaskResult
} from "@do-soul/alaya-protocol";
import {
  BULK_ENRICH_TEST_NOW,
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
import { runBulkEnrichTask } from "../../garden/bulk-enrich/bulk-enrich-runtime-runner.js";

describe("garden runtime BULK_ENRICH drain worker", () => {
  beforeEach(() => {
    resetSchedulers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });


  it("drains claimed pending rows: invokes detectAndLinkConflicts + produceForNewMemory per memory and marks processed", async () => {
    const enrichPendingRepo = new FakeEnrichPendingRepo();
    enrichPendingRepo.enqueue("workspace-1", "memory-1");
    enrichPendingRepo.enqueue("workspace-1", "memory-2");

    const produceForNewMemory = vi.fn<ProduceFn>(async () => undefined);
    const detectAndLinkConflicts = vi.fn<DetectFn>(async () => ({ availability: "ok" }));
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
    const firstConflictScanCall = detectAndLinkConflicts.mock.calls[0];
    if (firstConflictScanCall === undefined) {
      throw new Error("expected detectAndLinkConflicts to be called");
    }
    expect(firstConflictScanCall[0]).toMatchObject({
      newMemoryDimension: "fact",
      newMemoryContent: "content-for-memory-1"
    });
    expect(enrichPendingRepo.countPending("workspace-1")).toBe(0);
  });

  it("is idempotent: a re-drain after processing claims nothing and re-invokes no service", async () => {
    const enrichPendingRepo = new FakeEnrichPendingRepo();
    enrichPendingRepo.enqueue("workspace-1", "memory-1");

    const produceForNewMemory = vi.fn(async () => undefined);
    const detectAndLinkConflicts = vi.fn(async () => ({ availability: "ok" as const }));
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

  it("does not drain enrich_pending for a per-source source_enrich bulk_enrich task", async () => {
    const enrichPendingRepo = new FakeEnrichPendingRepo();
    const produceForNewMemory = vi.fn<ProduceFn>(async () => undefined);
    const detectAndLinkConflicts = vi.fn<DetectFn>(async () => ({ availability: "ok" }));
    const runtime = createGardenRuntime(
      createRuntimeInput({
        enrichPendingRepo,
        findById: vi.fn(async (memoryId: string) => buildMemory(memoryId)),
        produceForNewMemory,
        detectAndLinkConflicts
      })
    );
    currentScheduler().enqueue({
      ...bulkEnrichTask(),
      task_id: "source_enrich_fixture",
      source_object_id: "memory-1",
      source_revision: 0,
      enrichment_contract: "source_enrichment.v1"
    });
    await getService(runtime, "GardenScheduler").task();
    expect(produceForNewMemory).not.toHaveBeenCalled();
    expect(detectAndLinkConflicts).not.toHaveBeenCalled();
    expect(currentScheduler().completions[0]).toMatchObject({
      success: false,
      audit_entries: [
        "source_enrich_unwired",
        "source_enrich_capability:unconfigured",
        "source_enrich_spend:unsupported",
        "source_enrich_completion_tokens:unsupported",
        "source_enrich_family:none"
      ]
    });
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
        findById: vi.fn(async (memoryId: string) => buildMemory(memoryId, memoryId.replace("memory-", "workspace-"))),
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
    const workspaceIds = Array.from({ length: 35 }, (_unused, index) => `workspace-${index + 1}`);
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
    expect(completedWorkspaces).toHaveLength(32);
    expect(currentScheduler().queue.filter((task) => task.task_kind === GardenTaskKind.BULK_ENRICH)).toHaveLength(3);
    await getService(runtime, "GardenScheduler").task();
    expect([...new Set(currentScheduler().completions.filter((result) => result.task_kind === GardenTaskKind.BULK_ENRICH)
      .map((result) => result.workspace_id))].sort()).toEqual([...workspaceIds].sort());
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
        BULK_ENRICH_TEST_NOW,
        DYNAMICS_CONSTANTS.enrich.max_attempts
      )
    ).toHaveLength(0);
    expect(enrichPendingRepo.countPending("workspace-B")).toBe(1);
    expect(currentScheduler().completions).toHaveLength(0);
  });

  it("fails bulk enrich when the pending table is not configured", async () => {
    const reportCompletion = vi.fn(async () => undefined);
    await runBulkEnrichTask({
      now: () => BULK_ENRICH_TEST_NOW,
      task: bulkEnrichTask(),
      availability: { kind: "missing_repo" },
      reporter: {
        emitEnrichAbandoned: async () => undefined,
        reportCompletion,
        warn: vi.fn()
      }
    });
    expect(reportCompletion).toHaveBeenCalledWith(
      expect.anything(),
      BULK_ENRICH_TEST_NOW,
      "failed",
      ["bulk_enrich_failed:no_enrich_pending_table"],
      expect.any(Error)
    );
  });

  it("skips bulk enrich when enrichment is intentionally disabled", async () => {
    const reportCompletion = vi.fn(async () => undefined);
    await runBulkEnrichTask({
      now: () => BULK_ENRICH_TEST_NOW,
      task: bulkEnrichTask(),
      availability: { kind: "disabled" },
      reporter: {
        emitEnrichAbandoned: async () => undefined,
        reportCompletion,
        warn: vi.fn()
      }
    });
    expect(reportCompletion).toHaveBeenCalledWith(
      expect.anything(),
      BULK_ENRICH_TEST_NOW,
      "skipped",
      ["bulk_enrich_skipped:enrichment_disabled"]
    );
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
    const firstCompletion = completions[0];
    if (firstCompletion === undefined) {
      throw new Error("expected one BULK_ENRICH completion");
    }
    expect(firstCompletion.workspace_id).toBe("workspace-1");
    expect(produceForNewMemory).toHaveBeenCalledTimes(count);
    expect(enrichPendingRepo.countPending("workspace-1")).toBe(0);
  });

  it("below batch_trigger_count the unconditional 60s drain still enriches (~1-min bound, not held for the threshold)", async () => {
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

  it("reclaims and drains a claim stranded by a crash before markProcessed", async () => {
    const enrichPendingRepo = new FakeEnrichPendingRepo();
    enrichPendingRepo.enqueue("workspace-1", "memory-stranded");

    const produceForNewMemory = vi.fn<ProduceFn>(async () => undefined);
    const detectAndLinkConflicts = vi.fn<DetectFn>(async () => ({ availability: "ok" }));
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
        BULK_ENRICH_TEST_NOW,
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
    const firstProduceCall = produceForNewMemory.mock.calls[0];
    if (firstProduceCall === undefined) {
      throw new Error("expected one produceForNewMemory call");
    }
    expect(firstProduceCall[0].newMemoryId).toBe("memory-stranded");
    expect(detectAndLinkConflicts).toHaveBeenCalledTimes(1);
    expect(enrichPendingRepo.countPending("workspace-1")).toBe(0);
  });

  it("periodic stale-claim reclamation preserves fresh in-flight claims", async () => {
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
      BULK_ENRICH_TEST_NOW,
      DYNAMICS_CONSTANTS.enrich.max_attempts
    );

    const reclaim = vi.spyOn(enrichPendingRepo, "reclaimStale");
    await getService(runtime, "GardenScheduler").task();

    expect(reclaim).toHaveBeenCalledWith(BULK_ENRICH_TEST_NOW, DYNAMICS_CONSTANTS.enrich.claim_stale_after_ms);
    expect(produceForNewMemory).not.toHaveBeenCalled();
    expect(currentScheduler().completions).toHaveLength(1);
    expect(currentScheduler().queue).toHaveLength(0);
    expect(enrichPendingRepo.countPending("workspace-1")).toBe(1);
    expect(
      enrichPendingRepo.claimBatch(
        "workspace-1",
        50,
        BULK_ENRICH_TEST_NOW,
        DYNAMICS_CONSTANTS.enrich.max_attempts
      )
    ).toHaveLength(0);
  });
});
