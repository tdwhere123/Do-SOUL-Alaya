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

  // invariant: a TRANSIENT path-mint failure must not
  // become a processed enrich row. The governed services surface a transient
  // failure by throwing (produceForNewMemory throws when any submitCandidate
  // returns "failed"; detectAndLinkConflicts with strictNoDrop throws when a
  // candidate query throws or a mint fails transiently). The worker's
  // per-memory catch must record a TRANSIENT failed attempt — never
  // markProcessed — so the owed path is retried (under the cap), and emit NO
  // processed telemetry for the dropped row.
  it("a transient path-mint failure + a conflict-repo throw records a failed attempt, keeps the row pending, and emits no processed telemetry", async () => {
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

  // invariant: the transient-retry seam is BOUNDED. A sink that ALWAYS
  // throws transient `failed` dead-letters its marker after exactly MAX_ATTEMPTS
  // failed attempts, emits the SOUL_ENRICH_ABANDONED audit event (governance/
  // runtime drops must be auditable), and thereafter STOPS consuming the per-pass
  // claim budget — proven by a healthy marker, starved behind it under a 1-slot
  // budget, draining once the poison marker is dead-lettered.
  it("an always-transient-failing marker dead-letters after MAX_ATTEMPTS, emits SOUL_ENRICH_ABANDONED, and frees the budget for a healthy marker behind it", async () => {
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

  // invariant: a PERMANENT rejection still clean-drops — it must NOT
  // route through the attempt counter and must NOT dead-letter, so a decided "no"
  // never becomes a poison-pill nor an abandon audit event.
  it("a permanently rejected candidate clean-drops with no attempt increment and no dead-letter", async () => {
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

  // invariant: a PERMANENT rejection
  // (B3 invalid-anchor refusal) settles silently inside the governed services
  // (submitCandidate returns "rejected", the service does NOT throw), so the
  // worker MUST markProcessed it. Retrying a permanently-rejected candidate can
  // never succeed; treating it like a transient failure would create an
  // infinite poison-pill retry loop. This pins that a rejection is terminal.
  it("a permanently rejected candidate is marked processed (NOT retried as a poison pill)", async () => {
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
      memoryEvidenceIds: ["evidence-for-memory-signal-ref"],
      signal: sourceSignal
    });
    expect(markProcessed).toHaveBeenCalledWith(
      "workspace-1",
      "memory-signal-ref",
      expect.any(String)
    );
    expect(enrichPendingRepo.countPending("workspace-1")).toBe(0);
  });
});
