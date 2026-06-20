import { randomUUID } from "node:crypto";
import {
  DelegatedWorkerRunSchema,
  type AgentRuntimePort,
  type DelegatedWorkerRun,
  type RuntimeEvent,
  type RuntimeSessionConfig,
  type WorkerBaselineLock
} from "@do-soul/alaya-protocol";
import { CoreError } from "../shared/errors.js";
import {
  IntegrationGatePublicationError,
  type IntegrationGate
} from "../security/integration-gate.js";
import { SerialDelegationEventIntake } from "./serial-delegation-event-intake.js";
import type {
  NormalizerContext,
  RuntimeEventNormalizer
} from "./runtime-event-normalizer.js";
import {
  SerialDelegationRecovery,
} from "./serial-delegation-recovery.js";
import type { ConstraintProxy } from "../security/constraint-proxy.js";
import type { DirtyStatePanicService } from "./dirty-state-panic-service.js";
import type { StrongRefService } from "../memory/strong-ref-service.js";
import type { WorkerSafetyGate } from "../security/worker-safety-gate.js";
import type { WorkerRunLifecycleService } from "./worker-run-lifecycle-service.js";
import type { ZeroDaySecurityLayer } from "../security/zero-day-security-layer.js";
import {
  applyAugmentedLockToWorkerRun,
  captureIntegrationGateFailure,
  createPreparedWorkerRunState,
  createWorkerSessionState,
  isConflictError,
  isObligationViolationError,
  requireWorkerBaselineLock,
  triggerPreDispatchPanic,
  type PreparedWorkerRunState,
  type WorkerSessionState
} from "./serial-delegation-service-helpers.js";

export interface SerialDelegationWorkerRunRepoPort {
  getById(workerRunId: string): Promise<Readonly<DelegatedWorkerRun> | null>;
  deleteIfState(workerRunId: string, expectedState: DelegatedWorkerRun["state"]): Promise<void>;
  insertIfNoActiveForPrincipal(
    principalRunId: string,
    run: DelegatedWorkerRun
  ): Promise<Readonly<DelegatedWorkerRun>>;
}

export type RuntimeEventNormalizerPort = Pick<RuntimeEventNormalizer, "normalize" | "clearSessionState">;
export type WorkerSafetyGatePort = Pick<WorkerSafetyGate, "enforceBeforeDispatch">;
export type ZeroDaySecurityLayerPort = Pick<ZeroDaySecurityLayer, "augmentLock">;
export type IntegrationGatePort = Pick<IntegrationGate, "check">;
export type ConstraintProxyPort = Pick<ConstraintProxy, "assertNoViolation">;
export type DirtyStatePanicServicePort = Pick<DirtyStatePanicService, "triggerPanic">;
export type StrongRefServicePort = Pick<StrongRefService, "protect" | "releaseBySource">;

export interface SerialDelegationServiceDependencies {
  readonly workerRunLifecycle: WorkerRunLifecycleService;
  readonly workerRunRepo: SerialDelegationWorkerRunRepoPort;
  readonly runtimeAdapter?: AgentRuntimePort;
  readonly runtimeAdapterFactory?: () => AgentRuntimePort;
  readonly workerSafetyGate: WorkerSafetyGatePort;
  readonly zeroDaySecurityLayer: ZeroDaySecurityLayerPort;
  readonly integrationGate: IntegrationGatePort;
  readonly constraintProxy: ConstraintProxyPort;
  readonly dirtyStatePanicService: DirtyStatePanicServicePort;
  readonly strongRefService?: StrongRefServicePort;
  readonly eventNormalizer: RuntimeEventNormalizerPort;
  readonly reportAsyncFailure?: (
    error: unknown,
    metadata: {
      readonly phase: "startup" | "event";
      readonly workerRunId: string;
      readonly sessionId: string | null;
      readonly eventType?: import("@do-soul/alaya-protocol").RuntimeEvent["type"];
    }
  ) => void | Promise<void>;
  readonly generateWorkerRunId?: () => string;
  readonly now?: () => string;
}

export interface DispatchWorkerInput {
  readonly principalRunId: string;
  readonly workspaceId: string;
  readonly engineClass: "coding_engine" | "conversation_engine";
  readonly subtaskDescription: string;
  readonly localSurfaceRef: string;
  readonly localEvidencePointer: string | null;
  readonly restrictedToolSet: readonly string[];
  readonly localBudget: {
    readonly max_worker_delegations: number;
    readonly max_tool_calls: number;
    readonly max_output_tokens: number;
    readonly max_wall_time_ms: number;
  };
  readonly agreedReturnFormat: {
    readonly allowed_return_kinds: readonly string[];
    readonly requires_structured_summary: boolean;
  };
  readonly principalSecuritySnapshot: {
    readonly governance_lease_ref: string;
    readonly hard_constraint_refs: readonly string[];
    readonly denied_tool_categories: readonly string[];
  };
  readonly sessionConfig: RuntimeSessionConfig;
  readonly prompt: string;
  readonly resolveRuntimePromptFromFinalSecuritySnapshot?: (input: {
    readonly workerRun: Readonly<DelegatedWorkerRun>;
  }) => string | Promise<string>;
}

interface RuntimeEventHandlingContext {
  readonly context: NormalizerContext;
  readonly eventIntake: SerialDelegationEventIntake;
  readonly runtimeAdapter: AgentRuntimePort;
  readonly runtimeUnsubscribe: () => void;
  readonly sessionId: string;
  readonly workerRunId: string;
}

export class SerialDelegationService {
  private readonly recovery: SerialDelegationRecovery;

  public constructor(private readonly deps: SerialDelegationServiceDependencies) {
    this.recovery = new SerialDelegationRecovery(deps);
  }

  public async dispatch(input: DispatchWorkerInput): Promise<Readonly<DelegatedWorkerRun>> {
    const workerRun = this.buildWorkerRun(input, this.resolveNow());
    const runtimeAdapter = this.resolveRuntimeAdapter();
    const preparedRun = await this.prepareWorkerRunForDispatch(input, workerRun, runtimeAdapter);
    return await this.runWorkerSession(
      input,
      preparedRun.effectiveWorkerRun,
      preparedRun.runtimePrompt,
      runtimeAdapter
    );
  }

  private buildWorkerRun(input: DispatchWorkerInput, now: string): DelegatedWorkerRun {
    return DelegatedWorkerRunSchema.parse({
      worker_run_id: this.resolveWorkerRunId(),
      principal_run_id: input.principalRunId,
      workspace_id: input.workspaceId,
      requesting_run_id: input.principalRunId,
      engine_class: input.engineClass,
      state: "init",
      subtask_description: input.subtaskDescription,
      local_surface_ref: input.localSurfaceRef,
      local_evidence_pointer: input.localEvidencePointer,
      restricted_tool_set: input.restrictedToolSet,
      local_budget: input.localBudget,
      agreed_return_format: input.agreedReturnFormat,
      principal_security_snapshot: input.principalSecuritySnapshot,
      created_at: now,
      updated_at: now
    });
  }

  private async prepareWorkerRunForDispatch(
    input: DispatchWorkerInput,
    workerRun: DelegatedWorkerRun,
    runtimeAdapter: AgentRuntimePort
  ): Promise<{
    readonly effectiveWorkerRun: DelegatedWorkerRun;
    readonly runtimePrompt: string;
  }> {
    const state = createPreparedWorkerRunState(input.prompt, workerRun);

    try {
      const augmentedBaselineLock = await this.applyPreDispatchSecurity(input, state);
      await this.insertPreparedWorkerRun(input.principalRunId, state);
      await this.assertNoHardStop(state, augmentedBaselineLock);
      await this.assertIntegrationGateAllows(runtimeAdapter, state);
      await this.protectCriticalConstraintRefs(state.effectiveWorkerRun);
      return {
        effectiveWorkerRun: state.effectiveWorkerRun,
        runtimePrompt: state.runtimePrompt
      };
    } catch (error) {
      return await this.rethrowPreDispatchFailure(input.principalRunId, state, error);
    }
  }

  private async runWorkerSession(
    input: DispatchWorkerInput,
    effectiveWorkerRun: DelegatedWorkerRun,
    runtimePrompt: string,
    runtimeAdapter: AgentRuntimePort
  ): Promise<Readonly<DelegatedWorkerRun>> {
    const eventIntake = new SerialDelegationEventIntake();
    const sessionState = createWorkerSessionState();

    try {
      const activeRun = await this.deps.workerRunLifecycle.dispatch(effectiveWorkerRun.worker_run_id);
      const session = await runtimeAdapter.createSession(input.sessionConfig);
      sessionState.sessionId = session.session_id;
      sessionState.unsubscribe = this.wireRuntimeEvents({
        context: {
          workspaceId: input.workspaceId,
          principalRunId: input.principalRunId,
          workerRunId: effectiveWorkerRun.worker_run_id
        },
        eventIntake,
        runtimeAdapter,
        sessionId: session.session_id,
        workerRunId: effectiveWorkerRun.worker_run_id
      });
      await runtimeAdapter.prompt(session.session_id, { prompt: runtimePrompt });
      await eventIntake.drain();
      return activeRun;
    } catch (error) {
      await this.handleRunWorkerSessionFailure(
        error,
        effectiveWorkerRun.worker_run_id,
        runtimeAdapter,
        eventIntake,
        sessionState
      );
      throw error;
    }
  }

  private async applyPreDispatchSecurity(
    input: DispatchWorkerInput,
    state: PreparedWorkerRunState
  ): Promise<WorkerBaselineLock> {
    const baselineLock = requireWorkerBaselineLock(
      await this.deps.workerSafetyGate.enforceBeforeDispatch(state.effectiveWorkerRun),
      "worker baseline lock"
    );
    const augmentedBaselineLock = requireWorkerBaselineLock(
      await this.deps.zeroDaySecurityLayer.augmentLock(baselineLock),
      "augmented worker baseline lock"
    );
    state.effectiveWorkerRun = applyAugmentedLockToWorkerRun(
      state.effectiveWorkerRun,
      augmentedBaselineLock
    );
    state.runtimePrompt =
      (await input.resolveRuntimePromptFromFinalSecuritySnapshot?.({
        workerRun: state.effectiveWorkerRun
      })) ?? input.prompt;
    return augmentedBaselineLock;
  }

  private async insertPreparedWorkerRun(
    principalRunId: string,
    state: PreparedWorkerRunState
  ): Promise<void> {
    await this.deps.workerRunRepo.insertIfNoActiveForPrincipal(principalRunId, state.effectiveWorkerRun);
    state.insertedWorkerRun = true;
  }

  private async assertNoHardStop(
    state: PreparedWorkerRunState,
    augmentedBaselineLock: WorkerBaselineLock
  ): Promise<void> {
    if (augmentedBaselineLock.hard_stop_refs.length === 0) {
      return;
    }

    const reason = `active hard_stop refs: ${augmentedBaselineLock.hard_stop_refs.join(", ")}`;
    await triggerPreDispatchPanic(
      this.deps.dirtyStatePanicService,
      state,
      "worker_baseline_hard_stop",
      "worker baseline hard stop",
      reason,
      "safety_gate_failure",
      augmentedBaselineLock.hard_stop_refs.map((ref) => ({
        entity_type: "constraint_ref",
        entity_id: ref
      }))
    );
    throw state.preDispatchConflict;
  }

  private async assertIntegrationGateAllows(
    runtimeAdapter: AgentRuntimePort,
    state: PreparedWorkerRunState
  ): Promise<void> {
    const integrationDecision = await this.deps.integrationGate.check(
      state.effectiveWorkerRun,
      runtimeAdapter.getCapabilities()
    );
    if (integrationDecision?.level !== "hard_stale") {
      return;
    }

    await triggerPreDispatchPanic(
      this.deps.dirtyStatePanicService,
      state,
      "integration_gate",
      "integration gate",
      integrationDecision.reason,
      "state_inconsistency",
      [{ entity_type: "integration_decision", entity_id: integrationDecision.level }]
    );
    throw state.preDispatchConflict;
  }

  private async rethrowPreDispatchFailure(
    principalRunId: string,
    state: PreparedWorkerRunState,
    error: unknown
  ): Promise<never> {
    captureIntegrationGateFailure(state, error);
    if (state.insertedWorkerRun) {
      await this.recovery.recoverPreDispatchFailure(
        state.effectiveWorkerRun.worker_run_id,
        error,
        state.preDispatchFreezeIntent,
        error instanceof IntegrationGatePublicationError && error.durableDecisionCommitted
      );
    }
    if (state.preDispatchConflict !== null) {
      throw state.preDispatchConflict;
    }
    if (error instanceof CoreError && error.code === "CONFLICT") {
      throw error;
    }
    if (isConflictError(error)) {
      throw new CoreError(
        "CONFLICT",
        `Serial delegation: principal ${principalRunId} already has an in-flight worker`,
        error instanceof Error ? { cause: error } : undefined
      );
    }
    throw error;
  }

  private wireRuntimeEvents(
    params: Omit<RuntimeEventHandlingContext, "runtimeUnsubscribe">
  ): () => void {
    const runtimeUnsubscribe = params.runtimeAdapter.onEvent((event) => {
      if (!params.eventIntake.accepts(event, params.sessionId)) {
        return;
      }

      params.eventIntake.note(event);
      params.eventIntake.enqueue(async () => {
        if (!params.eventIntake.isAcceptingEvents()) {
          return;
        }

        await this.processRuntimeEvent(event, {
          ...params,
          runtimeUnsubscribe
        });
      });
    });

    return runtimeUnsubscribe;
  }

  private async processRuntimeEvent(
    event: RuntimeEvent,
    params: RuntimeEventHandlingContext
  ): Promise<void> {
    try {
      await this.recovery.handleRuntimeEvent(
        event,
        params.context,
        params.workerRunId,
        params.runtimeUnsubscribe,
        () => params.eventIntake.stop()
      );
      if (event.type === "session_finished") {
        params.eventIntake.clearPendingIfCurrent(event);
      }
    } catch (error) {
      await this.recovery.handleRuntimeEventFailure({
        error,
        event,
        context: params.context,
        workerRunId: params.workerRunId,
        sessionId: params.sessionId,
        runtimeAdapter: params.runtimeAdapter,
        unsubscribe: params.runtimeUnsubscribe,
        stopEventIntake: () => params.eventIntake.stop(),
        resumeEventIntake: () => params.eventIntake.resume(),
        awaitPendingSessionFinishedEvent: () => params.eventIntake.awaitPendingSessionFinishedEvent(),
        clearPendingSessionFinishedEvent: (sessionFinishedEvent) => {
          params.eventIntake.clearPendingIfCurrent(sessionFinishedEvent);
        }
      });
      if (isObligationViolationError(error)) {
        throw error;
      }
    }
  }

  private async handleRunWorkerSessionFailure(
    error: unknown,
    workerRunId: string,
    runtimeAdapter: AgentRuntimePort,
    eventIntake: SerialDelegationEventIntake,
    sessionState: WorkerSessionState
  ): Promise<void> {
    if (isObligationViolationError(error)) {
      eventIntake.stop();
      sessionState.unsubscribe?.();
      if (sessionState.sessionId !== null) {
        this.deps.eventNormalizer.clearSessionState(sessionState.sessionId);
      }
      return;
    }

    await this.recovery.handleStartupFailure({
      error,
      workerRunId,
      sessionId: sessionState.sessionId,
      runtimeAdapter,
      unsubscribe: sessionState.unsubscribe,
      stopEventIntake: () => eventIntake.stop(),
      resumeEventIntake: () => eventIntake.resume(),
      drainEventQueue: () => eventIntake.drain()
    });
  }

  private resolveNow(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  private resolveWorkerRunId(): string {
    return this.deps.generateWorkerRunId?.() ?? randomUUID();
  }

  private resolveRuntimeAdapter(): AgentRuntimePort {
    if (this.deps.runtimeAdapterFactory !== undefined) {
      return this.deps.runtimeAdapterFactory();
    }

    if (this.deps.runtimeAdapter !== undefined) {
      return this.deps.runtimeAdapter;
    }

    throw new CoreError(
      "VALIDATION",
      "SerialDelegationService requires runtimeAdapter or runtimeAdapterFactory."
    );
  }

  private async protectCriticalConstraintRefs(workerRun: Readonly<DelegatedWorkerRun>): Promise<void> {
    if (this.deps.strongRefService === undefined) {
      return;
    }

    const uniqueConstraintRefs = [...new Set(workerRun.principal_security_snapshot.hard_constraint_refs)];
    for (const constraintRef of uniqueConstraintRefs) {
      await this.deps.strongRefService.protect({
        sourceEntityType: "worker_run",
        sourceEntityId: workerRun.worker_run_id,
        targetEntityType: "claim_form",
        targetEntityId: constraintRef,
        workspaceId: workerRun.workspace_id,
        reason: "security_snapshot"
      });
    }
  }
}
