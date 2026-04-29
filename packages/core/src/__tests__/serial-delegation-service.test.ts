import { describe, expect, it, vi } from "vitest";
import type {
  AgentRuntimePort,
  DelegatedWorkerRun,
  EventLogEntry,
  RuntimeCancelResult,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeSession,
  RuntimeSessionConfig,
  WorkerBaselineLock
} from "@do-soul/alaya-protocol";
import { CoreError } from "../errors.js";
import { EventPublisher } from "../event-publisher.js";
import { WorkerRunLifecycleService } from "../worker-run-lifecycle-service.js";
import {
  IntegrationGatePublicationError,
  type IntegrationGateDecision
} from "../integration-gate.js";
import { SerialDelegationService, type DispatchWorkerInput } from "../serial-delegation-service.js";
import { ScriptedRuntimeAdapter } from "../test-doubles/scripted-runtime-adapter.js";
import type { TestMock } from "./mock-types.js";

const FIXED_NOW = "2026-04-13T11:00:00.000Z";
const FIXED_WORKER_RUN_ID = "worker-run-serial-1";

interface HarnessOptions {
  readonly runtimeAdapter?: AgentRuntimePort;
  readonly runtimeAdapterFactory?: () => AgentRuntimePort;
  readonly workerSafetyGate?: {
    readonly enforceBeforeDispatch: TestMock;
  };
  readonly zeroDaySecurityLayer?: {
    readonly augmentLock: TestMock;
  };
  readonly integrationGate?: {
    readonly check: TestMock;
  };
  readonly constraintProxy?: {
    readonly assertNoViolation: TestMock;
  };
  readonly dirtyStatePanicService?: {
    readonly triggerPanic: TestMock;
  };
  readonly strongRefService?: {
    readonly protect: TestMock;
    readonly releaseBySource: TestMock;
  };
  readonly reportAsyncFailure?: (
    error: unknown,
    metadata: {
      readonly phase: "startup" | "event";
      readonly workerRunId: string;
      readonly sessionId: string | null;
      readonly eventType?: RuntimeEvent["type"];
    }
  ) => void | Promise<void>;
  readonly generateWorkerRunId?: () => string;
  readonly existingRuns?: readonly DelegatedWorkerRun[];
}

type RuntimeNormalizerContext = {
  readonly workspaceId: string;
  readonly principalRunId: string;
  readonly workerRunId: string;
};
type RuntimeNormalizeMock = TestMock<
  (event: RuntimeEvent, context: RuntimeNormalizerContext) => Promise<EventLogEntry | null>
>;
type ClearSessionStateMock = TestMock<(sessionId: string) => void>;

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

  it("forwards runtime events to the normalizer with workspace, principal, and worker context", async () => {
    const harness = createHarness([
      messageDeltaEvent("First chunk.", 0),
      sessionFinishedEvent("completed", "done")
    ]);
    const completeSpy = vi.spyOn(harness.workerRunLifecycle, "complete");

    await harness.service.dispatch(createDispatchInput());
    await (harness.runtimeAdapter as ScriptedRuntimeAdapter).replay();
    await flushAsync();

    expect(harness.eventNormalizer.normalize).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: "message_delta",
        delta: "First chunk."
      }),
      {
        workspaceId: "ws-serial-delegation",
        principalRunId: "principal-run-1",
        workerRunId: FIXED_WORKER_RUN_ID
      }
    );
    expect(completeSpy).toHaveBeenCalledWith(FIXED_WORKER_RUN_ID, []);
  });

  it("aborts the worker when the runtime session finishes with failed status", async () => {
    const harness = createHarness([sessionFinishedEvent("failed", "tool execution failed")]);
    const abortSpy = vi.spyOn(harness.workerRunLifecycle, "abort");

    await harness.service.dispatch(createDispatchInput());
    await (harness.runtimeAdapter as ScriptedRuntimeAdapter).replay();
    await flushAsync();

    expect(abortSpy).toHaveBeenCalledWith(FIXED_WORKER_RUN_ID, {
      reason: "tool execution failed",
      rollbackAttempted: false
    });
  });

  it("aborts the worker when the runtime session finishes with cancelled status and no summary", async () => {
    const harness = createHarness([sessionFinishedEvent("cancelled", null)]);
    const abortSpy = vi.spyOn(harness.workerRunLifecycle, "abort");

    await harness.service.dispatch(createDispatchInput());
    await (harness.runtimeAdapter as ScriptedRuntimeAdapter).replay();
    await flushAsync();

    expect(abortSpy).toHaveBeenCalledWith(FIXED_WORKER_RUN_ID, {
      reason: "cancelled",
      rollbackAttempted: false
    });
  });

  it("unsubscribes from runtime events after session_finished", async () => {
    const harness = createHarness([
      messageDeltaEvent("before finish", 0),
      sessionFinishedEvent("completed", "done"),
      messageDeltaEvent("after finish", 1)
    ]);

    await harness.service.dispatch(createDispatchInput());
    await (harness.runtimeAdapter as ScriptedRuntimeAdapter).replay();
    await flushAsync();

    expect(harness.eventNormalizer.normalize).toHaveBeenCalledTimes(2);
    expect(
      harness.eventNormalizer.normalize.mock.calls.some((call) => {
        const event = call[0];
        return event?.type === "message_delta" && event.delta === "after finish";
      })
    ).toBe(false);
  });

  it("suppresses already-queued trailing events after session_finished closes the session", async () => {
    const manual = createManualRuntimeAdapter();
    const harness = createHarness([], { runtimeAdapter: manual.adapter });

    await harness.service.dispatch(createDispatchInput());
    manual.emit({
      ...messageDeltaEvent("before finish", 0),
      session_id: "scripted-session-1"
    });
    manual.emit({
      ...sessionFinishedEvent("completed", "done"),
      session_id: "scripted-session-1"
    });
    manual.emit({
      ...messageDeltaEvent("after finish", 1),
      session_id: "scripted-session-1"
    });
    await flushAsync();
    await flushAsync();

    expect(harness.eventNormalizer.normalize).toHaveBeenCalledTimes(2);
    expect(
      harness.eventNormalizer.normalize.mock.calls.some(
        (call) => call[0]?.type === "message_delta" && call[0].delta === "after finish"
      )
    ).toBe(false);
  });

  it("cancels runtime, clears normalizer state, and freezes before reporting startup failures", async () => {
    const reportAsyncFailure = vi.fn(async () => undefined);
    const harness = createHarness([messageDeltaEvent("should not leak", 0)], {
      reportAsyncFailure
    });
    const freezeSpy = vi.spyOn(harness.workerRunLifecycle, "freeze");
    const cancelSpy = vi.spyOn(harness.runtimeAdapter, "cancel");

    vi.spyOn(harness.runtimeAdapter, "prompt").mockRejectedValueOnce(new Error("prompt exploded"));

    await expect(harness.service.dispatch(createDispatchInput())).rejects.toThrow("prompt exploded");

    expect(cancelSpy).toHaveBeenCalledWith("session-1");
    expect(harness.eventNormalizer.clearSessionState).toHaveBeenCalledWith("session-1");
    expect(freezeSpy).toHaveBeenCalledWith(
      FIXED_WORKER_RUN_ID,
      "serial_delegation_startup",
      "runtime startup failure"
    );
    expect(reportAsyncFailure).toHaveBeenCalledWith(expect.any(Error), {
      phase: "startup",
      workerRunId: FIXED_WORKER_RUN_ID,
      sessionId: "session-1"
    });
    expect(freezeSpy.mock.invocationCallOrder[0]).toBeLessThan(
      reportAsyncFailure.mock.invocationCallOrder[0]!
    );
    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "frozen",
        updated_at: FIXED_NOW
      })
    );

    await (harness.runtimeAdapter as ScriptedRuntimeAdapter).replay();
    await flushAsync();

    expect(harness.eventNormalizer.normalize).not.toHaveBeenCalled();
  });

  it("keeps a terminal worker terminal when prompt rejects after session_finished already completed", async () => {
    const reportAsyncFailure = vi.fn(async () => undefined);
    const manual = createManualRuntimeAdapter({
      prompt: async (sessionId, _input, emit) => {
        emit({
          ...sessionFinishedEvent("completed", "done"),
          session_id: sessionId
        });
        throw new Error("prompt exploded");
      }
    });
    const harness = createHarness([], {
      runtimeAdapter: manual.adapter,
      reportAsyncFailure
    });
    const freezeSpy = vi.spyOn(harness.workerRunLifecycle, "freeze");

    await expect(harness.service.dispatch(createDispatchInput())).rejects.toThrow("prompt exploded");
    await flushAsync();
    await flushAsync();

    expect(freezeSpy).not.toHaveBeenCalled();
    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "completed",
        updated_at: FIXED_NOW
      })
    );
    expect(reportAsyncFailure).toHaveBeenCalledWith(expect.any(Error), {
      phase: "startup",
      workerRunId: FIXED_WORKER_RUN_ID,
      sessionId: "scripted-session-1"
    });
  });

  it("does not report remains in-flight when startup cancel rejects after terminal commit", async () => {
    const reportAsyncFailure = vi.fn(async () => undefined);
    const manual = createManualRuntimeAdapter({
      prompt: async (sessionId, _input, emit) => {
        emit({
          ...sessionFinishedEvent("completed", "done"),
          session_id: sessionId
        });
        throw new Error("prompt exploded");
      },
      cancel: async () => {
        throw new Error("cancel exploded");
      }
    });
    const harness = createHarness([], {
      runtimeAdapter: manual.adapter,
      reportAsyncFailure
    });

    await expect(harness.service.dispatch(createDispatchInput())).rejects.toThrow("prompt exploded");
    await flushAsync();
    await flushAsync();

    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "completed",
        updated_at: FIXED_NOW
      })
    );
    expect(
      (reportAsyncFailure.mock.calls as unknown[][]).some((call) => {
        const error = call[0] as unknown;
        return error instanceof CoreError && error.message.includes("Worker remains in-flight");
      })
    ).toBe(false);
  });

  it("does not misreport startup cancel failure as in-flight when terminal reread also fails", async () => {
    const reportAsyncFailure = vi.fn(async () => undefined);
    const manual = createManualRuntimeAdapter({
      prompt: async (sessionId, _input, emit) => {
        emit({
          ...sessionFinishedEvent("completed", "done"),
          session_id: sessionId
        });
        throw new Error("prompt exploded");
      },
      cancel: async () => {
        throw new Error("cancel exploded");
      }
    });
    const harness = createHarness([], {
      runtimeAdapter: manual.adapter,
      reportAsyncFailure
    });
    let lookupCount = 0;

    harness.repo.getById.mockImplementation(async (workerRunId: string) => {
      lookupCount += 1;

      if (lookupCount === 4) {
        throw new Error("lookup exploded");
      }

      return harness.getById(workerRunId);
    });

    await expect(harness.service.dispatch(createDispatchInput())).rejects.toThrow(
      "could not verify worker"
    );
    await flushAsync();
    await flushAsync();

    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "completed",
        updated_at: FIXED_NOW
      })
    );
    expect(
      (reportAsyncFailure.mock.calls as unknown[][]).some((call) => {
        const error = call[0] as unknown;
        return error instanceof CoreError && error.message.includes("Worker remains in-flight");
      })
    ).toBe(false);
    expect(
      (reportAsyncFailure.mock.calls as unknown[][]).some((call) => {
        const error = call[0] as unknown;
        return error instanceof CoreError && error.message.includes("Worker may remain in-flight");
      })
    ).toBe(true);
  });

  it("still freezes startup failures when the async failure reporter throws", async () => {
    const harness = createHarness([messageDeltaEvent("should not leak", 0)], {
      reportAsyncFailure: vi.fn(async () => {
        throw new Error("reporter exploded");
      })
    });

    vi.spyOn(harness.runtimeAdapter, "prompt").mockRejectedValueOnce(new Error("prompt exploded"));

    await expect(harness.service.dispatch(createDispatchInput())).rejects.toThrow("prompt exploded");

    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "frozen",
        updated_at: FIXED_NOW
      })
    );
  });

  it("fences already-enqueued runtime events when prompt fails after the adapter emitted them", async () => {
    let releaseDelta!: () => void;
    const deltaGate = new Promise<void>((resolve) => {
      releaseDelta = resolve;
    });
    const manual = createManualRuntimeAdapter({
      prompt: async (sessionId, _input, emit) => {
        emit({
          ...messageDeltaEvent("queued before prompt failure", 0),
          session_id: sessionId
        });
        emit({
          ...sessionFinishedEvent("completed", "late completion should be ignored"),
          session_id: sessionId
        });
        throw new Error("prompt exploded");
      }
    });
    const harness = createHarness([], { runtimeAdapter: manual.adapter });
    const completeSpy = vi.spyOn(harness.workerRunLifecycle, "complete");

    harness.eventNormalizer.normalize.mockImplementation(async (event: RuntimeEvent) => {
      if (event.type === "message_delta") {
        await deltaGate;
      }

      return null;
    });

    const dispatchPromise = harness.service.dispatch(createDispatchInput());
    await flushAsync();
    releaseDelta();

    await expect(dispatchPromise).rejects.toThrow("prompt exploded");
    await flushAsync();

    expect(completeSpy).not.toHaveBeenCalled();
    expect(
      harness.eventNormalizer.normalize.mock.calls.some(
        (call) => call[0]?.type === "session_finished"
      )
    ).toBe(false);
    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "frozen",
        updated_at: FIXED_NOW
      })
    );
  });

  it("does not resolve dispatch before the queued runtime events finish normalizing", async () => {
    let releaseDelta!: () => void;
    const deltaGate = new Promise<void>((resolve) => {
      releaseDelta = resolve;
    });
    const manual = createManualRuntimeAdapter({
      prompt: async (sessionId, _input, emit) => {
        emit({
          ...messageDeltaEvent("queued before dispatch resolves", 0),
          session_id: sessionId
        });
        emit({
          ...sessionFinishedEvent("completed", "done"),
          session_id: sessionId
        });
      }
    });
    const harness = createHarness([], { runtimeAdapter: manual.adapter });
    let settled = false;

    harness.eventNormalizer.normalize.mockImplementation(async (event: RuntimeEvent) => {
      if (event.type === "message_delta") {
        await deltaGate;
      }

      return null;
    });

    const dispatchPromise = harness.service.dispatch(createDispatchInput());
    void dispatchPromise.finally(() => {
      settled = true;
    });

    await flushAsync();
    expect(settled).toBe(false);

    releaseDelta();

    await expect(dispatchPromise).resolves.toMatchObject({
      worker_run_id: FIXED_WORKER_RUN_ID,
      state: "active"
    });
    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "completed",
        updated_at: FIXED_NOW
      })
    );
  });

  it("keeps the worker in-flight and reports startup cleanup failures with startup metadata when cancel rejects", async () => {
    const reportAsyncFailure = vi.fn(async () => undefined);
    const manual = createManualRuntimeAdapter({
      prompt: async () => {
        throw new Error("prompt exploded");
      },
      cancel: async () => {
        throw new Error("cancel exploded");
      }
    });
    const harness = createHarness([], {
      runtimeAdapter: manual.adapter,
      reportAsyncFailure
    });
    const freezeSpy = vi.spyOn(harness.workerRunLifecycle, "freeze");

    await expect(harness.service.dispatch(createDispatchInput())).rejects.toMatchObject({
      name: "CoreError",
      code: "VALIDATION",
      message:
        "Serial delegation startup recovery could not cancel the runtime session. Worker remains in-flight."
    });

    expect(freezeSpy).not.toHaveBeenCalled();
    expect(harness.eventNormalizer.clearSessionState).not.toHaveBeenCalled();
    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "active",
        updated_at: FIXED_NOW
      })
    );
    expect(reportAsyncFailure).toHaveBeenNthCalledWith(1, expect.any(Error), {
      phase: "startup",
      workerRunId: FIXED_WORKER_RUN_ID,
      sessionId: "scripted-session-1"
    });
    expect(reportAsyncFailure).toHaveBeenNthCalledWith(2, expect.any(Error), {
      phase: "startup",
      workerRunId: FIXED_WORKER_RUN_ID,
      sessionId: "scripted-session-1"
    });
  });

  it("falls back to abort when startup freeze fails after cancel succeeds", async () => {
    const reportAsyncFailure = vi.fn(async () => undefined);
    const harness = createHarness([messageDeltaEvent("should not leak", 0)], {
      reportAsyncFailure
    });
    const abortSpy = vi.spyOn(harness.workerRunLifecycle, "abort");

    vi.spyOn(harness.runtimeAdapter, "prompt").mockRejectedValueOnce(new Error("prompt exploded"));
    vi.spyOn(harness.workerRunLifecycle, "freeze").mockRejectedValueOnce(new Error("freeze exploded"));

    await expect(harness.service.dispatch(createDispatchInput())).rejects.toThrow("prompt exploded");

    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "aborted",
        updated_at: FIXED_NOW
      })
    );
    expect(abortSpy).toHaveBeenCalledWith(FIXED_WORKER_RUN_ID, {
      reason: "serial_delegation_startup recovery fallback after freeze failure: freeze transition failed",
      rollbackAttempted: false
    });
    expect(reportAsyncFailure).toHaveBeenCalledWith(expect.any(Error), {
      phase: "startup",
      workerRunId: FIXED_WORKER_RUN_ID,
      sessionId: "session-1"
    });
  });

  it("does not raise a false in-flight alarm when startup freeze already committed", async () => {
    const reportAsyncFailure = vi.fn(async () => undefined);
    const harness = createHarness([messageDeltaEvent("should not leak", 0)], {
      reportAsyncFailure
    });

    vi.spyOn(harness.runtimeAdapter, "prompt").mockRejectedValueOnce(new Error("prompt exploded"));
    vi.spyOn(harness.workerRunLifecycle, "freeze").mockImplementationOnce(async (workerRunId) => {
      await harness.repo.updateState(workerRunId, "active", "frozen", FIXED_NOW);
      throw new Error("freeze propagated exploded");
    });

    await expect(harness.service.dispatch(createDispatchInput())).rejects.toThrow("prompt exploded");

    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "frozen",
        updated_at: FIXED_NOW
      })
    );
    expect(
      (reportAsyncFailure.mock.calls as unknown[][]).some((call) => {
        const error = call[0] as unknown;
        return error instanceof CoreError && error.message.includes("Worker remains in-flight");
      })
    ).toBe(false);
  });

  it("ignores events from a different runtime session", async () => {
    const manual = createManualRuntimeAdapter();
    const harness = createHarness([], { runtimeAdapter: manual.adapter });

    await harness.service.dispatch(createDispatchInput());
    manual.emit({
      ...messageDeltaEvent("foreign chunk", 0),
      session_id: "different-session"
    });
    manual.emit({
      ...messageDeltaEvent("owned chunk", 1),
      session_id: "scripted-session-1"
    });
    manual.emit({
      ...sessionFinishedEvent("completed", "done"),
      session_id: "scripted-session-1"
    });
    await flushAsync();

    expect(harness.eventNormalizer.normalize).toHaveBeenCalledTimes(2);
    expect(
      harness.eventNormalizer.normalize.mock.calls.some(
        (call) => call[0]?.type === "message_delta" && call[0].delta === "foreign chunk"
      )
    ).toBe(false);
  });

  it("processes runtime events in adapter order even when earlier normalization is slow", async () => {
    const manual = createManualRuntimeAdapter();
    const harness = createHarness([], { runtimeAdapter: manual.adapter });
    const completeSpy = vi.spyOn(harness.workerRunLifecycle, "complete");
    let releaseDelta!: () => void;
    let markDeltaStarted!: () => void;
    const deltaStarted = new Promise<void>((resolve) => {
      markDeltaStarted = resolve;
    });
    const deltaGate = new Promise<void>((resolve) => {
      releaseDelta = resolve;
    });

    harness.eventNormalizer.normalize.mockImplementation(async (event: RuntimeEvent) => {
      if (event.type === "message_delta") {
        markDeltaStarted();
        await deltaGate;
      }

      return null;
    });

    await harness.service.dispatch(createDispatchInput());

    manual.emit({
      ...messageDeltaEvent("slow chunk", 0),
      session_id: "scripted-session-1"
    });
    manual.emit({
      ...sessionFinishedEvent("completed", "done"),
      session_id: "scripted-session-1"
    });

    await deltaStarted;
    await flushAsync();

    expect(harness.eventNormalizer.normalize).toHaveBeenCalledTimes(1);
    expect(completeSpy).not.toHaveBeenCalled();

    releaseDelta();
    await flushAsync();

    expect(harness.eventNormalizer.normalize).toHaveBeenCalledTimes(2);
    expect(harness.eventNormalizer.normalize).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ type: "session_finished" }),
      expect.any(Object)
    );
    expect(completeSpy).toHaveBeenCalledWith(FIXED_WORKER_RUN_ID, []);
  });

  it("cancels runtime, clears normalizer state, and freezes when runtime event handling fails", async () => {
    const reportAsyncFailure = vi.fn(async () => {
      throw new Error("reporter exploded");
    });
    const manual = createManualRuntimeAdapter({
      cancel: async (sessionId) => ({
        session_id: sessionId,
        status: "already_finished"
      })
    });
    const harness = createHarness([], {
      runtimeAdapter: manual.adapter,
      reportAsyncFailure
    });
    const freezeSpy = vi.spyOn(harness.workerRunLifecycle, "freeze");
    const cancelSpy = vi.spyOn(manual.adapter, "cancel");

    harness.eventNormalizer.normalize.mockRejectedValueOnce(new Error("normalizer exploded"));

    await harness.service.dispatch(createDispatchInput());
    manual.emit({
      ...messageDeltaEvent("bad chunk", 0),
      session_id: "scripted-session-1"
    });
    await flushTimerTick();
    await flushAsync();
    await flushTimerTick();
    await flushAsync();
    await flushRecoveryGracePeriod();
    await flushRecoveryGracePeriod();

    expect(cancelSpy).toHaveBeenCalledWith("scripted-session-1");
    expect(harness.eventNormalizer.clearSessionState).toHaveBeenCalledWith("scripted-session-1");
    expect(freezeSpy).toHaveBeenCalledWith(
      FIXED_WORKER_RUN_ID,
      "runtime_event_handler",
      "message_delta: event handling failure"
    );
    await flushAsync();
    expect(reportAsyncFailure).toHaveBeenCalledWith(expect.any(Error), {
      phase: "event",
      workerRunId: FIXED_WORKER_RUN_ID,
      sessionId: "scripted-session-1",
      eventType: "message_delta"
    });
    expect(freezeSpy.mock.invocationCallOrder[0]).toBeLessThan(
      reportAsyncFailure.mock.invocationCallOrder[0]!
    );
    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "frozen",
        updated_at: FIXED_NOW
      })
    );
  });

  it("keeps later session events observable when runtime event recovery cannot cancel the session", async () => {
    const reportAsyncFailure = vi.fn(async () => undefined);
    let releaseCancel!: () => void;
    let markCancelStarted!: () => void;
    const cancelStarted = new Promise<void>((resolve) => {
      markCancelStarted = resolve;
    });
    const cancelGate = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    const manual = createManualRuntimeAdapter({
      cancel: async () => {
        markCancelStarted();
        await cancelGate;
        throw new Error("cancel exploded");
      }
    });
    const harness = createHarness([], {
      runtimeAdapter: manual.adapter,
      reportAsyncFailure
    });
    const freezeSpy = vi.spyOn(harness.workerRunLifecycle, "freeze");
    const completeSpy = vi.spyOn(harness.workerRunLifecycle, "complete");

    harness.eventNormalizer.normalize.mockRejectedValueOnce(new Error("normalizer exploded"));

    await harness.service.dispatch(createDispatchInput());
    manual.emit({
      ...messageDeltaEvent("bad chunk", 0),
      session_id: "scripted-session-1"
    });
    await cancelStarted;

    manual.emit({
      ...sessionFinishedEvent("completed", "done"),
      session_id: "scripted-session-1"
    });
    releaseCancel();
    await flushAsync();
    await flushAsync();

    expect(freezeSpy).not.toHaveBeenCalled();
    expect(harness.eventNormalizer.clearSessionState).not.toHaveBeenCalled();
    expect(completeSpy).toHaveBeenCalledWith(FIXED_WORKER_RUN_ID, []);
    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "completed",
        updated_at: FIXED_NOW
      })
    );
    expect(reportAsyncFailure).toHaveBeenCalledWith(expect.any(Error), {
      phase: "event",
      workerRunId: FIXED_WORKER_RUN_ID,
      sessionId: "scripted-session-1",
      eventType: "message_delta"
    });
  });

  it("falls back to abort when runtime event recovery cancels successfully but freeze fails", async () => {
    const reportAsyncFailure = vi.fn(async () => undefined);
    const manual = createManualRuntimeAdapter();
    const harness = createHarness([], {
      runtimeAdapter: manual.adapter,
      reportAsyncFailure
    });
    const freezeSpy = vi
      .spyOn(harness.workerRunLifecycle, "freeze")
      .mockRejectedValueOnce(new Error("freeze exploded"));
    const abortSpy = vi.spyOn(harness.workerRunLifecycle, "abort");

    harness.eventNormalizer.normalize.mockRejectedValueOnce(new Error("normalizer exploded"));

    await harness.service.dispatch(createDispatchInput());
    manual.emit({
      ...messageDeltaEvent("bad chunk", 0),
      session_id: "scripted-session-1"
    });
    await flushTimerTick();
    await flushAsync();
    await flushTimerTick();
    await flushAsync();
    await flushRecoveryGracePeriod();

    expect(harness.eventNormalizer.clearSessionState).toHaveBeenCalledWith("scripted-session-1");
    expect(freezeSpy).toHaveBeenCalledWith(
      FIXED_WORKER_RUN_ID,
      "runtime_event_handler",
      "message_delta: event handling failure"
    );
    expect(abortSpy).toHaveBeenCalledWith(FIXED_WORKER_RUN_ID, {
      reason: "runtime_event_handler recovery fallback after freeze failure: freeze transition failed",
      rollbackAttempted: false
    });
    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "aborted",
        updated_at: FIXED_NOW
      })
    );
    expect(reportAsyncFailure).toHaveBeenCalledWith(expect.any(Error), {
      phase: "event",
      workerRunId: FIXED_WORKER_RUN_ID,
      sessionId: "scripted-session-1",
      eventType: "message_delta"
    });
  });

  it("honors a queued session_finished when cancel resolves after terminal delivery", async () => {
    const reportAsyncFailure = vi.fn(async () => undefined);
    let releaseCancel!: () => void;
    let markCancelStarted!: () => void;
    const cancelStarted = new Promise<void>((resolve) => {
      markCancelStarted = resolve;
    });
    const cancelGate = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    const manual = createManualRuntimeAdapter({
      cancel: async (sessionId) => {
        markCancelStarted();
        await cancelGate;
        return {
          session_id: sessionId,
          status: "cancelled"
        };
      }
    });
    const harness = createHarness([], {
      runtimeAdapter: manual.adapter,
      reportAsyncFailure
    });
    const completeSpy = vi.spyOn(harness.workerRunLifecycle, "complete");
    const freezeSpy = vi.spyOn(harness.workerRunLifecycle, "freeze");
    const abortSpy = vi.spyOn(harness.workerRunLifecycle, "abort");

    harness.eventNormalizer.normalize.mockRejectedValueOnce(new Error("normalizer exploded"));

    await harness.service.dispatch(createDispatchInput());
    manual.emit({
      ...messageDeltaEvent("bad chunk", 0),
      session_id: "scripted-session-1"
    });
    await cancelStarted;

    manual.emit({
      ...sessionFinishedEvent("completed", "done"),
      session_id: "scripted-session-1"
    });
    releaseCancel();
    await flushAsync();
    await flushAsync();

    expect(completeSpy).toHaveBeenCalledWith(FIXED_WORKER_RUN_ID, []);
    expect(freezeSpy).not.toHaveBeenCalled();
    expect(abortSpy).not.toHaveBeenCalled();
    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "completed",
        updated_at: FIXED_NOW
      })
    );
    expect(reportAsyncFailure).toHaveBeenCalledWith(expect.any(Error), {
      phase: "event",
      workerRunId: FIXED_WORKER_RUN_ID,
      sessionId: "scripted-session-1",
      eventType: "message_delta"
    });
  });

  it("honors a session_finished emitted on the next turn after cancel resolves", async () => {
    const reportAsyncFailure = vi.fn(async () => undefined);
    const manual = createManualRuntimeAdapter({
      cancel: async (sessionId, emit) => {
        setTimeout(() => {
          emit({
            ...sessionFinishedEvent("completed", "done"),
            session_id: sessionId
          });
        }, 0);

        return {
          session_id: sessionId,
          status: "cancelled"
        };
      }
    });
    const harness = createHarness([], {
      runtimeAdapter: manual.adapter,
      reportAsyncFailure
    });
    const completeSpy = vi.spyOn(harness.workerRunLifecycle, "complete");
    const freezeSpy = vi.spyOn(harness.workerRunLifecycle, "freeze");
    const abortSpy = vi.spyOn(harness.workerRunLifecycle, "abort");

    harness.eventNormalizer.normalize.mockRejectedValueOnce(new Error("normalizer exploded"));

    await harness.service.dispatch(createDispatchInput());
    manual.emit({
      ...messageDeltaEvent("bad chunk", 0),
      session_id: "scripted-session-1"
    });
    await flushTimerTick();
    await flushAsync();
    await flushTimerTick();
    await flushAsync();
    await flushRecoveryGracePeriod();

    expect(completeSpy).toHaveBeenCalledWith(FIXED_WORKER_RUN_ID, []);
    expect(freezeSpy).not.toHaveBeenCalled();
    expect(abortSpy).not.toHaveBeenCalled();
    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "completed",
        updated_at: FIXED_NOW
      })
    );
    expect(reportAsyncFailure).toHaveBeenCalledWith(expect.any(Error), {
      phase: "event",
      workerRunId: FIXED_WORKER_RUN_ID,
      sessionId: "scripted-session-1",
      eventType: "message_delta"
    });
  });

  it("honors a session_finished emitted after a later timer turn once cancel resolves", async () => {
    const reportAsyncFailure = vi.fn(async () => undefined);
    const manual = createManualRuntimeAdapter({
      cancel: async (sessionId, emit) => {
        setTimeout(() => {
          setTimeout(() => {
            emit({
              ...sessionFinishedEvent("completed", "done"),
              session_id: sessionId
            });
          }, 0);
        }, 0);

        return {
          session_id: sessionId,
          status: "cancelled"
        };
      }
    });
    const harness = createHarness([], {
      runtimeAdapter: manual.adapter,
      reportAsyncFailure
    });
    const completeSpy = vi.spyOn(harness.workerRunLifecycle, "complete");
    const freezeSpy = vi.spyOn(harness.workerRunLifecycle, "freeze");
    const abortSpy = vi.spyOn(harness.workerRunLifecycle, "abort");

    harness.eventNormalizer.normalize.mockRejectedValueOnce(new Error("normalizer exploded"));

    await harness.service.dispatch(createDispatchInput());
    manual.emit({
      ...messageDeltaEvent("bad chunk", 0),
      session_id: "scripted-session-1"
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    await flushAsync();
    await flushAsync();

    expect(completeSpy).toHaveBeenCalledWith(FIXED_WORKER_RUN_ID, []);
    expect(freezeSpy).not.toHaveBeenCalled();
    expect(abortSpy).not.toHaveBeenCalled();
    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "completed",
        updated_at: FIXED_NOW
      })
    );
    expect(reportAsyncFailure).toHaveBeenCalledWith(expect.any(Error), {
      phase: "event",
      workerRunId: FIXED_WORKER_RUN_ID,
      sessionId: "scripted-session-1",
      eventType: "message_delta"
    });
  });

  it.each([
    {
      status: "failed" as const,
      resultSummary: "tool execution failed",
      expectedReason: "tool execution failed"
    },
    {
      status: "cancelled" as const,
      resultSummary: null,
      expectedReason: "cancelled"
    }
  ])(
    "honors a queued $status session_finished when cancel resolves after terminal delivery",
    async ({ status, resultSummary, expectedReason }) => {
      const reportAsyncFailure = vi.fn(async () => undefined);
      let releaseCancel!: () => void;
      let markCancelStarted!: () => void;
      const cancelStarted = new Promise<void>((resolve) => {
        markCancelStarted = resolve;
      });
      const cancelGate = new Promise<void>((resolve) => {
        releaseCancel = resolve;
      });
      const manual = createManualRuntimeAdapter({
        cancel: async (sessionId) => {
          markCancelStarted();
          await cancelGate;
          return {
            session_id: sessionId,
            status: "cancelled"
          };
        }
      });
      const harness = createHarness([], {
        runtimeAdapter: manual.adapter,
        reportAsyncFailure
      });
      const abortSpy = vi.spyOn(harness.workerRunLifecycle, "abort");
      const freezeSpy = vi.spyOn(harness.workerRunLifecycle, "freeze");

      harness.eventNormalizer.normalize.mockRejectedValueOnce(new Error("normalizer exploded"));

      await harness.service.dispatch(createDispatchInput());
      manual.emit({
        ...messageDeltaEvent("bad chunk", 0),
        session_id: "scripted-session-1"
      });
      await cancelStarted;

      manual.emit({
        ...sessionFinishedEvent(status, resultSummary),
        session_id: "scripted-session-1"
      });
      releaseCancel();
      await flushAsync();
      await flushAsync();

      expect(freezeSpy).not.toHaveBeenCalled();
      expect(abortSpy).toHaveBeenCalledWith(FIXED_WORKER_RUN_ID, {
        reason: expectedReason,
        rollbackAttempted: false
      });
      expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
        createWorkerRun({
          worker_run_id: FIXED_WORKER_RUN_ID,
          state: "aborted",
          updated_at: FIXED_NOW
        })
      );
      expect(reportAsyncFailure).toHaveBeenCalledWith(expect.any(Error), {
        phase: "event",
        workerRunId: FIXED_WORKER_RUN_ID,
        sessionId: "scripted-session-1",
        eventType: "message_delta"
      });
    }
  );

  it("falls back to fenced recovery when replaying a queued session_finished also fails", async () => {
    const reportAsyncFailure = vi.fn(async () => undefined);
    let releaseCancel!: () => void;
    let markCancelStarted!: () => void;
    const cancelStarted = new Promise<void>((resolve) => {
      markCancelStarted = resolve;
    });
    const cancelGate = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    const manual = createManualRuntimeAdapter({
      cancel: async (sessionId) => {
        markCancelStarted();
        await cancelGate;
        return {
          session_id: sessionId,
          status: "cancelled"
        };
      }
    });
    const harness = createHarness([], {
      runtimeAdapter: manual.adapter,
      reportAsyncFailure
    });
    const freezeSpy = vi.spyOn(harness.workerRunLifecycle, "freeze");

    harness.eventNormalizer.normalize
      .mockRejectedValueOnce(new Error("normalizer exploded"))
      .mockRejectedValueOnce(new Error("session_finished replay exploded"));

    await harness.service.dispatch(createDispatchInput());
    manual.emit({
      ...messageDeltaEvent("bad chunk", 0),
      session_id: "scripted-session-1"
    });
    await cancelStarted;

    manual.emit({
      ...sessionFinishedEvent("completed", "done"),
      session_id: "scripted-session-1"
    });
    releaseCancel();
    await flushAsync();
    await flushAsync();

    expect(harness.eventNormalizer.clearSessionState).toHaveBeenCalledWith("scripted-session-1");
    expect(freezeSpy).toHaveBeenCalledWith(
      FIXED_WORKER_RUN_ID,
      "runtime_event_handler",
      "session_finished after message_delta: terminal recovery failure"
    );
    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "frozen",
        updated_at: FIXED_NOW
      })
    );
    expect(reportAsyncFailure).toHaveBeenCalledWith(expect.any(Error), {
      phase: "event",
      workerRunId: FIXED_WORKER_RUN_ID,
      sessionId: "scripted-session-1",
      eventType: "message_delta"
    });
    expect(reportAsyncFailure).toHaveBeenCalledWith(expect.any(Error), {
      phase: "event",
      workerRunId: FIXED_WORKER_RUN_ID,
      sessionId: "scripted-session-1",
      eventType: "session_finished"
    });
  });

  it("does not abort after freeze errors if the worker is already frozen", async () => {
    const reportAsyncFailure = vi.fn(async () => undefined);
    const manual = createManualRuntimeAdapter();
    const harness = createHarness([], {
      runtimeAdapter: manual.adapter,
      reportAsyncFailure
    });
    const abortSpy = vi.spyOn(harness.workerRunLifecycle, "abort");

    vi.spyOn(harness.workerRunLifecycle, "freeze").mockImplementationOnce(async (workerRunId) => {
      await harness.repo.updateState(workerRunId, "active", "frozen", FIXED_NOW);
      throw new Error("freeze propagated exploded");
    });

    harness.eventNormalizer.normalize.mockRejectedValueOnce(new Error("normalizer exploded"));

    await harness.service.dispatch(createDispatchInput());
    manual.emit({
      ...messageDeltaEvent("bad chunk", 0),
      session_id: "scripted-session-1"
    });
    await flushTimerTick();
    await flushAsync();
    await flushTimerTick();
    await flushAsync();
    await flushRecoveryGracePeriod();

    expect(abortSpy).not.toHaveBeenCalled();
    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "frozen",
        updated_at: FIXED_NOW
      })
    );
    expect(
      (reportAsyncFailure.mock.calls as unknown[][]).some((call) => {
        const error = call[0] as unknown;
        return error instanceof CoreError && error.message.includes("Worker remains in-flight");
      })
    ).toBe(false);
  });

  it("honors the current session_finished when normalization fails and cancel also rejects", async () => {
    const reportAsyncFailure = vi.fn(async () => undefined);
    const manual = createManualRuntimeAdapter({
      cancel: async () => {
        throw new Error("cancel exploded");
      }
    });
    const harness = createHarness([], {
      runtimeAdapter: manual.adapter,
      reportAsyncFailure
    });
    const completeSpy = vi.spyOn(harness.workerRunLifecycle, "complete");
    const terminalEvent = {
      ...sessionFinishedEvent("completed", "done"),
      session_id: "scripted-session-1"
    } satisfies RuntimeEvent;

    harness.eventNormalizer.normalize
      .mockRejectedValueOnce(new Error("normalizer exploded"))
      .mockResolvedValueOnce(null);

    await harness.service.dispatch(createDispatchInput());
    manual.emit(terminalEvent);
    await flushAsync();
    await flushAsync();

    expect(harness.eventNormalizer.normalize).toHaveBeenCalledTimes(2);
    expect(harness.eventNormalizer.normalize).toHaveBeenNthCalledWith(
      1,
      terminalEvent,
      expect.any(Object)
    );
    expect(harness.eventNormalizer.normalize).toHaveBeenNthCalledWith(
      2,
      terminalEvent,
      expect.any(Object)
    );
    expect(completeSpy).toHaveBeenCalledWith(FIXED_WORKER_RUN_ID, []);
    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "completed",
        updated_at: FIXED_NOW
      })
    );
  });

  it("does not replay a stale session_finished after an earlier cancel rejection", async () => {
    const reportAsyncFailure = vi.fn(async () => undefined);
    let cancelAttempts = 0;
    const manual = createManualRuntimeAdapter({
      cancel: async (sessionId) => {
        cancelAttempts += 1;

        if (cancelAttempts === 1) {
          throw new Error("cancel exploded");
        }

        return {
          session_id: sessionId,
          status: "cancelled"
        };
      }
    });
    const harness = createHarness([], {
      runtimeAdapter: manual.adapter,
      reportAsyncFailure
    });
    const freezeSpy = vi.spyOn(harness.workerRunLifecycle, "freeze");
    const firstTerminal = {
      ...sessionFinishedEvent("completed", "first terminal"),
      session_id: "scripted-session-1",
      emitted_at: "2026-04-13T11:00:02.000Z"
    } satisfies RuntimeEvent;
    const secondTerminal = {
      ...sessionFinishedEvent("completed", "second terminal"),
      session_id: "scripted-session-1",
      emitted_at: "2026-04-13T11:00:03.000Z"
    } satisfies RuntimeEvent;

    harness.eventNormalizer.normalize
      .mockRejectedValueOnce(new Error("first terminal exploded"))
      .mockResolvedValueOnce(null);

    await harness.service.dispatch(createDispatchInput());
    manual.emit(firstTerminal);
    await flushAsync();

    manual.emit(secondTerminal);
    await flushAsync();
    await flushAsync();

    expect(harness.eventNormalizer.normalize).toHaveBeenCalledTimes(2);
    expect(harness.eventNormalizer.normalize).toHaveBeenNthCalledWith(
      1,
      firstTerminal,
      expect.any(Object)
    );
    expect(harness.eventNormalizer.normalize).toHaveBeenNthCalledWith(
      2,
      firstTerminal,
      expect.any(Object)
    );
    expect(freezeSpy).not.toHaveBeenCalled();
    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "completed",
        updated_at: FIXED_NOW
      })
    );
  });

  it("still completes when a retried session_finished was already normalized", async () => {
    const manual = createManualRuntimeAdapter();
    const harness = createHarness([], {
      runtimeAdapter: manual.adapter
    });
    const completeSpy = vi.spyOn(harness.workerRunLifecycle, "complete");

    harness.eventNormalizer.normalize.mockResolvedValueOnce(null);

    await harness.service.dispatch(createDispatchInput());
    manual.emit({
      ...sessionFinishedEvent("completed", "done"),
      session_id: "scripted-session-1"
    });
    await flushAsync();
    await flushAsync();

    expect(completeSpy).toHaveBeenCalledWith(FIXED_WORKER_RUN_ID, []);
    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "completed",
        updated_at: FIXED_NOW
      })
    );
  });

  it("replays the current session_finished after append succeeds but broadcast fails", async () => {
    const reportAsyncFailure = vi.fn(async () => undefined);
    const manual = createManualRuntimeAdapter();
    const harness = createHarness([], {
      runtimeAdapter: manual.adapter,
      reportAsyncFailure
    });
    const completeSpy = vi.spyOn(harness.workerRunLifecycle, "complete");
    const freezeSpy = vi.spyOn(harness.workerRunLifecycle, "freeze");

    harness.eventNormalizer.normalize
      .mockRejectedValueOnce(new Error("broadcast exploded"))
      .mockResolvedValueOnce(null);

    await harness.service.dispatch(createDispatchInput());
    manual.emit({
      ...sessionFinishedEvent("completed", "done"),
      session_id: "scripted-session-1"
    });
    await flushAsync();
    await flushAsync();

    expect(completeSpy).toHaveBeenCalledWith(FIXED_WORKER_RUN_ID, []);
    expect(harness.eventNormalizer.clearSessionState).toHaveBeenCalledWith("scripted-session-1");
    expect(freezeSpy).not.toHaveBeenCalled();
    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "completed",
        updated_at: FIXED_NOW
      })
    );
    expect(reportAsyncFailure).toHaveBeenCalledWith(expect.any(Error), {
      phase: "event",
      workerRunId: FIXED_WORKER_RUN_ID,
      sessionId: "scripted-session-1",
      eventType: "session_finished"
    });
  });

  it("fails closed when startup recovery cannot prove terminal worker state", async () => {
    const reportAsyncFailure = vi.fn(async () => undefined);
    const manual = createManualRuntimeAdapter({
      prompt: async (sessionId, _input, emit) => {
        emit({
          ...sessionFinishedEvent("completed", "done"),
          session_id: sessionId
        });
        throw new Error("prompt exploded");
      }
    });
    const harness = createHarness([], {
      runtimeAdapter: manual.adapter,
      reportAsyncFailure
    });
    const freezeSpy = vi.spyOn(harness.workerRunLifecycle, "freeze");
    let lookupCount = 0;

    harness.repo.getById.mockImplementation(async (workerRunId: string) => {
      lookupCount += 1;

      if (lookupCount === 4) {
        throw new Error("lookup exploded");
      }

      return harness.getById(workerRunId);
    });

    await expect(harness.service.dispatch(createDispatchInput())).rejects.toThrow("prompt exploded");
    await flushAsync();
    await flushAsync();

    expect(freezeSpy).toHaveBeenCalledWith(
      FIXED_WORKER_RUN_ID,
      "serial_delegation_startup",
      "runtime startup failure"
    );
    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "frozen",
        updated_at: FIXED_NOW
      })
    );
    expect(reportAsyncFailure).toHaveBeenCalled();
  });

  it("continues startup recovery when terminal-state guard cannot re-read a non-terminal worker", async () => {
    const reportAsyncFailure = vi.fn(async () => undefined);
    const harness = createHarness([], {
      reportAsyncFailure
    });
    const freezeSpy = vi.spyOn(harness.workerRunLifecycle, "freeze");
    let lookupCount = 0;

    vi.spyOn(harness.runtimeAdapter, "prompt").mockRejectedValueOnce(new Error("prompt exploded"));
    harness.repo.getById.mockImplementation(async (workerRunId: string) => {
      lookupCount += 1;

      if (lookupCount === 2) {
        throw new Error("lookup exploded");
      }

      return harness.getById(workerRunId);
    });

    await expect(harness.service.dispatch(createDispatchInput())).rejects.toThrow("prompt exploded");

    expect(freezeSpy).toHaveBeenCalledWith(
      FIXED_WORKER_RUN_ID,
      "serial_delegation_startup",
      "runtime startup failure"
    );
    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "frozen",
        updated_at: FIXED_NOW
      })
    );
    expect(
      (reportAsyncFailure.mock.calls as unknown[][]).some((call) => {
        const error = call[0] as unknown;
        return error instanceof CoreError && error.message.includes("Worker may remain in-flight");
      })
    ).toBe(true);
  });

  it("does not freeze when event-recovery terminal-state guard cannot re-read a terminal worker", async () => {
    const reportAsyncFailure = vi.fn(async () => undefined);
    const manual = createManualRuntimeAdapter();
    const harness = createHarness([], {
      runtimeAdapter: manual.adapter,
      reportAsyncFailure
    });
    const freezeSpy = vi.spyOn(harness.workerRunLifecycle, "freeze");
    let lookupCount = 0;

    harness.repo.getById.mockImplementation(async (workerRunId: string) => {
      lookupCount += 1;

      if (lookupCount === 5) {
        throw new Error("lookup exploded");
      }

      return harness.getById(workerRunId);
    });

    harness.eventNormalizer.normalize
      .mockRejectedValueOnce(new Error("broadcast exploded"))
      .mockResolvedValueOnce(null);
    vi.spyOn(harness.workerRunLifecycle, "complete").mockImplementationOnce(async (workerRunId) => {
      await harness.repo.updateState(workerRunId, "active", "completed", FIXED_NOW);
      throw new Error("state changed broadcast exploded");
    });

    await harness.service.dispatch(createDispatchInput());
    manual.emit({
      ...sessionFinishedEvent("completed", "done"),
      session_id: "scripted-session-1"
    });
    await flushAsync();
    await flushAsync();

    expect(freezeSpy).not.toHaveBeenCalled();
    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "completed",
        updated_at: FIXED_NOW
      })
    );
    expect(reportAsyncFailure).toHaveBeenCalled();
  });

  it("continues event recovery when terminal-state guard cannot re-read a non-terminal worker", async () => {
    const reportAsyncFailure = vi.fn(async () => undefined);
    const manual = createManualRuntimeAdapter();
    const harness = createHarness([], {
      runtimeAdapter: manual.adapter,
      reportAsyncFailure
    });
    const freezeSpy = vi.spyOn(harness.workerRunLifecycle, "freeze");
    let lookupCount = 0;

    harness.repo.getById.mockImplementation(async (workerRunId: string) => {
      lookupCount += 1;

      if (lookupCount === 2) {
        throw new Error("lookup exploded");
      }

      return harness.getById(workerRunId);
    });

    harness.eventNormalizer.normalize.mockRejectedValueOnce(new Error("normalizer exploded"));

    await harness.service.dispatch(createDispatchInput());
    manual.emit({
      ...messageDeltaEvent("bad chunk", 0),
      session_id: "scripted-session-1"
    });
    await flushTimerTick();
    await flushAsync();
    await flushTimerTick();
    await flushAsync();
    await flushRecoveryGracePeriod();

    expect(freezeSpy).toHaveBeenCalledWith(
      FIXED_WORKER_RUN_ID,
      "runtime_event_handler",
      "message_delta: event handling failure"
    );
    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "frozen",
        updated_at: FIXED_NOW
      })
    );
    expect(
      (reportAsyncFailure.mock.calls as unknown[][]).some((call) => {
        const error = call[0] as unknown;
        return error instanceof CoreError && error.message.includes("Worker may remain in-flight");
      })
    ).toBe(true);
  });

  it("keeps a completed worker terminal when complete fails after durable state mutation", async () => {
    const reportAsyncFailure = vi.fn(async () => undefined);
    const manual = createManualRuntimeAdapter();
    const harness = createHarness([], {
      runtimeAdapter: manual.adapter,
      reportAsyncFailure
    });
    const freezeSpy = vi.spyOn(harness.workerRunLifecycle, "freeze");

    vi.spyOn(harness.workerRunLifecycle, "complete").mockImplementationOnce(async (workerRunId) => {
      await harness.repo.updateState(workerRunId, "active", "completed", FIXED_NOW);
      throw new Error("state changed broadcast exploded");
    });

    await harness.service.dispatch(createDispatchInput());
    manual.emit({
      ...sessionFinishedEvent("completed", "done"),
      session_id: "scripted-session-1"
    });
    await flushAsync();
    await flushAsync();

    expect(freezeSpy).not.toHaveBeenCalled();
    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "completed",
        updated_at: FIXED_NOW
      })
    );
    expect(reportAsyncFailure).toHaveBeenCalledWith(expect.any(Error), {
      phase: "event",
      workerRunId: FIXED_WORKER_RUN_ID,
      sessionId: "scripted-session-1",
      eventType: "session_finished"
    });
  });

  it("reports explicit escalation when freeze and abort both fail during runtime event recovery", async () => {
    const reportAsyncFailure = vi.fn(async () => undefined);
    const manual = createManualRuntimeAdapter();
    const harness = createHarness([], {
      runtimeAdapter: manual.adapter,
      reportAsyncFailure
    });

    vi.spyOn(harness.workerRunLifecycle, "freeze").mockRejectedValueOnce(new Error("freeze exploded"));
    vi.spyOn(harness.workerRunLifecycle, "abort").mockRejectedValueOnce(new Error("abort exploded"));

    harness.eventNormalizer.normalize.mockRejectedValueOnce(new Error("normalizer exploded"));

    await harness.service.dispatch(createDispatchInput());
    manual.emit({
      ...messageDeltaEvent("bad chunk", 0),
      session_id: "scripted-session-1"
    });
    await flushTimerTick();
    await flushAsync();
    await flushTimerTick();
    await flushAsync();
    await flushRecoveryGracePeriod();

    expect(harness.getById(FIXED_WORKER_RUN_ID)).toEqual(
      createWorkerRun({
        worker_run_id: FIXED_WORKER_RUN_ID,
        state: "active",
        updated_at: FIXED_NOW
      })
    );
    expect(
      (reportAsyncFailure.mock.calls as unknown[][]).some((call) => {
        const error = call[0] as unknown;
        return error instanceof CoreError && error.message.includes("in-flight");
      })
    ).toBe(true);
  });

  it("can resolve a fresh runtime adapter from a factory for each dispatch", async () => {
    const runtimeA = createManualRuntimeAdapter();
    const runtimeB = createManualRuntimeAdapter();
    let nextWorkerRunId = 1;
    const runtimeAdapterFactory = vi
      .fn<() => AgentRuntimePort>()
      .mockReturnValueOnce(runtimeA.adapter)
      .mockReturnValueOnce(runtimeB.adapter);
    const harness = createHarness([], {
      runtimeAdapterFactory,
      generateWorkerRunId: () => `worker-run-serial-${nextWorkerRunId++}`
    });

    const firstRun = await harness.service.dispatch(createDispatchInput());
    runtimeA.emit({
      ...sessionFinishedEvent("completed", "done"),
      session_id: "scripted-session-1"
    });
    await flushAsync();

    const secondRun = await harness.service.dispatch(createDispatchInput());

    expect(firstRun.worker_run_id).toBe("worker-run-serial-1");
    expect(secondRun.worker_run_id).toBe("worker-run-serial-2");
    expect(runtimeAdapterFactory).toHaveBeenCalledTimes(2);
    expect(runtimeA.adapter.createSession).toHaveBeenCalledTimes(1);
    expect(runtimeB.adapter.createSession).toHaveBeenCalledTimes(1);
  });
});

function createHarness(
  events: readonly RuntimeEvent[],
  options: HarnessOptions = {}
): {
  readonly repo: {
    readonly getById: TestMock;
    readonly deleteIfState: TestMock;
    readonly updateState: TestMock;
    readonly insertIfNoActiveForPrincipal: TestMock;
  };
  readonly publishedEvents: Array<Omit<EventLogEntry, "event_id" | "created_at">>;
  readonly runtimeAdapter: AgentRuntimePort;
  readonly eventNormalizer: {
    readonly normalize: RuntimeNormalizeMock;
    readonly clearSessionState: ClearSessionStateMock;
  };
  readonly constraintProxy: {
    readonly assertNoViolation: TestMock;
  };
  readonly dirtyStatePanicService: {
    readonly triggerPanic: TestMock;
  };
  readonly strongRefService: {
    readonly protect: TestMock;
    readonly releaseBySource: TestMock;
  };
  readonly workerRunLifecycle: WorkerRunLifecycleService;
  readonly service: SerialDelegationService;
  getById(workerRunId: string): Readonly<DelegatedWorkerRun> | null;
} {
  const workerStore = new Map<string, DelegatedWorkerRun>(
    (options.existingRuns ?? []).map((run) => [run.worker_run_id, Object.freeze({ ...run })])
  );
  const publishedEvents: Array<Omit<EventLogEntry, "event_id" | "created_at">> = [];
  const runtimeAdapter = options.runtimeAdapter ?? new ScriptedRuntimeAdapter(events);

  const repo = {
    getById: vi.fn(async (workerRunId: string) => workerStore.get(workerRunId) ?? null),
    deleteIfState: vi.fn(async (workerRunId: string, expectedState: DelegatedWorkerRun["state"]) => {
      const current = workerStore.get(workerRunId);

      if (current === undefined) {
        throw new CoreError("NOT_FOUND", `Worker run ${workerRunId} not found`);
      }

      if (current.state !== expectedState) {
        throw new CoreError(
          "CONFLICT",
          `Worker run ${workerRunId} changed concurrently: expected ${expectedState}, found ${current.state}`
        );
      }

      workerStore.delete(workerRunId);
    }),
    updateState: vi.fn(
      async (
        workerRunId: string,
        expectedState: DelegatedWorkerRun["state"],
        nextState: DelegatedWorkerRun["state"],
        updatedAt: string
      ) => {
        const current = workerStore.get(workerRunId);

        if (current === undefined) {
          throw new CoreError("NOT_FOUND", `Worker run ${workerRunId} not found`);
        }

        if (current.state !== expectedState) {
          throw new CoreError(
            "CONFLICT",
            `Worker run ${workerRunId} changed concurrently: expected ${expectedState}, found ${current.state}`
          );
        }

        const updated = Object.freeze({
          ...current,
          state: nextState,
          updated_at: updatedAt
        });
        workerStore.set(workerRunId, updated);
        return updated;
      }
    ),
    insertIfNoActiveForPrincipal: vi.fn(async (principalRunId: string, run: DelegatedWorkerRun) => {
      const hasInFlightWorker = [...workerStore.values()].some(
        (candidate) =>
          candidate.principal_run_id === principalRunId &&
          ["init", "active", "suspended"].includes(candidate.state)
      );

      if (hasInFlightWorker) {
        throw createStorageConflictError(
          `Serial delegation: principal ${principalRunId} already has an in-flight worker`
        );
      }

      const inserted = Object.freeze({ ...run });
      workerStore.set(inserted.worker_run_id, inserted);
      return inserted;
    })
  };

  const eventPublisher = {
    publish: vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at">) => {
      publishedEvents.push(event);
      return {
        ...event,
        event_id: `event-${publishedEvents.length}`,
        created_at: FIXED_NOW
      } satisfies EventLogEntry;
    }),
    publishWithMutation: vi.fn(
      async (
        event: Omit<EventLogEntry, "event_id" | "created_at">,
        mutate: () => Promise<DelegatedWorkerRun>
      ) => {
        publishedEvents.push(event);
        return await mutate();
      }
    )
  } as unknown as EventPublisher;

  const workerRunLifecycle = new WorkerRunLifecycleService({
    repo,
    eventPublisher,
    now: () => FIXED_NOW
  });
  const eventNormalizer: {
    readonly normalize: RuntimeNormalizeMock;
    readonly clearSessionState: ClearSessionStateMock;
  } = {
    normalize: vi.fn(
      async (
        _event: RuntimeEvent,
        _context: RuntimeNormalizerContext
      ) => null
    ),
    clearSessionState: vi.fn()
  };
  const workerSafetyGate =
    options.workerSafetyGate ??
    ({
      enforceBeforeDispatch: vi.fn(async () => createWorkerBaselineLock())
    } as const);
  const zeroDaySecurityLayer =
    options.zeroDaySecurityLayer ??
    ({
      augmentLock: vi.fn(async (lock: WorkerBaselineLock) => lock)
    } as const);
  const integrationGate =
    options.integrationGate ??
    ({
      check: vi.fn(async () => createIntegrationDecision("ignore_drift"))
    } as const);
  const constraintProxy =
    options.constraintProxy ??
    ({
      assertNoViolation: vi.fn(async () => undefined)
    } as const);
  const dirtyStatePanicService =
    options.dirtyStatePanicService ??
    ({
      triggerPanic: vi.fn(
        async (params: {
          workerRunId: string;
          trigger: string;
          panicSource: string;
          summary: string;
          affectedScope: readonly { entity_type: string; entity_id: string }[];
        }) =>
          await workerRunLifecycle.freeze(
            params.workerRunId,
            params.panicSource,
            params.summary
          )
      )
    } as const);
  const strongRefService =
    options.strongRefService ??
    ({
      protect: vi.fn(async () => undefined),
      releaseBySource: vi.fn(async () => undefined)
    } as const);
  const service = new SerialDelegationService({
    workerRunLifecycle,
    workerRunRepo: repo,
    runtimeAdapter: options.runtimeAdapterFactory === undefined ? runtimeAdapter : undefined,
    runtimeAdapterFactory: options.runtimeAdapterFactory,
    workerSafetyGate,
    zeroDaySecurityLayer,
    integrationGate,
    constraintProxy,
    dirtyStatePanicService,
    strongRefService,
    eventNormalizer,
    reportAsyncFailure: options.reportAsyncFailure,
    generateWorkerRunId: options.generateWorkerRunId ?? (() => FIXED_WORKER_RUN_ID),
    now: () => FIXED_NOW
  });

  return {
    repo,
    publishedEvents,
    runtimeAdapter,
    eventNormalizer,
    constraintProxy,
    dirtyStatePanicService,
    strongRefService,
    workerRunLifecycle,
    service,
    getById: (workerRunId: string) => workerStore.get(workerRunId) ?? null
  };
}

function createManualRuntimeAdapter(options: {
  readonly prompt?: (
    sessionId: string,
    input: { readonly prompt: string },
    emit: (event: RuntimeEvent) => void
  ) => Promise<void>;
  readonly cancel?: (
    sessionId: string,
    emit: (event: RuntimeEvent) => void
  ) => Promise<RuntimeCancelResult>;
} = {}): {
  readonly adapter: AgentRuntimePort;
  emit(event: RuntimeEvent): void;
} {
  const handlers = new Set<(event: RuntimeEvent) => void>();
  const session: RuntimeSession = { session_id: "scripted-session-1" };
  const capabilities: RuntimeCapabilities = {
    supports_resume: false,
    supports_interrupt: true,
    supports_streaming_updates: true,
    supports_tool_events: true,
    supports_permission_requests: true,
    supports_artifact_events: false,
    supports_terminal_events: false
  };

  return {
    adapter: {
      kind: "manual_runtime",
      getCapabilities: () => capabilities,
      createSession: vi.fn(async (_config: RuntimeSessionConfig) => session),
      prompt: vi.fn(
        async (sessionId: string, input: { readonly prompt: string }) =>
          await options.prompt?.(sessionId, input, (event) => {
            for (const handler of handlers) {
              handler(event);
            }
          })
      ),
      cancel: vi.fn(
        async (sessionId: string): Promise<RuntimeCancelResult> =>
          (await options.cancel?.(sessionId, (event) => {
            for (const handler of handlers) {
              handler(event);
            }
          })) ?? {
            session_id: sessionId,
            status: "already_finished"
          }
      ),
      onEvent: (handler: (event: RuntimeEvent) => void) => {
        handlers.add(handler);
        return () => {
          handlers.delete(handler);
        };
      }
    },
    emit(event: RuntimeEvent) {
      for (const handler of handlers) {
        handler(event);
      }
    }
  };
}

function createDispatchInput(overrides: Partial<DispatchWorkerInput> = {}): DispatchWorkerInput {
  return {
    principalRunId: "principal-run-1",
    workspaceId: "ws-serial-delegation",
    engineClass: "coding_engine",
    subtaskDescription: "Audit the failing worker path.",
    localSurfaceRef: "surface://principal/1",
    localEvidencePointer: "evidence://principal/1",
    restrictedToolSet: ["read_file", "exec_shell"],
    localBudget: {
      max_worker_delegations: 1,
      max_tool_calls: 4,
      max_output_tokens: 2048,
      max_wall_time_ms: 120000
    },
    agreedReturnFormat: {
      allowed_return_kinds: ["analysis_note", "verification_result"],
      requires_structured_summary: true
    },
    principalSecuritySnapshot: {
      governance_lease_ref: "lease://principal/1",
      hard_constraint_refs: ["constraint://1"],
      denied_tool_categories: ["network"]
    },
    sessionConfig: createSessionConfig(),
    prompt: "Investigate the failure and report the cause.",
    ...overrides
  };
}

function createSessionConfig(): RuntimeSessionConfig {
  return {
    role: "worker",
    workspace_id: "ws-serial-delegation",
    run_id: "principal-run-1",
    cwd: "/workspace",
    writable_roots: ["/workspace"],
    tool_profile: "coding",
    allowed_mcp_servers: ["github"],
    sandbox_policy: "workspace_write",
    permission_policy: "ask",
    network_policy: "restricted"
  };
}

function createWorkerRun(overrides: Partial<DelegatedWorkerRun> = {}): DelegatedWorkerRun {
  return {
    worker_run_id: overrides.worker_run_id ?? FIXED_WORKER_RUN_ID,
    principal_run_id: overrides.principal_run_id ?? "principal-run-1",
    workspace_id: overrides.workspace_id ?? "ws-serial-delegation",
    requesting_run_id: overrides.requesting_run_id ?? "principal-run-1",
    engine_class: overrides.engine_class ?? "coding_engine",
    state: overrides.state ?? "init",
    subtask_description: overrides.subtask_description ?? "Audit the failing worker path.",
    local_surface_ref: overrides.local_surface_ref ?? "surface://principal/1",
    local_evidence_pointer: overrides.local_evidence_pointer ?? "evidence://principal/1",
    restricted_tool_set: overrides.restricted_tool_set ?? ["read_file", "exec_shell"],
    local_budget:
      overrides.local_budget ?? {
        max_worker_delegations: 1,
        max_tool_calls: 4,
        max_output_tokens: 2048,
        max_wall_time_ms: 120000
      },
    agreed_return_format:
      overrides.agreed_return_format ?? {
        allowed_return_kinds: ["analysis_note", "verification_result"],
        requires_structured_summary: true
      },
    principal_security_snapshot:
      overrides.principal_security_snapshot ?? {
        governance_lease_ref: "lease://principal/1",
        hard_constraint_refs: ["constraint://1"],
        denied_tool_categories: ["network"]
      },
    created_at: overrides.created_at ?? FIXED_NOW,
    updated_at: overrides.updated_at ?? FIXED_NOW
  };
}

function createWorkerBaselineLock(overrides: Partial<WorkerBaselineLock> = {}): WorkerBaselineLock {
  return {
    lock_id: "lock-serial-1",
    workspace_id: "ws-serial-delegation",
    hard_constraint_refs: ["constraint://1"],
    denied_tool_categories: ["network"],
    hazard_object_refs: ["hazard://1"],
    hard_stop_refs: [],
    assembled_at: FIXED_NOW,
    ...overrides
  };
}

function createIntegrationDecision(
  level: IntegrationGateDecision["level"],
  reason = "capabilities match expected baseline"
): IntegrationGateDecision {
  return {
    workerRunId: FIXED_WORKER_RUN_ID,
    level,
    reason,
    detectedAt: FIXED_NOW,
    mismatches: []
  };
}

function messageDeltaEvent(delta: string, sequence: number): RuntimeEvent {
  return {
    type: "message_delta",
    session_id: "session-1",
    emitted_at: "2026-04-13T11:00:01.000Z",
    delta,
    sequence
  };
}

function sessionFinishedEvent(
  status: "completed" | "cancelled" | "failed",
  resultSummary: string | null
): RuntimeEvent {
  return {
    type: "session_finished",
    session_id: "session-1",
    emitted_at: "2026-04-13T11:00:02.000Z",
    status,
    result_summary: resultSummary
  };
}

function createStorageConflictError(message: string): Error & { readonly code: "CONFLICT" } {
  return Object.assign(new Error(message), {
    name: "StorageError",
    code: "CONFLICT" as const
  });
}

async function flushAsync(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}

async function flushTimerTick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function flushRecoveryGracePeriod(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  await flushAsync();
  await flushAsync();
  await flushAsync();
}
