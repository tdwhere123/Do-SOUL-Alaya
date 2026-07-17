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
import { createGardenSignalRefReplayPort } from "../../runtime/garden-signal-ref-replay.js";

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

  it("keeps a missing canonical signal-emission anchor pending through the real Garden replay adapter", async () => {
    const enrichPendingRepo = new FakeEnrichPendingRepo();
    enrichPendingRepo.enqueue("workspace-1", "memory-missing-anchor");
    const recordFailedAttempt = vi.spyOn(enrichPendingRepo, "recordFailedAttempt");
    const materializationRouter = { replaySignalRefs: vi.fn(async () => []) };
    const signalRefReplayPort = createGardenSignalRefReplayPort({
      eventLogRepo: { append: vi.fn(), queryByEntity: vi.fn(async () => []) },
      evidenceCapsuleLookup: { findByIds: vi.fn(async () => []) },
      materializationRouter
    });
    const runtime = createGardenRuntime(
      createRuntimeInput({
        enrichPendingRepo,
        findById: vi.fn(async (memoryId: string) => buildMemory(memoryId)),
        omitEnrichmentServices: true,
        sourceSignalLookup: vi.fn<SourceSignalLookupFn>(async (signalId) => buildSignal(signalId)),
        replaySignalRefs: signalRefReplayPort.replaySignalRefs
      })
    );

    await dispatchBulkEnrich(runtime);

    expect(recordFailedAttempt).toHaveBeenCalledWith(
      "workspace-1",
      "memory-missing-anchor",
      DYNAMICS_CONSTANTS.enrich.max_attempts,
      expect.any(String)
    );
    expect(enrichPendingRepo.countPending("workspace-1")).toBe(1);
    expect(materializationRouter.replaySignalRefs).not.toHaveBeenCalled();
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
