import { describe, expect, it, vi } from "vitest";
import type {
  DelegatedWorkerRun,
  DirtyStateDossier,
  EventLogEntry,
  DirtyStatePanicTrigger
} from "@do-soul/alaya-protocol";
import { ObligationTrustNarrativeEventType } from "@do-soul/alaya-protocol";
import { CoreError } from "../errors.js";
import {
  DirtyStatePanicService,
  type DirtyStatePanicServiceDependencies
} from "../dirty-state-panic-service.js";

const FIXED_NOW = "2026-04-15T12:00:00.000Z";

function createWorkerRun(overrides: Partial<DelegatedWorkerRun> = {}): DelegatedWorkerRun {
  return {
    worker_run_id: overrides.worker_run_id ?? "worker-run-1",
    principal_run_id: overrides.principal_run_id ?? "principal-run-1",
    workspace_id: overrides.workspace_id ?? "workspace-1",
    requesting_run_id: overrides.requesting_run_id ?? "principal-run-1",
    engine_class: overrides.engine_class ?? "coding_engine",
    state: overrides.state ?? "init",
    subtask_description: overrides.subtask_description ?? "Investigate integrity violation.",
    local_surface_ref: overrides.local_surface_ref ?? "surface://worker/1",
    local_evidence_pointer: overrides.local_evidence_pointer ?? null,
    restricted_tool_set: overrides.restricted_tool_set ?? ["tools.read_file"],
    local_budget:
      overrides.local_budget ?? {
        max_worker_delegations: 1,
        max_tool_calls: 2,
        max_output_tokens: 1024,
        max_wall_time_ms: 60000
      },
    agreed_return_format:
      overrides.agreed_return_format ?? {
        allowed_return_kinds: ["analysis_note"],
        requires_structured_summary: true
      },
    principal_security_snapshot:
      overrides.principal_security_snapshot ?? {
        governance_lease_ref: "lease-1",
        hard_constraint_refs: ["constraint-1"],
        denied_tool_categories: ["network"]
      },
    created_at: overrides.created_at ?? FIXED_NOW,
    updated_at: overrides.updated_at ?? FIXED_NOW
  };
}

// Helper: in-test publisher that simulates the appendManyWithMutation contract
// (sync mutate, batch-array first arg) used by DirtyStatePanicService after #BL-022.
function fakeAppendManyWithMutation(
  publishedEvents?: Array<EventLogEntry | Omit<EventLogEntry, "event_id" | "created_at">>
): ReturnType<typeof vi.fn> {
  return vi.fn(async (events: any[], mutate: (entries: any[]) => any) => {
    if (publishedEvents) {
      for (const event of events) publishedEvents.push(event);
    }
    const persisted = events.map((event, idx) => ({
      ...event,
      event_id: `evt_${idx}`,
      created_at: FIXED_NOW
    }));
    return mutate(persisted);
  });
}

describe("DirtyStatePanicService", () => {
  it("appends panic + worker.state_changed and updates dossier/worker atomically (#BL-022)", async () => {
    const workerStore = new Map<string, DelegatedWorkerRun>([
      [
        "worker-run-1",
        createWorkerRun({
          worker_run_id: "worker-run-1",
          principal_run_id: "principal-run-1",
          workspace_id: "workspace-1",
          state: "init"
        })
      ],
      [
        "worker-run-2",
        createWorkerRun({
          worker_run_id: "worker-run-2",
          principal_run_id: "principal-run-2",
          workspace_id: "workspace-1",
          state: "active"
        })
      ]
    ]);

    const workerRunRepo = {
      getById: vi.fn(async (workerRunId: string) => workerStore.get(workerRunId) ?? null),
      updateStateSync: vi.fn(
        (workerRunId: string, _expected: string, nextState: string, updatedAt: string) => {
          const current = workerStore.get(workerRunId);
          if (current === undefined) {
            throw new CoreError("NOT_FOUND", "Worker run not found");
          }
          const updated = {
            ...current,
            state: nextState as DelegatedWorkerRun["state"],
            updated_at: updatedAt
          };
          workerStore.set(workerRunId, updated);
          return updated;
        }
      )
    };
    const publishedEvents: Array<EventLogEntry | Omit<EventLogEntry, "event_id" | "created_at">> = [];
    const appendManyWithMutation = fakeAppendManyWithMutation(publishedEvents);
    const createSync = vi.fn((dossier: DirtyStateDossier) => dossier);

    const service = new DirtyStatePanicService({
      workerRunRepo,
      eventPublisher: {
        appendManyWithMutation:
          appendManyWithMutation as unknown as DirtyStatePanicServiceDependencies["eventPublisher"]["appendManyWithMutation"]
      },
      dossierRepo: {
        createSync,
        deleteById: vi.fn(async () => undefined),
        findByWorkspace: vi.fn(),
        findByWorkerRun: vi.fn()
      },
      generateDossierId: () => "dossier-1",
      now: () => FIXED_NOW
    });

    const dossier = await service.triggerPanic({
      workerRunId: "worker-run-1",
      trigger: "safety_gate_failure",
      panicSource: "worker_baseline_hard_stop",
      summary: "active hard_stop refs: policy-hard-stop",
      affectedScope: [{ entity_type: "constraint_ref", entity_id: "policy-hard-stop" }]
    });

    expect(dossier).toEqual({
      dossier_id: "dossier-1",
      worker_run_id: "worker-run-1",
      principal_run_id: "principal-run-1",
      workspace_id: "workspace-1",
      trigger: "safety_gate_failure",
      panic_source: "worker_baseline_hard_stop",
      panic_summary: "active hard_stop refs: policy-hard-stop",
      affected_data_scope: [{ entity_type: "constraint_ref", entity_id: "policy-hard-stop" }],
      created_at: FIXED_NOW
    });

    expect(appendManyWithMutation).toHaveBeenCalledTimes(1);
    expect(publishedEvents).toHaveLength(2);
    expect(publishedEvents[0]).toMatchObject({
      event_type: ObligationTrustNarrativeEventType.DIRTY_STATE_PANIC,
      entity_type: "worker_run",
      entity_id: "worker-run-1",
      workspace_id: "workspace-1",
      run_id: "principal-run-1",
      caused_by: "dirty_state_panic",
      revision: 0,
      payload_json: {
        dossier_id: "dossier-1",
        worker_run_id: "worker-run-1",
        principal_run_id: "principal-run-1",
        trigger: "safety_gate_failure",
        panic_source: "worker_baseline_hard_stop",
        panic_summary: "active hard_stop refs: policy-hard-stop",
        affected_entity_count: 1
      }
    });
    expect(publishedEvents[1]).toMatchObject({
      event_type: "worker.state_changed",
      entity_type: "worker_run",
      entity_id: "worker-run-1",
      caused_by: "worker_lifecycle",
      payload_json: expect.objectContaining({
        workerId: "worker-run-1",
        state: "frozen",
        previousState: "init",
        panicSource: "worker_baseline_hard_stop",
        panicSummary: "active hard_stop refs: policy-hard-stop"
      })
    });
    expect(createSync).toHaveBeenCalledWith(dossier);
    expect(workerRunRepo.updateStateSync).toHaveBeenCalledWith(
      "worker-run-1",
      "init",
      "frozen",
      FIXED_NOW
    );
    expect(createSync.mock.invocationCallOrder[0]).toBeLessThan(
      workerRunRepo.updateStateSync.mock.invocationCallOrder[0]!
    );

    expect(workerStore.get("worker-run-1")?.state).toBe("frozen");
    expect(workerStore.get("worker-run-2")?.state).toBe("active");
  });

  it("rejects an invalid worker_run -> frozen transition before opening the transaction", async () => {
    const createSync = vi.fn((dossier: DirtyStateDossier) => dossier);
    const updateStateSync = vi.fn();
    const appendManyWithMutation = vi.fn();
    const service = new DirtyStatePanicService({
      workerRunRepo: {
        getById: vi.fn(async () => createWorkerRun({ state: "frozen" })),
        updateStateSync
      },
      eventPublisher: {
        appendManyWithMutation:
          appendManyWithMutation as unknown as DirtyStatePanicServiceDependencies["eventPublisher"]["appendManyWithMutation"]
      },
      dossierRepo: {
        createSync,
        deleteById: vi.fn(async () => undefined),
        findByWorkspace: vi.fn(),
        findByWorkerRun: vi.fn()
      },
      generateDossierId: () => "dossier-1",
      now: () => FIXED_NOW
    });

    // frozen -> frozen is forbidden by the worker-run-state-machine; the
    // invariant must be checked before any append is attempted.
    await expect(
      service.triggerPanic({
        workerRunId: "worker-run-1",
        trigger: "state_inconsistency",
        panicSource: "integration_gate",
        summary: "integration mismatch",
        affectedScope: []
      })
    ).rejects.toMatchObject({
      name: "CoreError",
      code: "VALIDATION"
    });

    expect(appendManyWithMutation).not.toHaveBeenCalled();
    expect(createSync).not.toHaveBeenCalled();
    expect(updateStateSync).not.toHaveBeenCalled();
  });

  it("accepts every B-8 panic trigger enum", async () => {
    const triggerKinds: readonly DirtyStatePanicTrigger[] = [
      "evidence_corruption",
      "governance_bypass",
      "state_inconsistency",
      "budget_violation",
      "safety_gate_failure",
      "manual"
    ];
    const appendManyWithMutation = fakeAppendManyWithMutation();
    const service = new DirtyStatePanicService({
      workerRunRepo: {
        getById: vi.fn(async () => createWorkerRun()),
        updateStateSync: vi.fn(() => createWorkerRun({ state: "frozen" }))
      },
      eventPublisher: {
        appendManyWithMutation:
          appendManyWithMutation as unknown as DirtyStatePanicServiceDependencies["eventPublisher"]["appendManyWithMutation"]
      },
      dossierRepo: {
        createSync: vi.fn((dossier: DirtyStateDossier) => dossier),
        deleteById: vi.fn(async () => undefined),
        findByWorkspace: vi.fn(),
        findByWorkerRun: vi.fn()
      },
      generateDossierId: () => "dossier-1",
      now: () => FIXED_NOW
    });

    for (const trigger of triggerKinds) {
      const dossier = await service.triggerPanic({
        workerRunId: "worker-run-1",
        trigger,
        panicSource: "integration_gate",
        summary: "integration mismatch",
        affectedScope: []
      });

      expect(dossier.trigger).toBe(trigger);
    }
  });

  it("fails with NOT_FOUND when the worker run does not exist", async () => {
    const service = new DirtyStatePanicService({
      workerRunRepo: {
        getById: vi.fn(async () => null),
        updateStateSync: vi.fn()
      },
      eventPublisher: {
        appendManyWithMutation: vi.fn()
      },
      dossierRepo: {
        createSync: vi.fn(),
        deleteById: vi.fn(),
        findByWorkspace: vi.fn(),
        findByWorkerRun: vi.fn()
      }
    });

    await expect(
      service.triggerPanic({
        workerRunId: "missing-worker-run",
        trigger: "manual",
        panicSource: "operator",
        summary: "manual panic",
        affectedScope: []
      })
    ).rejects.toEqual(new CoreError("NOT_FOUND", "Worker run not found"));
  });
});
