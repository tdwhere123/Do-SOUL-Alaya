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
import { createGardenSignalRefReplayPort } from "../../runtime/garden-wiring/garden-signal-ref-replay.js";

describe("garden runtime BULK_ENRICH drain worker", () => {
  beforeEach(() => {
    resetSchedulers();
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

  it("treats an unavailable conflict scan result as a retryable drain failure", async () => {
    const enrichPendingRepo = new FakeEnrichPendingRepo();
    enrichPendingRepo.enqueue("workspace-1", "memory-owed");

    const recordFailedAttempt = vi.spyOn(enrichPendingRepo, "recordFailedAttempt");
    const markProcessed = vi.spyOn(enrichPendingRepo, "markProcessed");
    const produceForNewMemory = vi.fn<ProduceFn>(async () => undefined);
    const detectAndLinkConflicts = vi.fn<DetectFn>(async () => ({
      availability: "unavailable"
    }));
    const runtime = createGardenRuntime(
      createRuntimeInput({
        enrichPendingRepo,
        findById: vi.fn(async (memoryId: string) => buildMemory(memoryId)),
        produceForNewMemory,
        detectAndLinkConflicts
      })
    );

    await dispatchBulkEnrich(runtime);

    expect(detectAndLinkConflicts).toHaveBeenCalled();
    expect(recordFailedAttempt).toHaveBeenCalledWith(
      "workspace-1",
      "memory-owed",
      DYNAMICS_CONSTANTS.enrich.max_attempts,
      expect.any(String)
    );
    expect(markProcessed).not.toHaveBeenCalled();
    expect(enrichPendingRepo.countPending("workspace-1")).toBe(1);
  });

  // invariant: the transient-retry seam is BOUNDED. A sink that ALWAYS
  // throws transient `failed` dead-letters its marker after exactly MAX_ATTEMPTS
  // failed attempts, emits the SOUL_ENRICH_ABANDONED audit event (governance/
  // runtime drops must be auditable), and thereafter STOPS consuming the per-pass
  // claim budget — proven by a healthy marker, starved behind it under a 1-slot
  // budget, draining once the poison marker is dead-lettered.
  it("an always-transient-failing marker dead-letters after MAX_ATTEMPTS, emits SOUL_ENRICH_ABANDONED, and frees the budget for a healthy marker behind it", async () => {
    const enrichPendingRepo = new FakeEnrichPendingRepo();
    enrichPendingRepo.enqueue("workspace-1", "memory-poison", "signal-memory-poison");
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
        detectAndLinkConflicts: vi.fn<DetectFn>(async () => ({ availability: "ok" })),
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
    const detectAndLinkConflicts = vi.fn<DetectFn>(async () => ({ availability: "ok" }));
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
    enrichPendingRepo.enqueue("workspace-1", "memory-signal-ref", "signal-memory-signal-ref");

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

  it("keeps signal-ref replay failures pending by recording a transient failed attempt", async () => {
    const enrichPendingRepo = new FakeEnrichPendingRepo();
    enrichPendingRepo.enqueue("workspace-1", "memory-retry-signal-ref", "signal-memory-retry-signal-ref");

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

  it("retains source replay when its port is unavailable and resumes it without repeating independent work", async () => {
    const enrichPendingRepo = new FakeEnrichPendingRepo();
    enrichPendingRepo.enqueue("workspace-1", "memory-owed", "signal-memory-owed");
    const produceForNewMemory = vi.fn<ProduceFn>(async () => undefined);
    const recordFailure = vi.spyOn(enrichPendingRepo, "recordFailedAttempt");
    const unavailable = createGardenRuntime(createRuntimeInput({
      enrichPendingRepo,
      findById: vi.fn(async (id: string) => buildMemory(id)),
      produceForNewMemory
    }));

    await unavailable.runBulkEnrichPass("workspace-1");
    await unavailable.runBulkEnrichPass("workspace-1");
    expect(produceForNewMemory).toHaveBeenCalledTimes(1);
    expect(recordFailure).not.toHaveBeenCalled();
    expect(enrichPendingRepo.countPending("workspace-1")).toBe(1);

    const replaySignalRefs = vi.fn<ReplaySignalRefsFn>(async () => undefined);
    const available = createGardenRuntime(createRuntimeInput({
      enrichPendingRepo,
      findById: vi.fn(async (id: string) => buildMemory(id)),
      produceForNewMemory,
      sourceSignalLookup: vi.fn<SourceSignalLookupFn>(async (id) => ({ ...buildSignal(id), signal_state: "materialized" })),
      replaySignalRefs
    }));
    await available.runBulkEnrichPass("workspace-1");
    expect(replaySignalRefs).toHaveBeenCalledTimes(1);
    expect(produceForNewMemory).toHaveBeenCalledTimes(1);
    expect(enrichPendingRepo.countPending("workspace-1")).toBe(0);
  });

  it("does not enrich or replay objects from another workspace", async () => {
    const enrichPendingRepo = new FakeEnrichPendingRepo();
    enrichPendingRepo.enqueue("workspace-1", "wrong-memory-workspace", "signal-wrong-memory-workspace");
    enrichPendingRepo.enqueue("workspace-1", "wrong-signal-workspace", "signal-wrong-signal-workspace");
    const produceForNewMemory = vi.fn<ProduceFn>(async () => undefined);
    const replaySignalRefs = vi.fn<ReplaySignalRefsFn>(async () => undefined);
    const runtime = createGardenRuntime(createRuntimeInput({
      enrichPendingRepo,
      findById: vi.fn(async (id: string) => buildMemory(id, id === "wrong-memory-workspace" ? "workspace-2" : "workspace-1")),
      produceForNewMemory,
      sourceSignalLookup: vi.fn<SourceSignalLookupFn>(async (id) => ({ ...buildSignal(id), workspace_id: "workspace-2" })),
      replaySignalRefs
    }));

    await dispatchBulkEnrich(runtime);

    expect(produceForNewMemory).toHaveBeenCalledTimes(1);
    expect(replaySignalRefs).not.toHaveBeenCalled();
    expect(enrichPendingRepo.countPending("workspace-1")).toBe(2);
    expect(currentScheduler().completions.at(-1)?.audit_entries).toContain("bulk_enrich:failed_2");
  });

  it("keeps a missing canonical signal-emission anchor pending through the real Garden replay adapter", async () => {
    const enrichPendingRepo = new FakeEnrichPendingRepo();
    enrichPendingRepo.enqueue("workspace-1", "memory-missing-anchor", "signal-memory-missing-anchor");
    const recordFailedAttempt = vi.spyOn(enrichPendingRepo, "recordFailedAttempt");
    const materializationRouter = { replaySignalRefs: vi.fn(async () => []) };
    const signalRefReplayPort = createGardenSignalRefReplayPort({
      eventLogRepo: { append: vi.fn(), queryByEntity: vi.fn(async () => []), queryByEntityTypeBefore: async () => [] },
      signalLookup: { getById: async id => ({ ...buildSignal(id), signal_state: "materialized" }) },
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
    enrichPendingRepo.enqueue("workspace-1", "memory-missing-signal", "signal-memory-missing-signal");

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

  // The 60s GardenScheduler pass re-drives owed path mints for
  // accept->mint crash-window orphans, once per workspace, bounded. It
  // logs a tally only when it acted on a row (scanned > 0). When the
  // port is unwired the pass is inert.
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
