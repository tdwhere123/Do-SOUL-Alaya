import { describe, expect, it, vi } from "vitest";
import type { DelegatedWorkerRun, WorkerBaselineLock } from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import { FIXED_NOW, FIXED_WORKER_RUN_ID, createDispatchInput, createHarness, createIntegrationDecision, createManualRuntimeAdapter, createWorkerBaselineLock, createWorkerRun } from "./serial-delegation-service-test-fixtures.js";

describe("SerialDelegationService", () => {
it("dispatches init -> active before creating a runtime session and prompting", async () => {
    const harness = createHarness([]);
    const createSessionSpy = vi.spyOn(harness.runtimeAdapter, "createSession");
    const promptSpy = vi.spyOn(harness.runtimeAdapter, "prompt");
    const dispatchSpy = vi.spyOn(harness.workerRunLifecycle, "dispatch");

    const result = await harness.service.dispatch(createDispatchInput());

    expect(result).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "active",
        updated_at: FIXED_NOW
      })
    );
    expect(harness.repo.insertIfNoActiveForPrincipal).toHaveBeenCalledWith(
      "principal-run-1",
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "init"
      })
    );
    expect(dispatchSpy).toHaveBeenCalledWith(FIXED_WORKER_RUN_ID);
    expect(createSessionSpy).toHaveBeenCalledWith(createDispatchInput().sessionConfig);
    expect(promptSpy).toHaveBeenCalledWith("scripted-session-1", {
      prompt: createDispatchInput().prompt
    });

    expect(
      harness.repo.insertIfNoActiveForPrincipal.mock.invocationCallOrder[0]
    ).toBeLessThan(dispatchSpy.mock.invocationCallOrder[0]!);
    expect(dispatchSpy.mock.invocationCallOrder[0]).toBeLessThan(
      createSessionSpy.mock.invocationCallOrder[0]!
    );
    expect(createSessionSpy.mock.invocationCallOrder[0]).toBeLessThan(
      promptSpy.mock.invocationCallOrder[0]!
    );
  });

it("runs worker safety, zero-day augmentation, insert, and integration check before runtime startup on ignore_drift", async () => {
    const workerSafetyGate = {
      enforceBeforeDispatch: vi.fn(async () => createWorkerBaselineLock())
    };
    const zeroDaySecurityLayer = {
      augmentLock: vi.fn(async (lock: WorkerBaselineLock) => lock)
    };
    const integrationGate = {
      check: vi.fn(async () => createIntegrationDecision("ignore_drift"))
    };
    const harness = createHarness([], {
      workerSafetyGate,
      zeroDaySecurityLayer,
      integrationGate
    });
    const createSessionSpy = vi.spyOn(harness.runtimeAdapter, "createSession");
    const dispatchSpy = vi.spyOn(harness.workerRunLifecycle, "dispatch");

    await harness.service.dispatch(createDispatchInput());

    expect(workerSafetyGate.enforceBeforeDispatch).toHaveBeenCalledWith(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "init"
      })
    );
    expect(zeroDaySecurityLayer.augmentLock).toHaveBeenCalledWith(createWorkerBaselineLock());
    expect(integrationGate.check).toHaveBeenCalledWith(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "init"
      }),
      harness.runtimeAdapter.getCapabilities()
    );
    expect(
      workerSafetyGate.enforceBeforeDispatch.mock.invocationCallOrder[0]
    ).toBeLessThan(zeroDaySecurityLayer.augmentLock.mock.invocationCallOrder[0]!);
    expect(zeroDaySecurityLayer.augmentLock.mock.invocationCallOrder[0]).toBeLessThan(
      harness.repo.insertIfNoActiveForPrincipal.mock.invocationCallOrder[0]!
    );
    expect(harness.repo.insertIfNoActiveForPrincipal.mock.invocationCallOrder[0]).toBeLessThan(
      integrationGate.check.mock.invocationCallOrder[0]!
    );
    expect(integrationGate.check.mock.invocationCallOrder[0]).toBeLessThan(
      dispatchSpy.mock.invocationCallOrder[0]!
    );
    expect(dispatchSpy.mock.invocationCallOrder[0]).toBeLessThan(
      createSessionSpy.mock.invocationCallOrder[0]!
    );
  });

it("rejects dispatch on completion-time obligation violations, suspends the worker, and avoids panic", async () => {
    const manual = createManualRuntimeAdapter({
      prompt: async (_sessionId, _input, emit) => {
        emit({
          type: "session_finished",
          session_id: "scripted-session-1",
          emitted_at: FIXED_NOW,
          status: "completed",
          result_summary: null
        });
      }
    });
    const constraintProxy = {
      assertNoViolation: vi.fn(async () => {
        throw new CoreError(
          "OBLIGATION_VIOLATION",
          "Operation worker_complete blocked by active deferred obligations."
        );
      })
    };
    const harness = createHarness([], {
      runtimeAdapter: manual.adapter,
      constraintProxy
    });
    const abortSpy = vi.spyOn(harness.workerRunLifecycle, "abort");
    const suspendSpy = vi.spyOn(harness.workerRunLifecycle, "suspend");
    const freezeSpy = vi.spyOn(harness.workerRunLifecycle, "freeze");

    await expect(harness.service.dispatch(createDispatchInput())).rejects.toMatchObject({
      name: "CoreError",
      code: "OBLIGATION_VIOLATION"
    });

    expect(constraintProxy.assertNoViolation).toHaveBeenCalledWith(
      "ws-serial-delegation",
      "principal-run-1",
      "worker_complete"
    );
    expect(abortSpy).not.toHaveBeenCalled();
    expect(suspendSpy).toHaveBeenCalledWith(FIXED_WORKER_RUN_ID, "obligation_violation");
    expect(freezeSpy).not.toHaveBeenCalled();
    expect(harness.strongRefService.releaseBySource).toHaveBeenCalledWith({
      sourceEntityType: "worker_run",
      sourceEntityId: FIXED_WORKER_RUN_ID
    });
    expect(harness.getById(FIXED_WORKER_RUN_ID)?.state).toBe("suspended");
  });

it("fails closed before insert when workerSafetyGate violates the lock contract", async () => {
    const workerSafetyGate = {
      enforceBeforeDispatch: vi.fn(async () => null as unknown as WorkerBaselineLock)
    };
    const zeroDaySecurityLayer = {
      augmentLock: vi.fn(async (lock: WorkerBaselineLock) => lock)
    };
    const harness = createHarness([], {
      workerSafetyGate,
      zeroDaySecurityLayer
    });
    const createSessionSpy = vi.spyOn(harness.runtimeAdapter, "createSession");
    const promptSpy = vi.spyOn(harness.runtimeAdapter, "prompt");
    const dispatchSpy = vi.spyOn(harness.workerRunLifecycle, "dispatch");

    await expect(harness.service.dispatch(createDispatchInput())).rejects.toEqual(
      new CoreError("VALIDATION", "Serial delegation requires a non-null worker baseline lock.")
    );

    expect(zeroDaySecurityLayer.augmentLock).not.toHaveBeenCalled();
    expect(harness.repo.insertIfNoActiveForPrincipal).not.toHaveBeenCalled();
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(createSessionSpy).not.toHaveBeenCalled();
    expect(promptSpy).not.toHaveBeenCalled();
  });

it("fails closed before insert when zeroDaySecurityLayer violates the lock contract", async () => {
    const workerSafetyGate = {
      enforceBeforeDispatch: vi.fn(async () => createWorkerBaselineLock())
    };
    const zeroDaySecurityLayer = {
      augmentLock: vi.fn(async () => null as unknown as WorkerBaselineLock)
    };
    const harness = createHarness([], {
      workerSafetyGate,
      zeroDaySecurityLayer
    });
    const createSessionSpy = vi.spyOn(harness.runtimeAdapter, "createSession");
    const promptSpy = vi.spyOn(harness.runtimeAdapter, "prompt");
    const dispatchSpy = vi.spyOn(harness.workerRunLifecycle, "dispatch");

    await expect(harness.service.dispatch(createDispatchInput())).rejects.toEqual(
      new CoreError("VALIDATION", "Serial delegation requires a non-null augmented worker baseline lock.")
    );

    expect(harness.repo.insertIfNoActiveForPrincipal).not.toHaveBeenCalled();
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(createSessionSpy).not.toHaveBeenCalled();
    expect(promptSpy).not.toHaveBeenCalled();
  });

it("persists zero-day denied categories onto the durable worker snapshot", async () => {
    const workerSafetyGate = {
      enforceBeforeDispatch: vi.fn(async () => createWorkerBaselineLock())
    };
    const zeroDaySecurityLayer = {
      augmentLock: vi.fn(async () =>
        createWorkerBaselineLock({
          denied_tool_categories: ["network", "write"]
        })
      )
    };
    const harness = createHarness([], {
      workerSafetyGate,
      zeroDaySecurityLayer
    });

    const result = await harness.service.dispatch(createDispatchInput());

    expect(result.principal_security_snapshot.denied_tool_categories).toEqual([
      "network",
      "write"
    ]);
    expect(harness.getById(FIXED_WORKER_RUN_ID)?.principal_security_snapshot.denied_tool_categories).toEqual([
      "network",
      "write"
    ]);
  });

it("persists augmented hard constraint refs onto the durable worker snapshot", async () => {
    const workerSafetyGate = {
      enforceBeforeDispatch: vi.fn(async () => createWorkerBaselineLock())
    };
    const zeroDaySecurityLayer = {
      augmentLock: vi.fn(async () =>
        createWorkerBaselineLock({
          hard_constraint_refs: ["claim-1", "claim-2"]
        })
      )
    };
    const harness = createHarness([], {
      workerSafetyGate,
      zeroDaySecurityLayer
    });

    const result = await harness.service.dispatch(createDispatchInput());

    expect(result.principal_security_snapshot.hard_constraint_refs).toEqual([
      "constraint://1",
      "claim-1",
      "claim-2"
    ]);
    expect(harness.getById(FIXED_WORKER_RUN_ID)?.principal_security_snapshot.hard_constraint_refs).toEqual([
      "constraint://1",
      "claim-1",
      "claim-2"
    ]);
  });

it("resolves runtime prompt from the final augmented worker security snapshot when requested", async () => {
    const manual = createManualRuntimeAdapter({
      prompt: async (_sessionId, _input, emit) => {
        emit({
          type: "session_finished",
          session_id: "scripted-session-1",
          emitted_at: FIXED_NOW,
          status: "completed",
          result_summary: null
        });
      }
    });
    const zeroDaySecurityLayer = {
      augmentLock: vi.fn(async () =>
        createWorkerBaselineLock({
          hard_constraint_refs: ["claim-augmented"],
          denied_tool_categories: ["network", "write"]
        })
      )
    };
    const harness = createHarness([], {
      runtimeAdapter: manual.adapter,
      zeroDaySecurityLayer
    });
    const resolveRuntimePromptFromFinalSecuritySnapshot = vi.fn(
      ({ workerRun }: { readonly workerRun: Readonly<DelegatedWorkerRun> }) =>
        [
          `lease=${workerRun.principal_security_snapshot.governance_lease_ref}`,
          `refs=${workerRun.principal_security_snapshot.hard_constraint_refs.join(",")}`,
          `denied=${workerRun.principal_security_snapshot.denied_tool_categories.join(",")}`
        ].join("\n")
    );

    await harness.service.dispatch(
      createDispatchInput({
        resolveRuntimePromptFromFinalSecuritySnapshot
      })
    );

    expect(resolveRuntimePromptFromFinalSecuritySnapshot).toHaveBeenCalledWith({
      workerRun: expect.objectContaining({
        principal_security_snapshot: {
          governance_lease_ref: "lease://principal/1",
          hard_constraint_refs: ["constraint://1", "claim-augmented"],
          denied_tool_categories: ["network", "write"]
        }
      })
    });
    expect(harness.runtimeAdapter.prompt).toHaveBeenCalledWith("scripted-session-1", {
      prompt: expect.stringContaining("refs=constraint://1,claim-augmented")
    });
  });

it("creates strong refs for effective hard constraints during live single-worker dispatch", async () => {
    const workerSafetyGate = {
      enforceBeforeDispatch: vi.fn(async () =>
        createWorkerBaselineLock({
          hard_constraint_refs: ["claim-1", "claim-2", "claim-2"]
        })
      )
    };
    const harness = createHarness([], {
      workerSafetyGate
    });

    await harness.service.dispatch(createDispatchInput());

    expect(harness.strongRefService.protect).toHaveBeenCalledTimes(3);
    expect(harness.strongRefService.protect).toHaveBeenNthCalledWith(1, {
      sourceEntityType: "worker_run",
      sourceEntityId: FIXED_WORKER_RUN_ID,
      targetEntityType: "claim_form",
      targetEntityId: "constraint://1",
      workspaceId: "ws-serial-delegation",
      reason: "security_snapshot"
    });
    expect(harness.strongRefService.protect).toHaveBeenNthCalledWith(2, {
      sourceEntityType: "worker_run",
      sourceEntityId: FIXED_WORKER_RUN_ID,
      targetEntityType: "claim_form",
      targetEntityId: "claim-1",
      workspaceId: "ws-serial-delegation",
      reason: "security_snapshot"
    });
    expect(harness.strongRefService.protect).toHaveBeenNthCalledWith(3, {
      sourceEntityType: "worker_run",
      sourceEntityId: FIXED_WORKER_RUN_ID,
      targetEntityType: "claim_form",
      targetEntityId: "claim-2",
      workspaceId: "ws-serial-delegation",
      reason: "security_snapshot"
    });
  });

it("releases worker-run strong refs once session_finished(completed) settles", async () => {
    const manual = createManualRuntimeAdapter({
      prompt: async (_sessionId, _input, emit) => {
        emit({
          type: "session_finished",
          session_id: "scripted-session-1",
          emitted_at: FIXED_NOW,
          status: "completed",
          result_summary: null
        });
      }
    });
    const harness = createHarness([], {
      runtimeAdapter: manual.adapter
    });

    await harness.service.dispatch(createDispatchInput());

    expect(harness.strongRefService.protect).toHaveBeenCalled();
    expect(harness.strongRefService.releaseBySource).toHaveBeenCalledWith({
      sourceEntityType: "worker_run",
      sourceEntityId: FIXED_WORKER_RUN_ID
    });
    expect(harness.getById(FIXED_WORKER_RUN_ID)?.state).toBe("completed");
  });

it("merges augmented lock constraints monotonically with the principal security snapshot", async () => {
    const workerSafetyGate = {
      enforceBeforeDispatch: vi.fn(async () =>
        createWorkerBaselineLock({
          hard_constraint_refs: ["constraint://1", "claim-1"],
          denied_tool_categories: ["network", "write"]
        })
      )
    };
    const zeroDaySecurityLayer = {
      augmentLock: vi.fn(async () =>
        createWorkerBaselineLock({
          hard_constraint_refs: ["constraint://1", "claim-1", "claim-2"],
          denied_tool_categories: ["network", "write", "exec"]
        })
      )
    };
    const harness = createHarness([], {
      workerSafetyGate,
      zeroDaySecurityLayer
    });

    const result = await harness.service.dispatch(
      createDispatchInput({
        principalSecuritySnapshot: {
          governance_lease_ref: "lease://principal/1",
          hard_constraint_refs: ["constraint://1", "constraint://principal-extra"],
          denied_tool_categories: ["network", "governance"]
        }
      })
    );

    expect(result.principal_security_snapshot).toEqual({
      governance_lease_ref: "lease://principal/1",
      hard_constraint_refs: ["constraint://1", "constraint://principal-extra", "claim-1", "claim-2"],
      denied_tool_categories: ["network", "governance", "write", "exec"]
    });
    expect(harness.getById(FIXED_WORKER_RUN_ID)?.principal_security_snapshot).toEqual(
      result.principal_security_snapshot
    );
  });

it("freezes from init and rejects before integration checks when the augmented baseline carries hard_stop refs", async () => {
    const workerSafetyGate = {
      enforceBeforeDispatch: vi.fn(async () => createWorkerBaselineLock())
    };
    const zeroDaySecurityLayer = {
      augmentLock: vi.fn(async () =>
        createWorkerBaselineLock({
          hard_stop_refs: ["policy-hard-stop"]
        })
      )
    };
    const integrationGate = {
      check: vi.fn(async () => createIntegrationDecision("ignore_drift"))
    };
    const harness = createHarness([], {
      workerSafetyGate,
      zeroDaySecurityLayer,
      integrationGate
    });
    const freezeSpy = vi.spyOn(harness.workerRunLifecycle, "freeze");
    const dispatchSpy = vi.spyOn(harness.workerRunLifecycle, "dispatch");
    const createSessionSpy = vi.spyOn(harness.runtimeAdapter, "createSession");

    await expect(harness.service.dispatch(createDispatchInput())).rejects.toMatchObject({
      name: "CoreError",
      code: "CONFLICT",
      message:
        "Serial delegation blocked by worker baseline hard stop: active hard_stop refs: policy-hard-stop"
    });

    expect(freezeSpy).toHaveBeenCalledWith(
      FIXED_WORKER_RUN_ID,
      "worker_baseline_hard_stop",
      "active hard_stop refs: policy-hard-stop"
    );
    expect(harness.dirtyStatePanicService.triggerPanic).toHaveBeenCalledWith({
      workerRunId: FIXED_WORKER_RUN_ID,
      trigger: "safety_gate_failure",
      panicSource: "worker_baseline_hard_stop",
      summary: "active hard_stop refs: policy-hard-stop",
      affectedScope: [{ entity_type: "constraint_ref", entity_id: "policy-hard-stop" }]
    });
    expect(integrationGate.check).not.toHaveBeenCalled();
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(createSessionSpy).not.toHaveBeenCalled();
    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "frozen",
        updated_at: FIXED_NOW
      })
    );
  });

it("continues runtime startup when the integration gate returns soft_stale", async () => {
    const integrationGate = {
      check: vi.fn(async () =>
        createIntegrationDecision(
          "soft_stale",
          "supports_interrupt expected=true actual=false"
        )
      )
    };
    const harness = createHarness([], {
      integrationGate
    });
    const createSessionSpy = vi.spyOn(harness.runtimeAdapter, "createSession");
    const promptSpy = vi.spyOn(harness.runtimeAdapter, "prompt");

    const result = await harness.service.dispatch(createDispatchInput());

    expect(result.state).toBe("active");
    expect(integrationGate.check).toHaveBeenCalledTimes(1);
    expect(createSessionSpy).toHaveBeenCalledTimes(1);
    expect(promptSpy).toHaveBeenCalledTimes(1);
  });
});
