import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimePort, DelegatedWorkerRun, RuntimeEvent } from "@do-soul/alaya-protocol";
import { CoreError } from "../../errors.js";
import { SerialDelegationRecovery } from "../../runtime/serial-delegation-recovery.js";
import type { WorkerRunLifecycleService } from "../../runtime/worker-run-lifecycle-service.js";

const FIXED_NOW = "2026-04-15T12:00:00.000Z";

describe("SerialDelegationRecovery", () => {
  it("checks ConstraintProxy before worker completion on session_finished(completed)", async () => {
    const workerRunLifecycle = {
      complete: vi.fn(),
      suspend: vi.fn(),
      abort: vi.fn(),
      freeze: vi.fn()
    } as unknown as WorkerRunLifecycleService;
    const constraintProxy = {
      assertNoViolation: vi.fn(async () => {
        throw new CoreError(
          "OBLIGATION_VIOLATION",
          "Operation worker_complete blocked by active deferred obligations."
        );
      })
    };
    const recovery = new SerialDelegationRecovery({
      workerRunLifecycle,
      workerRunRepo: {
        getById: vi.fn(async () =>
          createWorkerRun({
            worker_run_id: "worker-1",
            principal_run_id: "run-1",
            workspace_id: "workspace-1",
            state: "active"
          })
        ),
        deleteIfState: vi.fn()
      },
      eventNormalizer: {
        normalize: vi.fn(async () => null),
        clearSessionState: vi.fn()
      },
      constraintProxy
    });

    await expect(
      recovery.handleRuntimeEvent(
        createSessionFinishedEvent("completed"),
        {
          workspaceId: "workspace-1",
          principalRunId: "run-1",
          workerRunId: "worker-1"
        },
        "worker-1",
        vi.fn(),
        vi.fn()
      )
    ).rejects.toMatchObject({
      name: "CoreError",
      code: "OBLIGATION_VIOLATION"
    });

    expect(constraintProxy.assertNoViolation).toHaveBeenCalledWith(
      "workspace-1",
      "run-1",
      "worker_complete"
    );
    expect(workerRunLifecycle.complete).not.toHaveBeenCalled();
    expect(workerRunLifecycle.abort).not.toHaveBeenCalled();
    expect(workerRunLifecycle.suspend).not.toHaveBeenCalled();
  });

  it("suspends completion-time obligation violations during event-failure recovery", async () => {
    const workerRunLifecycle = {
      complete: vi.fn(),
      suspend: vi.fn(async () => createWorkerRun({ state: "suspended" })),
      abort: vi.fn(),
      freeze: vi.fn()
    } as unknown as WorkerRunLifecycleService;
    const eventNormalizer = {
      normalize: vi.fn(async () => null),
      clearSessionState: vi.fn()
    };
    const recovery = new SerialDelegationRecovery({
      workerRunLifecycle,
      workerRunRepo: {
        getById: vi.fn(async () => createWorkerRun({ state: "active" })),
        deleteIfState: vi.fn()
      },
      eventNormalizer,
      constraintProxy: {
        assertNoViolation: vi.fn(async () => undefined)
      }
    });

    await recovery.handleRuntimeEventFailure({
      error: new CoreError(
        "OBLIGATION_VIOLATION",
        "Operation worker_complete blocked by active deferred obligations."
      ),
      event: createSessionFinishedEvent("completed"),
      context: {
        workspaceId: "workspace-1",
        principalRunId: "run-1",
        workerRunId: "worker-1"
      },
      workerRunId: "worker-1",
      sessionId: "session-1",
      runtimeAdapter: {
        cancel: vi.fn(async () => undefined)
      } as unknown as AgentRuntimePort,
      unsubscribe: vi.fn(),
      stopEventIntake: vi.fn(),
      resumeEventIntake: vi.fn(),
      awaitPendingSessionFinishedEvent: vi.fn(async () => null),
      clearPendingSessionFinishedEvent: vi.fn()
    });

    expect(workerRunLifecycle.suspend).toHaveBeenCalledWith("worker-1", "obligation_violation");
    expect(workerRunLifecycle.abort).not.toHaveBeenCalled();
    expect(workerRunLifecycle.freeze).not.toHaveBeenCalled();
    expect(eventNormalizer.clearSessionState).toHaveBeenCalledWith("session-1");
  });
});

function createWorkerRun(overrides: Partial<DelegatedWorkerRun>): DelegatedWorkerRun {
  return {
    worker_run_id: overrides.worker_run_id ?? "worker-1",
    principal_run_id: overrides.principal_run_id ?? "run-1",
    workspace_id: overrides.workspace_id ?? "workspace-1",
    requesting_run_id: overrides.requesting_run_id ?? "run-1",
    engine_class: overrides.engine_class ?? "coding_engine",
    state: overrides.state ?? "active",
    subtask_description: overrides.subtask_description ?? "Investigate deferred obligation behavior.",
    local_surface_ref: overrides.local_surface_ref ?? "surface://task/main",
    local_evidence_pointer: overrides.local_evidence_pointer ?? null,
    restricted_tool_set: overrides.restricted_tool_set ?? ["read_file"],
    local_budget:
      overrides.local_budget ?? {
        max_worker_delegations: 1,
        max_tool_calls: 4,
        max_output_tokens: 2048,
        max_wall_time_ms: 120000
      },
    agreed_return_format:
      overrides.agreed_return_format ?? {
        allowed_return_kinds: ["analysis_note"],
        requires_structured_summary: true
      },
    principal_security_snapshot:
      overrides.principal_security_snapshot ?? {
        governance_lease_ref: "lease://1",
        hard_constraint_refs: [],
        denied_tool_categories: []
      },
    created_at: overrides.created_at ?? FIXED_NOW,
    updated_at: overrides.updated_at ?? FIXED_NOW
  };
}

function createSessionFinishedEvent(
  status: "completed" | "cancelled" | "failed"
): Extract<RuntimeEvent, { readonly type: "session_finished" }> {
  return {
    type: "session_finished",
    session_id: "session-1",
    emitted_at: FIXED_NOW,
    status,
    result_summary: null
  };
}
