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

describe("DirtyStatePanicService", () => {
  it("uses publishWithMutation so panic events do not outlive dossier/freeze failures", async () => {
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
      getById: vi.fn(async (workerRunId: string) => workerStore.get(workerRunId) ?? null)
    };
    const publishWithMutation = vi.fn(
      async <T>(
        event: Omit<EventLogEntry, "event_id" | "created_at">,
        mutate: () => Promise<T>
      ): Promise<T> => await mutate()
    );
    const create = vi.fn(async (dossier: DirtyStateDossier) => dossier);
    const freeze = vi.fn(async (workerRunId: string, panicSource: string, summary: string) => {
      const current = workerStore.get(workerRunId);

      if (current === undefined) {
        throw new CoreError("NOT_FOUND", "Worker run not found");
      }

      workerStore.set(workerRunId, {
        ...current,
        state: "frozen",
        updated_at: FIXED_NOW
      });

      return workerStore.get(workerRunId)!;
    });

    const service = new DirtyStatePanicService({
      workerRunRepo,
      eventPublisher: {
        publishWithMutation:
          publishWithMutation as unknown as DirtyStatePanicServiceDependencies["eventPublisher"]["publishWithMutation"]
      },
      dossierRepo: {
        create,
        deleteById: vi.fn(async () => undefined),
        findByWorkspace: vi.fn(),
        findByWorkerRun: vi.fn()
      },
      workerRunLifecycle: { freeze },
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

    expect(publishWithMutation).toHaveBeenCalledWith({
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
    }, expect.any(Function));
    expect(create).toHaveBeenCalledWith(dossier);
    expect(freeze).toHaveBeenCalledWith(
      "worker-run-1",
      "worker_baseline_hard_stop",
      "active hard_stop refs: policy-hard-stop"
    );
    expect(create.mock.invocationCallOrder[0]).toBeLessThan(freeze.mock.invocationCallOrder[0]!);

    expect(workerStore.get("worker-run-1")?.state).toBe("frozen");
    expect(workerStore.get("worker-run-2")?.state).toBe("active");
  });

  it("does not leave a panic event appended when freeze fails after dossier persistence", async () => {
    const deleteById = vi.fn(async () => undefined);
    const publishWithMutation = vi.fn(
      async (
        _event: Omit<EventLogEntry, "event_id" | "created_at">,
        mutate: () => Promise<unknown>
      ) => await mutate()
    );
    const service = new DirtyStatePanicService({
      workerRunRepo: {
        getById: vi.fn(async () => createWorkerRun())
      },
      eventPublisher: {
        publishWithMutation:
          publishWithMutation as unknown as DirtyStatePanicServiceDependencies["eventPublisher"]["publishWithMutation"]
      },
      dossierRepo: {
        create: vi.fn(async (dossier: DirtyStateDossier) => dossier),
        deleteById,
        findByWorkspace: vi.fn(),
        findByWorkerRun: vi.fn()
      },
      workerRunLifecycle: {
        freeze: vi.fn(async () => {
          throw new CoreError("CONFLICT", "freeze failed");
        })
      },
      generateDossierId: () => "dossier-1",
      now: () => FIXED_NOW
    });

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
      code: "CONFLICT",
      message: "freeze failed"
    });

    expect(deleteById).toHaveBeenCalledWith("dossier-1");
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
    const publishWithMutation = vi.fn(
      async (
        _event: Omit<EventLogEntry, "event_id" | "created_at">,
        mutate: () => Promise<unknown>
      ) => await mutate()
    );
    const service = new DirtyStatePanicService({
      workerRunRepo: {
        getById: vi.fn(async () => createWorkerRun())
      },
      eventPublisher: {
        publishWithMutation:
          publishWithMutation as unknown as DirtyStatePanicServiceDependencies["eventPublisher"]["publishWithMutation"]
      },
      dossierRepo: {
        create: vi.fn(async (dossier: DirtyStateDossier) => dossier),
        deleteById: vi.fn(async () => undefined),
        findByWorkspace: vi.fn(),
        findByWorkerRun: vi.fn()
      },
      workerRunLifecycle: {
        freeze: vi.fn(async () => createWorkerRun({ state: "frozen" }))
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
        getById: vi.fn(async () => null)
      },
      eventPublisher: {
        publishWithMutation: vi.fn()
      },
      dossierRepo: {
        create: vi.fn(),
        deleteById: vi.fn(),
        findByWorkspace: vi.fn(),
        findByWorkerRun: vi.fn()
      },
      workerRunLifecycle: {
        freeze: vi.fn()
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
