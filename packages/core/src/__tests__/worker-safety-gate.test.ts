import {
  WorkerBaselineLockSchema,
  type DelegatedWorkerRun,
  type WorkerSafetyPort
} from "@do-soul/alaya-protocol";
import { describe, expect, it, vi } from "vitest";
import { CoreError } from "../errors.js";
import { WorkerSafetyGate } from "../worker-safety-gate.js";

function createWorkerRun(overrides: Partial<DelegatedWorkerRun> = {}): DelegatedWorkerRun {
  return {
    worker_run_id: "worker-1",
    principal_run_id: "run-1",
    workspace_id: "workspace-1",
    requesting_run_id: "run-1",
    engine_class: "coding_engine",
    state: "init",
    subtask_description: "Apply worker baseline safety before dispatch.",
    local_surface_ref: "surface://task/main",
    local_evidence_pointer: null,
    restricted_tool_set: ["read"],
    local_budget: {
      max_worker_delegations: 1,
      max_tool_calls: 4,
      max_output_tokens: 2048,
      max_wall_time_ms: 60000
    },
    agreed_return_format: {
      allowed_return_kinds: ["handoff"],
      requires_structured_summary: true
    },
    principal_security_snapshot: {
      governance_lease_ref: "lease-1",
      hard_constraint_refs: ["claim-1", "claim-2"],
      denied_tool_categories: ["network"]
    },
    created_at: "2026-04-13T00:00:00.000Z",
    updated_at: "2026-04-13T00:00:00.000Z",
    ...overrides
  };
}

function createLock(overrides: Partial<ReturnType<typeof WorkerBaselineLockSchema.parse>> = {}) {
  return WorkerBaselineLockSchema.parse({
    lock_id: "lock-1",
    workspace_id: "workspace-1",
    hard_constraint_refs: ["claim-1"],
    denied_tool_categories: ["network"],
    hazard_object_refs: ["hazard-1"],
    hard_stop_refs: ["hard-stop-1"],
    assembled_at: "2026-04-13T00:00:00.000Z",
    ...overrides
  });
}

function createPort(
  implementation?: (workspaceId: string) => Promise<ReturnType<typeof createLock>>
): WorkerSafetyPort & { readonly assembleBaselineLock: ReturnType<typeof vi.fn> } {
  const assembleBaselineLock = vi.fn(
    implementation ??
      (async () => {
        return createLock();
      })
  );

  return {
    kind: "test-worker-safety-port",
    assembleBaselineLock
  };
}

describe("WorkerSafetyGate", () => {
  it("returns the assembled baseline lock when the snapshot covers all lock hard constraints", async () => {
    const lock = createLock({
      hard_constraint_refs: ["claim-1", "claim-2"]
    });
    const port = createPort(async () => lock);
    const gate = new WorkerSafetyGate({ safetyPort: port });
    const workerRun = createWorkerRun({
      principal_security_snapshot: {
        governance_lease_ref: "lease-1",
        hard_constraint_refs: ["claim-1", "claim-2", "claim-extra"],
        denied_tool_categories: ["network"]
      }
    });

    const result = await gate.enforceBeforeDispatch(workerRun);

    expect(WorkerBaselineLockSchema.parse(result)).toEqual(lock);
    expect(port.assembleBaselineLock).toHaveBeenCalledWith("workspace-1");
  });

  it("wraps port failures as CoreError VALIDATION and refuses degraded mode dispatch", async () => {
    const cause = new Error("cold layer unavailable");
    const port = createPort(async () => {
      throw cause;
    });
    const gate = new WorkerSafetyGate({ safetyPort: port });

    const error = await gate.enforceBeforeDispatch(createWorkerRun()).catch((caught) => caught);

    expect(error).toBeInstanceOf(CoreError);
    expect(error.code).toBe("VALIDATION");
    expect(error.message).toContain("degraded mode");
    expect(error.cause).toBe(cause);
  });

  it("rejects dispatch when the worker snapshot is missing baseline hard constraints", async () => {
    const port = createPort(async () =>
      createLock({
        hard_constraint_refs: ["claim-1", "claim-2"]
      })
    );
    const gate = new WorkerSafetyGate({ safetyPort: port });
    const workerRun = createWorkerRun({
      principal_security_snapshot: {
        governance_lease_ref: "lease-1",
        hard_constraint_refs: ["claim-1"],
        denied_tool_categories: ["network"]
      }
    });

    const error = await gate.enforceBeforeDispatch(workerRun).catch((caught) => caught);

    expect(error).toBeInstanceOf(CoreError);
    expect(error.code).toBe("VALIDATION");
    expect(error.message).toContain("missing 1 hard constraint ref(s)");
  });

  it("allows empty hard constraint sets on both the baseline lock and the worker snapshot", async () => {
    const port = createPort(async () =>
      createLock({
        hard_constraint_refs: []
      })
    );
    const gate = new WorkerSafetyGate({ safetyPort: port });
    const workerRun = createWorkerRun({
      principal_security_snapshot: {
        governance_lease_ref: "lease-1",
        hard_constraint_refs: [],
        denied_tool_categories: ["network"]
      }
    });

    await expect(gate.enforceBeforeDispatch(workerRun)).resolves.toEqual(
      createLock({
        hard_constraint_refs: []
      })
    );
  });

  it("allows worker snapshots that are supersets of the baseline lock", async () => {
    const lock = createLock({
      hard_constraint_refs: ["claim-1"]
    });
    const port = createPort(async () => lock);
    const gate = new WorkerSafetyGate({ safetyPort: port });
    const workerRun = createWorkerRun({
      principal_security_snapshot: {
        governance_lease_ref: "lease-1",
        hard_constraint_refs: ["claim-1", "claim-extra"],
        denied_tool_categories: ["network"]
      }
    });

    await expect(gate.enforceBeforeDispatch(workerRun)).resolves.toEqual(lock);
  });
});
