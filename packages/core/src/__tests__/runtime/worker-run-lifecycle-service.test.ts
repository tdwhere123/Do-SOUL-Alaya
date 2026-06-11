import { describe, expect, it, vi } from "vitest";
import {
  ToolWorkerEventType,
  type DelegatedWorkerRun,
  type EventLogEntry,
  type WorkerRunState,
  type WorkerStateChangedSuspendReason
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../errors.js";
import { WorkerRunLifecycleService, type WorkerRunRepoPort } from "../../runtime/worker-run-lifecycle-service.js";
import type { EventPublisher } from "../../runtime/event-publisher.js";

const FIXED_NOW = "2026-04-10T12:00:00.000Z";

type MutableWorkerRepo = WorkerRunRepoPort & {
  readonly getById: ReturnType<typeof vi.fn>;
  readonly updateState: ReturnType<typeof vi.fn>;
};

function createWorkerRun(overrides: Partial<DelegatedWorkerRun> = {}): DelegatedWorkerRun {
  return {
    worker_run_id: "worker_1",
    principal_run_id: "run_1",
    workspace_id: "ws_1",
    requesting_run_id: "run_1",
    engine_class: "coding_engine",
    state: "init",
    subtask_description: "Investigate failing worker lifecycle path.",
    local_surface_ref: "surface://task/main",
    local_evidence_pointer: null,
    restricted_tool_set: ["exec", "read"],
    local_budget: {
      max_worker_delegations: 2,
      max_tool_calls: 4,
      max_output_tokens: 2048,
      max_wall_time_ms: 120000
    },
    agreed_return_format: {
      allowed_return_kinds: ["handoff"],
      requires_structured_summary: true
    },
    principal_security_snapshot: {
      governance_lease_ref: "lease_1",
      hard_constraint_refs: ["claim_1"],
      denied_tool_categories: ["network"]
    },
    created_at: "2026-04-10T10:00:00.000Z",
    updated_at: "2026-04-10T10:00:00.000Z",
    ...overrides
  };
}

function createHarness(
  seed: DelegatedWorkerRun,
  options: {
    readonly beforeMutate?: () => void;
  } = {}
) {
  const workerStore = new Map<string, DelegatedWorkerRun>([[seed.worker_run_id, seed]]);
  const publishedEvents: Array<Omit<EventLogEntry, "event_id" | "created_at" | "revision">> = [];

  const updateStateImpl = (
    workerRunId: string,
    expectedState: WorkerRunState,
    nextState: WorkerRunState,
    updatedAt: string
  ): DelegatedWorkerRun => {
    const existing = workerStore.get(workerRunId);

    if (existing === undefined) {
      throw new Error(`missing worker ${workerRunId}`);
    }

    if (existing.state !== expectedState) {
      throw new CoreError(
        "CONFLICT",
        `Worker run ${workerRunId} changed concurrently: expected ${expectedState}, found ${existing.state}`
      );
    }

    const updated = Object.freeze({
      ...existing,
      state: nextState,
      updated_at: updatedAt
    });
    workerStore.set(workerRunId, updated);
    return updated;
  };

  const repo: MutableWorkerRepo = {
    getById: vi.fn(async (workerRunId: string) => workerStore.get(workerRunId) ?? null),
    updateState: vi.fn(updateStateImpl)
  };

  const appendManyWithMutation = vi.fn(
    async (
      events: ReadonlyArray<Omit<EventLogEntry, "event_id" | "created_at" | "revision">>,
      mutate: (entries: readonly EventLogEntry[]) => DelegatedWorkerRun
    ) => {
      for (const event of events) {
        publishedEvents.push(event);
      }
      options.beforeMutate?.();
      const persisted = events.map((event, idx) => ({
        event_id: `evt_${idx}`,
        created_at: FIXED_NOW,
        revision: 0,
        ...event
      }));
      return mutate(persisted);
    }
  );

  const service = new WorkerRunLifecycleService({
    repo,
    eventPublisher: {
      // WorkerRunLifecycleService now uses appendManyWithMutation (#BL-022).
      appendManyWithMutation: appendManyWithMutation
    } as unknown as EventPublisher,
    now: () => FIXED_NOW
  });

  return {
    service,
    repo,
    appendManyWithMutation,
    publishedEvents,
    getCurrent: () => workerStore.get(seed.worker_run_id) ?? null,
    setState: (state: WorkerRunState) => {
      const existing = workerStore.get(seed.worker_run_id);
      if (existing === undefined) {
        return;
      }
      workerStore.set(seed.worker_run_id, { ...existing, state });
    }
  };
}

describe("WorkerRunLifecycleService", () => {
  it("dispatches init -> active and emits worker.state_changed", async () => {
    const { service, publishedEvents, getCurrent } = createHarness(createWorkerRun({ state: "init" }));

    await service.dispatch("worker_1");

    expect(getCurrent()?.state).toBe("active");
    expect(publishedEvents).toHaveLength(1);
    expect(publishedEvents[0]).toMatchObject({
      event_type: ToolWorkerEventType.WORKER_STATE_CHANGED,
      entity_type: "worker_run",
      entity_id: "worker_1",
      workspace_id: "ws_1",
      run_id: "run_1",
      payload_json: {
        workerId: "worker_1",
        state: "active",
        previousState: "init"
      }
    });
  });

  it("completes active -> completed and rejects repeated completion without writing a second event", async () => {
    const { service, appendManyWithMutation, publishedEvents, getCurrent } = createHarness(
      createWorkerRun({ state: "active" })
    );

    await service.complete("worker_1", ["handoff_1"]);
    expect(getCurrent()?.state).toBe("completed");
    expect(publishedEvents[0]?.payload_json).toMatchObject({
      state: "completed",
      previousState: "active",
      returnedObjectRefs: ["handoff_1"]
    });

    await expect(service.complete("worker_1", ["handoff_2"])).rejects.toMatchObject({
      name: "CoreError",
      code: "VALIDATION",
      message: "Illegal worker state transition: completed -> completed"
    });
    expect(appendManyWithMutation).toHaveBeenCalledTimes(1);
  });

  it("suspends active -> suspended for all supported suspend reasons", async () => {
    const reasons: readonly WorkerStateChangedSuspendReason[] = [
      "lease_cascade",
      "native_surface_drift",
      "node_fuse"
    ];

    for (const reason of reasons) {
      const { service, publishedEvents, getCurrent } = createHarness(createWorkerRun({ state: "active" }));

      await service.suspend("worker_1", reason);

      expect(getCurrent()?.state).toBe("suspended");
      expect(publishedEvents[0]?.payload_json).toMatchObject({
        workerId: "worker_1",
        state: "suspended",
        previousState: "active",
        suspendReason: reason
      });
    }
  });

  it("resumes suspended -> active and includes previousState=suspended", async () => {
    const { service, publishedEvents, getCurrent } = createHarness(createWorkerRun({ state: "suspended" }));

    await service.resume("worker_1");

    expect(getCurrent()?.state).toBe("active");
    expect(publishedEvents[0]?.payload_json).toMatchObject({
      workerId: "worker_1",
      state: "active",
      previousState: "suspended"
    });
  });

  it("aborts from active and suspended states with audit payload", async () => {
    const activeHarness = createHarness(createWorkerRun({ state: "active" }));
    await activeHarness.service.abort("worker_1", {
      reason: "timeout",
      rollbackAttempted: true
    });

    expect(activeHarness.getCurrent()?.state).toBe("aborted");
    expect(activeHarness.publishedEvents[0]?.payload_json).toMatchObject({
      workerId: "worker_1",
      state: "aborted",
      previousState: "active",
      abortReason: "timeout",
      rollbackAttempted: true
    });

    const suspendedHarness = createHarness(createWorkerRun({ state: "suspended" }));
    await suspendedHarness.service.abort("worker_1", {
      reason: "regrounding_failed",
      rollbackAttempted: false
    });

    expect(suspendedHarness.getCurrent()?.state).toBe("aborted");
    expect(suspendedHarness.publishedEvents[0]?.payload_json).toMatchObject({
      workerId: "worker_1",
      state: "aborted",
      previousState: "suspended",
      abortReason: "regrounding_failed",
      rollbackAttempted: false
    });
  });

  it("trims worker identifiers and audit strings before lookup and emission", async () => {
    const { service, publishedEvents, getCurrent } = createHarness(createWorkerRun({ state: "active" }));

    await service.abort(" worker_1 ", {
      reason: " timeout ",
      rollbackAttempted: true
    });

    expect(getCurrent()?.state).toBe("aborted");
    expect(publishedEvents[0]?.payload_json).toMatchObject({
      workerId: "worker_1",
      state: "aborted",
      previousState: "active",
      abortReason: "timeout",
      rollbackAttempted: true
    });
  });

  it("freezes from every allowed source state", async () => {
    const sourceStates: readonly WorkerRunState[] = ["init", "active", "suspended", "completed", "aborted"];

    for (const sourceState of sourceStates) {
      const { service, publishedEvents, getCurrent } = createHarness(createWorkerRun({ state: sourceState }));

      await service.freeze("worker_1", "dirty_state_panic", "state divergence detected");

      expect(getCurrent()?.state).toBe("frozen");
      expect(publishedEvents[0]?.payload_json).toMatchObject({
        workerId: "worker_1",
        state: "frozen",
        previousState: sourceState,
        panicSource: "dirty_state_panic",
        panicSummary: "state divergence detected"
      });
    }
  });

  it("rejects illegal transitions without writing any EventLog entry", async () => {
    const { service, appendManyWithMutation } = createHarness(createWorkerRun({ state: "init" }));

    await expect(
      service.complete("worker_1", ["handoff_1"])
    ).rejects.toBeInstanceOf(CoreError);

    expect(appendManyWithMutation).not.toHaveBeenCalled();
  });

  it("reloads snapshot on every call instead of using in-memory cached state", async () => {
    const { service, repo, publishedEvents, setState, getCurrent } = createHarness(createWorkerRun({ state: "init" }));

    await service.dispatch("worker_1");
    expect(getCurrent()?.state).toBe("active");

    setState("suspended");
    await service.resume("worker_1");

    expect(repo.getById).toHaveBeenCalledTimes(2);
    expect(getCurrent()?.state).toBe("active");
    expect(publishedEvents[1]?.payload_json).toMatchObject({
      previousState: "suspended",
      state: "active"
    });
  });

  it("fails cleanly when the repo detects a concurrent state change", async () => {
    const harness = createHarness(createWorkerRun({ state: "active" }), {
      beforeMutate: () => {
        harness.setState("suspended");
      }
    });

    await expect(
      harness.service.complete("worker_1", ["handoff_1"])
    ).rejects.toMatchObject({
      name: "CoreError",
      code: "CONFLICT",
      message: "Worker run worker_1 changed concurrently: expected active, found suspended"
    });

    expect(harness.getCurrent()?.state).toBe("suspended");
    expect(harness.publishedEvents[0]?.payload_json).toMatchObject({
      previousState: "active",
      state: "completed"
    });
  });

  it("supports resumable progression across service instances against shared durable state", async () => {
    const seed = createWorkerRun({ state: "active" });
    const workerStore = new Map<string, DelegatedWorkerRun>([[seed.worker_run_id, seed]]);
    const publishedEvents: Array<Omit<EventLogEntry, "event_id" | "created_at" | "revision">> = [];

    const updateStateImpl = (
      workerRunId: string,
      expectedState: WorkerRunState,
      nextState: WorkerRunState,
      updatedAt: string
    ): DelegatedWorkerRun => {
      const existing = workerStore.get(workerRunId);
      if (existing === undefined) {
        throw new Error(`missing worker ${workerRunId}`);
      }
      if (existing.state !== expectedState) {
        throw new CoreError(
          "CONFLICT",
          `Worker run ${workerRunId} changed concurrently: expected ${expectedState}, found ${existing.state}`
        );
      }
      const updated = Object.freeze({
        ...existing,
        state: nextState,
        updated_at: updatedAt
      });
      workerStore.set(workerRunId, updated);
      return updated;
    };

    const repo: MutableWorkerRepo = {
      getById: vi.fn(async (workerRunId: string) => workerStore.get(workerRunId) ?? null),
      updateState: vi.fn(updateStateImpl)
    };

    const eventPublisher = {
      // WorkerRunLifecycleService now uses appendManyWithMutation (#BL-022).
      appendManyWithMutation: vi.fn(
        async (
          events: ReadonlyArray<Omit<EventLogEntry, "event_id" | "created_at" | "revision">>,
          mutate: (entries: readonly EventLogEntry[]) => DelegatedWorkerRun
        ) => {
          for (const event of events) {
            publishedEvents.push(event);
          }
          const persisted = events.map((event, idx) => ({
            event_id: `evt_${idx}`,
            created_at: FIXED_NOW,
            revision: 0,
            ...event
          }));
          return mutate(persisted);
        }
      )
    } as unknown as EventPublisher;

    const firstService = new WorkerRunLifecycleService({
      repo,
      eventPublisher,
      now: () => FIXED_NOW
    });
    await firstService.suspend("worker_1", "lease_cascade");
    expect(workerStore.get("worker_1")?.state).toBe("suspended");

    const secondService = new WorkerRunLifecycleService({
      repo,
      eventPublisher,
      now: () => FIXED_NOW
    });
    await secondService.resume("worker_1");

    expect(workerStore.get("worker_1")?.state).toBe("active");
    expect(publishedEvents).toHaveLength(2);
    expect(publishedEvents[1]?.payload_json).toMatchObject({
      previousState: "suspended",
      state: "active"
    });
  });
});
