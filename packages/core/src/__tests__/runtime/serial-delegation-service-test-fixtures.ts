import { vi } from "vitest";
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
import { CoreError } from "../../shared/errors.js";
import { EventPublisher } from "../../runtime/event-publisher.js";
import { WorkerRunLifecycleService } from "../../runtime/worker-run-lifecycle-service.js";
import { type IntegrationGateDecision } from "../../security/integration-gate.js";
import { SerialDelegationService, type DispatchWorkerInput } from "../../runtime/serial-delegation-service.js";
import { ScriptedRuntimeAdapter } from "../../test-doubles/__tests__/scripted-runtime-adapter.js";
import type { TestMock } from "../shared/mock-types.js";

export const FIXED_NOW = "2026-04-13T11:00:00.000Z";
export const FIXED_WORKER_RUN_ID = "worker-run-serial-1";

export interface HarnessOptions {
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

export type RuntimeNormalizerContext = {
  readonly workspaceId: string;
  readonly principalRunId: string;
  readonly workerRunId: string;
};
export type RuntimeNormalizeMock = TestMock<
  (event: RuntimeEvent, context: RuntimeNormalizerContext) => Promise<EventLogEntry | null>
>;
export type ClearSessionStateMock = TestMock<(sessionId: string) => void>;

export function createHarness(
  events: readonly RuntimeEvent[],
  options: HarnessOptions = {}
): {
  readonly repo: {
    readonly getById: TestMock;
    readonly deleteIfState: TestMock;
    readonly updateState: TestMock;
    readonly insertIfNoActiveForPrincipal: TestMock;
  };
  readonly publishedEvents: Array<Omit<EventLogEntry, "event_id" | "created_at" | "revision">>;
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

export function createManualRuntimeAdapter(options: {
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

export function createDispatchInput(overrides: Partial<DispatchWorkerInput> = {}): DispatchWorkerInput {
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

export function createSessionConfig(): RuntimeSessionConfig {
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

export function createWorkerRun(overrides: Partial<DelegatedWorkerRun> = {}): DelegatedWorkerRun {
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

export function messageDeltaEvent(delta: string, sequence: number): RuntimeEvent {
  return {
    type: "message_delta",
    session_id: "session-1",
    emitted_at: "2026-04-13T11:00:01.000Z",
    delta,
    sequence
  };
}

export function sessionFinishedEvent(
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

export async function flushAsync(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}

export async function flushTimerTick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export async function flushRecoveryGracePeriod(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  await flushAsync();
  await flushAsync();
  await flushAsync();
}
