import { describe, expect, it, vi } from "vitest";
import { IntegrationGatePublicationError } from "../../security/integration-gate.js";
import { FIXED_NOW, FIXED_WORKER_RUN_ID, createDispatchInput, createHarness, createIntegrationDecision, createWorkerRun } from "./serial-delegation-service-test-fixtures.js";

describe("SerialDelegationService", () => {
it("freezes from init and rejects before runtime startup when the integration gate returns hard_stale", async () => {
    const integrationGate = {
      check: vi.fn(async () =>
        createIntegrationDecision(
          "hard_stale",
          "supports_streaming_updates expected=true actual=false"
        )
      )
    };
    const harness = createHarness([], {
      integrationGate
    });
    const freezeSpy = vi.spyOn(harness.workerRunLifecycle, "freeze");
    const abortSpy = vi.spyOn(harness.workerRunLifecycle, "abort");
    const dispatchSpy = vi.spyOn(harness.workerRunLifecycle, "dispatch");
    const createSessionSpy = vi.spyOn(harness.runtimeAdapter, "createSession");
    const promptSpy = vi.spyOn(harness.runtimeAdapter, "prompt");

    await expect(harness.service.dispatch(createDispatchInput())).rejects.toMatchObject({
      name: "CoreError",
      code: "CONFLICT",
      message:
        "Serial delegation blocked by integration gate: supports_streaming_updates expected=true actual=false"
    });

    expect(freezeSpy).toHaveBeenCalledWith(
      FIXED_WORKER_RUN_ID,
      "integration_gate",
      "supports_streaming_updates expected=true actual=false"
    );
    expect(harness.dirtyStatePanicService.triggerPanic).toHaveBeenCalledWith({
      workerRunId: FIXED_WORKER_RUN_ID,
      trigger: "state_inconsistency",
      panicSource: "integration_gate",
      summary: "supports_streaming_updates expected=true actual=false",
      affectedScope: [{ entity_type: "integration_decision", entity_id: "hard_stale" }]
    });
    expect(abortSpy).not.toHaveBeenCalled();
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(createSessionSpy).not.toHaveBeenCalled();
    expect(promptSpy).not.toHaveBeenCalled();
    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "frozen",
        updated_at: FIXED_NOW
      })
    );
  });

it("rolls back the inserted init worker when integration gate evaluation throws and freeze recovery also fails", async () => {
    const integrationGate = {
      check: vi.fn(async () => {
        throw new Error("integration event publish exploded");
      })
    };
    const harness = createHarness([], {
      integrationGate
    });
    const freezeSpy = vi
      .spyOn(harness.workerRunLifecycle, "freeze")
      .mockRejectedValueOnce(new Error("freeze exploded"));
    const createSessionSpy = vi.spyOn(harness.runtimeAdapter, "createSession");

    await expect(harness.service.dispatch(createDispatchInput())).rejects.toThrow(
      "integration event publish exploded"
    );

    expect(freezeSpy).toHaveBeenCalledWith(
      FIXED_WORKER_RUN_ID,
      "serial_delegation_preflight",
      "pre-dispatch guard failure"
    );
    expect(harness.repo.deleteIfState).toHaveBeenCalledWith(FIXED_WORKER_RUN_ID, "init");
    expect(createSessionSpy).not.toHaveBeenCalled();
    expect(harness.getById(FIXED_WORKER_RUN_ID)).toBeNull();
  });

it("releases pre-dispatch strong refs when protection partially succeeds and freeze recovery fails", async () => {
    const strongRefService = {
      protect: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("strong ref protect exploded")),
      releaseBySource: vi.fn(async () => undefined)
    };
    const harness = createHarness([], {
      strongRefService
    });
    const freezeSpy = vi
      .spyOn(harness.workerRunLifecycle, "freeze")
      .mockRejectedValueOnce(new Error("freeze exploded"));

    await expect(
      harness.service.dispatch(
        createDispatchInput({
          principalSecuritySnapshot: {
            governance_lease_ref: "lease://principal/1",
            hard_constraint_refs: ["constraint://1", "constraint://2"],
            denied_tool_categories: ["network"]
          }
        })
      )
    ).rejects.toThrow("strong ref protect exploded");

    expect(strongRefService.protect).toHaveBeenCalledTimes(2);
    expect(freezeSpy).toHaveBeenCalledWith(
      FIXED_WORKER_RUN_ID,
      "serial_delegation_preflight",
      "pre-dispatch guard failure"
    );
    expect(strongRefService.releaseBySource).toHaveBeenCalledWith({
      sourceEntityType: "worker_run",
      sourceEntityId: FIXED_WORKER_RUN_ID
    });
    expect(harness.repo.deleteIfState).toHaveBeenCalledWith(FIXED_WORKER_RUN_ID, "init");
    expect(harness.getById(FIXED_WORKER_RUN_ID)).toBeNull();
  });

it("does not roll back the inserted worker when integration gate publish failed after durable append", async () => {
    const integrationGate = {
      check: vi.fn(async () => {
        throw new IntegrationGatePublicationError(
          createIntegrationDecision(
            "soft_stale",
            "supports_interrupt expected=true actual=false"
          ),
          new Error("broadcast exploded"),
          true
        );
      })
    };
    const harness = createHarness([], {
      integrationGate
    });
    const freezeSpy = vi.spyOn(harness.workerRunLifecycle, "freeze");

    await expect(harness.service.dispatch(createDispatchInput())).rejects.toMatchObject({
      name: "IntegrationGatePublicationError",
      durableDecisionCommitted: true,
      decision: expect.objectContaining({
        level: "soft_stale",
        reason: "supports_interrupt expected=true actual=false"
      })
    });

    expect(freezeSpy).toHaveBeenCalledTimes(1);
    expect(freezeSpy).toHaveBeenCalledWith(
      FIXED_WORKER_RUN_ID,
      "integration_gate",
      "supports_interrupt expected=true actual=false"
    );
    expect(harness.repo.deleteIfState).not.toHaveBeenCalled();
    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "frozen",
        updated_at: FIXED_NOW
      })
    );
  });

it("retries lifecycle freeze when hard_stale recovery starts from a still-init worker", async () => {
    const integrationGate = {
      check: vi.fn(async () =>
        createIntegrationDecision(
          "hard_stale",
          "supports_streaming_updates expected=true actual=false"
        )
      )
    };
    const harness = createHarness([], {
      integrationGate
    });
    const freezeSpy = vi
      .spyOn(harness.workerRunLifecycle, "freeze")
      .mockRejectedValueOnce(new Error("freeze exploded"));
    const createSessionSpy = vi.spyOn(harness.runtimeAdapter, "createSession");

    await expect(harness.service.dispatch(createDispatchInput())).rejects.toMatchObject({
      name: "CoreError",
      code: "CONFLICT",
      message:
        "Serial delegation blocked by integration gate: supports_streaming_updates expected=true actual=false"
    });

    expect(freezeSpy).toHaveBeenCalledTimes(2);
    expect(freezeSpy).toHaveBeenNthCalledWith(
      1,
      FIXED_WORKER_RUN_ID,
      "integration_gate",
      "supports_streaming_updates expected=true actual=false"
    );
    expect(freezeSpy).toHaveBeenNthCalledWith(
      2,
      FIXED_WORKER_RUN_ID,
      "integration_gate",
      "supports_streaming_updates expected=true actual=false"
    );
    expect(harness.repo.deleteIfState).not.toHaveBeenCalled();
    expect(createSessionSpy).not.toHaveBeenCalled();
    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "frozen",
        updated_at: FIXED_NOW
      })
    );
  });

it("preserves the hard_stale conflict when freeze already committed before throwing", async () => {
    const integrationGate = {
      check: vi.fn(async () =>
        createIntegrationDecision(
          "hard_stale",
          "supports_streaming_updates expected=true actual=false"
        )
      )
    };
    const harness = createHarness([], {
      integrationGate
    });
    const freezeSpy = vi.spyOn(harness.workerRunLifecycle, "freeze").mockImplementationOnce(
      async (workerRunId: string) => {
        await harness.repo.updateState(workerRunId, "init", "frozen", FIXED_NOW);
        throw new Error("freeze exploded");
      }
    );

    await expect(harness.service.dispatch(createDispatchInput())).rejects.toMatchObject({
      name: "CoreError",
      code: "CONFLICT",
      message:
        "Serial delegation blocked by integration gate: supports_streaming_updates expected=true actual=false"
    });

    expect(freezeSpy).toHaveBeenCalledWith(
      FIXED_WORKER_RUN_ID,
      "integration_gate",
      "supports_streaming_updates expected=true actual=false"
    );
    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "frozen",
        updated_at: FIXED_NOW
      })
    );
  });

it("converts an in-flight storage conflict into CoreError('CONFLICT')", async () => {
    const harness = createHarness([]);

    await harness.service.dispatch(createDispatchInput());

    await expect(harness.service.dispatch(createDispatchInput())).rejects.toMatchObject({
      name: "CoreError",
      code: "CONFLICT",
      message: "Serial delegation: principal principal-run-1 already has an in-flight worker"
    });
  });

it("treats a suspended worker as in-flight for serial conflict checks", async () => {
    const harness = createHarness([], {
      existingRuns: [
        createWorkerRun({
          worker_run_id: "worker-run-existing-suspended",
          state: "suspended"
        })
      ]
    });

    await expect(harness.service.dispatch(createDispatchInput())).rejects.toMatchObject({
      name: "CoreError",
      code: "CONFLICT",
      message: "Serial delegation: principal principal-run-1 already has an in-flight worker"
    });
  });
});
