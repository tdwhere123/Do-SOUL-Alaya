import { vi, type Mock } from "vitest";
import type { AgentRuntimePort, DelegatedWorkerRun, EventLogEntry, RuntimeEvent, StrongRef, WorkerBaselineLock } from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import { EventPublisher } from "../../runtime/event-publisher.js";
import { WorkerRunLifecycleService } from "../../runtime/worker-run-lifecycle-service.js";
import { type IntegrationGateDecision } from "../../security/integration-gate.js";
import {
  SerialDelegationService,
  type ConstraintProxyPort,
  type DirtyStatePanicServicePort,
  type IntegrationGatePort,
  type StrongRefServicePort,
  type WorkerSafetyGatePort,
  type ZeroDaySecurityLayerPort
} from "../../runtime/serial-delegation-service.js";
import { ScriptedRuntimeAdapter } from "../../test-doubles/__tests__/scripted-runtime-adapter.js";

export const FIXED_NOW = "2026-04-13T11:00:00.000Z";

export const FIXED_WORKER_RUN_ID = "worker-run-serial-1";

export interface HarnessOptions {
  readonly runtimeAdapter?: AgentRuntimePort;
  readonly runtimeAdapterFactory?: () => AgentRuntimePort;
  readonly workerSafetyGate?: WorkerSafetyGatePort;
  readonly zeroDaySecurityLayer?: ZeroDaySecurityLayerPort;
  readonly integrationGate?: IntegrationGatePort;
  readonly constraintProxy?: ConstraintProxyPort;
  readonly dirtyStatePanicService?: DirtyStatePanicServicePort;
  readonly strongRefService?: StrongRefServicePort;
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

export type RuntimeNormalizerContext = {
  readonly workspaceId: string;
  readonly principalRunId: string;
  readonly workerRunId: string;
};

export type RuntimeNormalizeMock = Mock<
  (event: RuntimeEvent, context: RuntimeNormalizerContext) => Promise<EventLogEntry | null>
>;

export type ClearSessionStateMock = Mock<(sessionId: string) => void>;

type HarnessWorkerRunRepo = {
  readonly getById: Mock<(workerRunId: string) => Promise<Readonly<DelegatedWorkerRun> | null>>;
  readonly deleteIfState: Mock<
    (workerRunId: string, expectedState: DelegatedWorkerRun["state"]) => Promise<void>
  >;
  readonly updateState: Mock<
    (
      workerRunId: string,
      expectedState: DelegatedWorkerRun["state"],
      nextState: DelegatedWorkerRun["state"],
      updatedAt: string
    ) => Readonly<DelegatedWorkerRun>
  >;
  readonly insertIfNoActiveForPrincipal: Mock<
    (principalRunId: string, run: DelegatedWorkerRun) => Promise<Readonly<DelegatedWorkerRun>>
  >;
};

export function createHarness(
  events: readonly RuntimeEvent[],
  options: HarnessOptions = {}
): {
  readonly repo: HarnessWorkerRunRepo;
  readonly publishedEvents: Array<Omit<EventLogEntry, "event_id" | "created_at" | "revision">>;
  readonly runtimeAdapter: AgentRuntimePort;
  readonly eventNormalizer: {
    readonly normalize: RuntimeNormalizeMock;
    readonly clearSessionState: ClearSessionStateMock;
  };
  readonly constraintProxy: ConstraintProxyPort;
  readonly dirtyStatePanicService: DirtyStatePanicServicePort;
  readonly strongRefService: StrongRefServicePort;
  readonly workerRunLifecycle: WorkerRunLifecycleService;
  readonly service: SerialDelegationService;
  getById(workerRunId: string): Readonly<DelegatedWorkerRun> | null;
} {
  const workerStore = new Map<string, DelegatedWorkerRun>(
    (options.existingRuns ?? []).map((run) => [run.worker_run_id, Object.freeze({ ...run })])
  );
  const publishedEvents: Array<Omit<EventLogEntry, "event_id" | "created_at" | "revision">> = [];
  const runtimeAdapter = options.runtimeAdapter ?? new ScriptedRuntimeAdapter(events);

  const updateStateImpl = (
    workerRunId: string,
    expectedState: DelegatedWorkerRun["state"],
    nextState: DelegatedWorkerRun["state"],
    updatedAt: string
  ): DelegatedWorkerRun => {
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
  };

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
      (
        workerRunId: string,
        expectedState: DelegatedWorkerRun["state"],
        nextState: DelegatedWorkerRun["state"],
        updatedAt: string
      ) => updateStateImpl(workerRunId, expectedState, nextState, updatedAt)
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
    publish: vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => {
      publishedEvents.push(event);
      return {
        ...event,
        event_id: `event-${publishedEvents.length}`,
        created_at: FIXED_NOW,
        revision: publishedEvents.length
      } satisfies EventLogEntry;
    }),
    appendManyWithMutation: vi.fn(
      async (
        events: ReadonlyArray<Omit<EventLogEntry, "event_id" | "created_at" | "revision">>,
        mutate: (entries: readonly EventLogEntry[]) => DelegatedWorkerRun
      ) => {
        for (const event of events) {
          publishedEvents.push(event);
        }
        const persisted = events.map((event, idx) => ({
          ...event,
          event_id: `event-${publishedEvents.length - events.length + idx}`,
          created_at: FIXED_NOW,
          revision: idx
        })) as EventLogEntry[];
        return mutate(persisted);
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
      ): Promise<EventLogEntry | null> => null
    ),
    clearSessionState: vi.fn((_sessionId: string) => {})
  };
  const workerSafetyGate: WorkerSafetyGatePort =
    options.workerSafetyGate ??
    {
      enforceBeforeDispatch: vi.fn(async (
        _workerRun: Parameters<WorkerSafetyGatePort["enforceBeforeDispatch"]>[0]
      ) => createWorkerBaselineLock())
    };
  const zeroDaySecurityLayer: ZeroDaySecurityLayerPort =
    options.zeroDaySecurityLayer ??
    {
      augmentLock: vi.fn(async (lock: WorkerBaselineLock) => lock)
    };
  const integrationGate: IntegrationGatePort =
    options.integrationGate ??
    {
      check: vi.fn(async (
        _workerRun: Parameters<IntegrationGatePort["check"]>[0],
        _actualCapabilities: Parameters<IntegrationGatePort["check"]>[1]
      ) => createIntegrationDecision("ignore_drift"))
    };
  const constraintProxy: ConstraintProxyPort =
    options.constraintProxy ??
    {
      assertNoViolation: vi.fn(async (
        _workspaceId: string,
        _runId: string,
        _operation: Parameters<ConstraintProxyPort["assertNoViolation"]>[2]
      ): Promise<void> => {})
    };
  const dirtyStatePanicService: DirtyStatePanicServicePort =
    options.dirtyStatePanicService ??
    {
      triggerPanic: vi.fn(async (params: Parameters<DirtyStatePanicServicePort["triggerPanic"]>[0]) => {
        await workerRunLifecycle.freeze(
          params.workerRunId,
          params.panicSource,
          params.summary
        );
        return {
          dossier_id: `dossier-${params.workerRunId}`,
          worker_run_id: params.workerRunId,
          principal_run_id: "principal-run-serial-1",
          workspace_id: "ws-serial-delegation",
          trigger: params.trigger,
          panic_source: params.panicSource,
          panic_summary: params.summary,
          affected_data_scope: params.affectedScope,
          created_at: FIXED_NOW
        };
      })
    };
  const strongRefService: StrongRefServicePort =
    options.strongRefService ??
    {
      protect: vi.fn(async (params: Parameters<StrongRefServicePort["protect"]>[0]): Promise<StrongRef> => ({
        ref_id: "strong-ref-serial-1",
        source_entity_type: params.sourceEntityType,
        source_entity_id: params.sourceEntityId,
        target_entity_type: params.targetEntityType,
        target_entity_id: params.targetEntityId,
        workspace_id: params.workspaceId,
        reason: params.reason,
        created_at: FIXED_NOW
      })),
      releaseBySource: vi.fn(async (
        _params: Parameters<StrongRefServicePort["releaseBySource"]>[0]
      ): Promise<void> => {})
    };
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
  const serviceRecovery = service as unknown as {
    readonly recovery: {
      readonly deps: {
        readonly eventNormalizer: typeof eventNormalizer;
      };
    };
  };

  return {
    repo,
    publishedEvents,
    runtimeAdapter,
    eventNormalizer: {
      get normalize() {
        return serviceRecovery.recovery.deps.eventNormalizer.normalize;
      },
      get clearSessionState() {
        return serviceRecovery.recovery.deps.eventNormalizer.clearSessionState;
      }
    },
    constraintProxy,
    dirtyStatePanicService,
    strongRefService,
    workerRunLifecycle,
    service,
    getById: (workerRunId: string) => workerStore.get(workerRunId) ?? null
  };
}

export function createWorkerBaselineLock(overrides: Partial<WorkerBaselineLock> = {}): WorkerBaselineLock {
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

export function createIntegrationDecision(
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

function createStorageConflictError(message: string): Error & { readonly code: "CONFLICT" } {
  return Object.assign(new Error(message), {
    name: "StorageError",
    code: "CONFLICT" as const
  });
}
