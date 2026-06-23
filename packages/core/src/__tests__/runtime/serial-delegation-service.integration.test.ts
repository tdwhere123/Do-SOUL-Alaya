import { describe, expect, it } from "vitest";
import type {
  AgentRuntimePort,
  DelegatedWorkerRun,
  EventLogEntry,
  RuntimeCapabilities,
  RuntimeSession,
  RuntimeSessionConfig,
  WorkerBaselineLock,
  WorkerRunState,
  WorkerSafetyPort,
  ZeroDayPolicy
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import { EventPublisher } from "../../runtime/event-publisher.js";
import { WorkerRunLifecycleService } from "../../runtime/worker-run-lifecycle-service.js";
import { SerialDelegationService } from "../../runtime/serial-delegation-service.js";
import { WorkerSafetyGate } from "../../security/worker-safety-gate.js";
import { ZeroDaySecurityLayer } from "../../security/zero-day-security-layer.js";
import { IntegrationGate, VERIFIED_CLAUDE_RUNTIME_CAPABILITY_PROFILE } from "../../security/integration-gate.js";
import { createDispatchInput, createSessionConfig } from "./serial-delegation-service-test-fixtures.js";

const FIXED_NOW = "2026-04-13T11:00:00.000Z";

// Real port contract, Map-backed (no mocks): exercises the live insert/get seam.
class InMemoryWorkerRunRepo {
  public readonly store = new Map<string, DelegatedWorkerRun>();

  public async getById(workerRunId: string): Promise<Readonly<DelegatedWorkerRun> | null> {
    return this.store.get(workerRunId) ?? null;
  }

  public async deleteIfState(workerRunId: string, expectedState: WorkerRunState): Promise<void> {
    const current = this.store.get(workerRunId);
    if (current === undefined) {
      throw new CoreError("NOT_FOUND", `Worker run ${workerRunId} not found`);
    }
    if (current.state !== expectedState) {
      throw new CoreError("CONFLICT", `Worker run ${workerRunId} changed concurrently`);
    }
    this.store.delete(workerRunId);
  }

  public updateState(
    workerRunId: string,
    expectedState: WorkerRunState,
    nextState: WorkerRunState,
    updatedAt: string
  ): Readonly<DelegatedWorkerRun> {
    const current = this.store.get(workerRunId);
    if (current === undefined) {
      throw new CoreError("NOT_FOUND", `Worker run ${workerRunId} not found`);
    }
    if (current.state !== expectedState) {
      throw new CoreError("CONFLICT", `Worker run ${workerRunId} changed concurrently`);
    }
    const updated = Object.freeze({ ...current, state: nextState, updated_at: updatedAt });
    this.store.set(workerRunId, updated);
    return updated;
  }

  public async insertIfNoActiveForPrincipal(
    principalRunId: string,
    run: DelegatedWorkerRun
  ): Promise<Readonly<DelegatedWorkerRun>> {
    const hasInFlight = [...this.store.values()].some(
      (candidate) =>
        candidate.principal_run_id === principalRunId &&
        ["init", "active", "suspended"].includes(candidate.state)
    );
    if (hasInFlight) {
      throw new CoreError("CONFLICT", `principal ${principalRunId} already has an in-flight worker`);
    }
    const inserted = Object.freeze({ ...run });
    this.store.set(inserted.worker_run_id, inserted);
    return inserted;
  }
}

function createStubRuntimeAdapter(): AgentRuntimePort {
  const capabilities: RuntimeCapabilities = VERIFIED_CLAUDE_RUNTIME_CAPABILITY_PROFILE.capabilities;
  const session: RuntimeSession = { session_id: "integration-session-1" };
  return {
    kind: "stub_runtime",
    getCapabilities: () => capabilities,
    createSession: async (_config: RuntimeSessionConfig) => session,
    prompt: async () => undefined,
    cancel: async (sessionId: string) => ({ session_id: sessionId, status: "already_finished" as const }),
    onEvent: () => () => undefined
  };
}

function createInertEventPublisher(): EventPublisher {
  return new EventPublisher({
    eventLogRepo: {
      append: () => {
        throw new Error("EventPublisher must not be reached in the pre-insert block path");
      },
      deleteById: () => undefined,
      transactional: <T>(fn: () => T): T => fn()
    },
    runHotStateService: { apply: () => undefined },
    runtimeNotifier: {
      notify: () => undefined,
      notifyEntry: (_entry: EventLogEntry) => undefined
    }
  });
}

describe("SerialDelegationService integration (real collaborators)", () => {
  it("declines dispatch and inserts no worker run when the real WorkerSafetyGate blocks a snapshot that misses a baseline hard constraint", async () => {
    const repo = new InMemoryWorkerRunRepo();
    const workerRunLifecycle = new WorkerRunLifecycleService({
      repo,
      eventPublisher: createInertEventPublisher(),
      now: () => FIXED_NOW
    });

    // Real safety port assembles a lock requiring a hard constraint the principal snapshot lacks.
    const safetyPort: WorkerSafetyPort = {
      kind: "integration-test-safety-port",
      assembleBaselineLock: async (workspaceId: string): Promise<WorkerBaselineLock> => ({
        lock_id: "lock-integration-1",
        workspace_id: workspaceId,
        hard_constraint_refs: ["constraint://baseline-required"],
        denied_tool_categories: ["network"],
        hazard_object_refs: ["hazard://1"],
        hard_stop_refs: [],
        assembled_at: FIXED_NOW
      })
    };
    const workerSafetyGate = new WorkerSafetyGate({ safetyPort });
    const zeroDaySecurityLayer = new ZeroDaySecurityLayer({
      loadPolicies: async (): Promise<readonly ZeroDayPolicy[]> => [],
      now: () => FIXED_NOW
    });
    const integrationGate = new IntegrationGate({
      expectedProfile: VERIFIED_CLAUDE_RUNTIME_CAPABILITY_PROFILE,
      eventPublisher: createInertEventPublisher(),
      now: () => FIXED_NOW
    });

    const service = new SerialDelegationService({
      workerRunLifecycle,
      workerRunRepo: repo,
      runtimeAdapter: createStubRuntimeAdapter(),
      workerSafetyGate,
      zeroDaySecurityLayer,
      integrationGate,
      constraintProxy: { assertNoViolation: async () => undefined },
      dirtyStatePanicService: {
        triggerPanic: async () => {
          throw new Error("panic not reached in a pre-dispatch gate-block test");
        }
      },
      strongRefService: {
        protect: async () => {
          throw new Error("strong-ref not reached in a pre-dispatch gate-block test");
        },
        releaseBySource: async () => undefined
      },
      eventNormalizer: { normalize: async () => null, clearSessionState: () => undefined },
      generateWorkerRunId: () => "worker-run-integration-1",
      now: () => FIXED_NOW
    });

    const input = createDispatchInput({
      // Principal snapshot deliberately omits the baseline-required constraint.
      principalSecuritySnapshot: {
        governance_lease_ref: "lease://principal/1",
        hard_constraint_refs: ["constraint://principal-only"],
        denied_tool_categories: ["network"]
      },
      sessionConfig: createSessionConfig()
    });

    const error = await service.dispatch(input).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CoreError);
    expect((error as CoreError).code).toBe("VALIDATION");
    expect((error as CoreError).message).toContain("missing 1 hard constraint ref(s)");

    // End state: the real gate refused before any persistence — nothing inserted.
    expect(repo.store.size).toBe(0);
    expect(await repo.getById("worker-run-integration-1")).toBeNull();
  });
});
