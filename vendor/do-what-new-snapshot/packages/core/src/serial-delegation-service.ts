import { randomUUID } from "node:crypto";
import {
  DelegatedWorkerRunSchema,
  type AgentRuntimePort,
  type DelegatedWorkerRun,
  type RuntimeSessionConfig,
  type WorkerBaselineLock
} from "@do-what/protocol";
import { CoreError } from "./errors.js";
import {
  IntegrationGatePublicationError,
  type IntegrationGate,
  type IntegrationGateDecision
} from "./integration-gate.js";
import { SerialDelegationEventIntake } from "./serial-delegation-event-intake.js";
import type {
  NormalizerContext,
  RuntimeEventNormalizer
} from "./runtime-event-normalizer.js";
import {
  SerialDelegationRecovery,
  type PreDispatchFreezeIntent
} from "./serial-delegation-recovery.js";
import type { ConstraintProxy } from "./constraint-proxy.js";
import type { DirtyStatePanicService } from "./dirty-state-panic-service.js";
import type { StrongRefService } from "./strong-ref-service.js";
import type { WorkerSafetyGate } from "./worker-safety-gate.js";
import type { WorkerRunLifecycleService } from "./worker-run-lifecycle-service.js";
import type { ZeroDaySecurityLayer } from "./zero-day-security-layer.js";

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
      readonly eventType?: import("@do-what/protocol").RuntimeEvent["type"];
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

export class SerialDelegationService {
  private readonly recovery: SerialDelegationRecovery;

  public constructor(private readonly deps: SerialDelegationServiceDependencies) {
    this.recovery = new SerialDelegationRecovery(deps);
  }

  public async dispatch(input: DispatchWorkerInput): Promise<Readonly<DelegatedWorkerRun>> {
    const now = this.resolveNow();
    const workerRun = DelegatedWorkerRunSchema.parse({
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
    let sessionId: string | null = null;
    let unsubscribe: (() => void) | null = null;
    const runtimeAdapter = this.resolveRuntimeAdapter();
    const eventIntake = new SerialDelegationEventIntake();
    let runtimePrompt = input.prompt;
    let integrationDecision: IntegrationGateDecision | null = null;
    let effectiveWorkerRun = workerRun;
    let insertedWorkerRun = false;
    let preDispatchConflict: CoreError | null = null;
    let preDispatchFreezeIntent: PreDispatchFreezeIntent | null = null;

    try {
      const baselineLock = requireWorkerBaselineLock(
        await this.deps.workerSafetyGate.enforceBeforeDispatch(workerRun),
        "worker baseline lock"
      );
      const augmentedBaselineLock = requireWorkerBaselineLock(
        await this.deps.zeroDaySecurityLayer.augmentLock(baselineLock),
        "augmented worker baseline lock"
      );
      effectiveWorkerRun = applyAugmentedLockToWorkerRun(workerRun, augmentedBaselineLock);
      runtimePrompt =
        (await input.resolveRuntimePromptFromFinalSecuritySnapshot?.({
          workerRun: effectiveWorkerRun
        })) ?? input.prompt;

      await this.deps.workerRunRepo.insertIfNoActiveForPrincipal(input.principalRunId, effectiveWorkerRun);
      insertedWorkerRun = true;

      if (augmentedBaselineLock.hard_stop_refs.length > 0) {
        const reason = `active hard_stop refs: ${augmentedBaselineLock.hard_stop_refs.join(", ")}`;
        preDispatchFreezeIntent = {
          panicSource: "worker_baseline_hard_stop",
          summary: reason
        };
        preDispatchConflict = new CoreError(
          "CONFLICT",
          `Serial delegation blocked by worker baseline hard stop: ${reason}`
        );

        await this.deps.dirtyStatePanicService.triggerPanic({
          workerRunId: effectiveWorkerRun.worker_run_id,
          trigger: "safety_gate_failure",
          panicSource: preDispatchFreezeIntent.panicSource,
          summary: preDispatchFreezeIntent.summary,
          affectedScope: augmentedBaselineLock.hard_stop_refs.map((ref) => ({
            entity_type: "constraint_ref",
            entity_id: ref
          }))
        });

        throw preDispatchConflict;
      }

      integrationDecision = await this.deps.integrationGate.check(
        effectiveWorkerRun,
        runtimeAdapter.getCapabilities()
      );

      if (integrationDecision?.level === "hard_stale") {
        preDispatchFreezeIntent = {
          panicSource: "integration_gate",
          summary: integrationDecision.reason
        };
        preDispatchConflict = new CoreError(
          "CONFLICT",
          `Serial delegation blocked by integration gate: ${integrationDecision.reason}`
        );
        await this.deps.dirtyStatePanicService.triggerPanic({
          workerRunId: effectiveWorkerRun.worker_run_id,
          trigger: "state_inconsistency",
          panicSource: preDispatchFreezeIntent.panicSource,
          summary: preDispatchFreezeIntent.summary,
          affectedScope: [{ entity_type: "integration_decision", entity_id: integrationDecision.level }]
        });

        throw preDispatchConflict;
      }

      await this.protectCriticalConstraintRefs(effectiveWorkerRun);
    } catch (error) {
      if (error instanceof IntegrationGatePublicationError) {
        if (error.decision.level === "hard_stale") {
          preDispatchFreezeIntent ??= {
            panicSource: "integration_gate",
            summary: error.decision.reason
          };
          preDispatchConflict ??= new CoreError(
            "CONFLICT",
            `Serial delegation blocked by integration gate: ${error.decision.reason}`
          );
        } else if (error.durableDecisionCommitted) {
          preDispatchFreezeIntent ??= {
            panicSource: "integration_gate",
            summary: error.decision.reason
          };
        }
      }

      if (insertedWorkerRun) {
        await this.recovery.recoverPreDispatchFailure(
          effectiveWorkerRun.worker_run_id,
          error,
          preDispatchFreezeIntent,
          error instanceof IntegrationGatePublicationError && error.durableDecisionCommitted
        );
      }

      if (preDispatchConflict !== null) {
        throw preDispatchConflict;
      }

      if (error instanceof CoreError && error.code === "CONFLICT") {
        throw error;
      }

      if (isConflictError(error)) {
        throw new CoreError(
          "CONFLICT",
          `Serial delegation: principal ${input.principalRunId} already has an in-flight worker`,
          error instanceof Error ? { cause: error } : undefined
        );
      }

      throw error;
    }

    try {
      const activeRun = await this.deps.workerRunLifecycle.dispatch(effectiveWorkerRun.worker_run_id);
      const session = await runtimeAdapter.createSession(input.sessionConfig);
      sessionId = session.session_id;
      const context: NormalizerContext = {
        workspaceId: input.workspaceId,
        principalRunId: input.principalRunId,
        workerRunId: effectiveWorkerRun.worker_run_id
      };

      const runtimeUnsubscribe = runtimeAdapter.onEvent((event) => {
        if (!eventIntake.accepts(event, session.session_id)) {
          return;
        }

        eventIntake.note(event);

        eventIntake.enqueue(async () => {
          if (!eventIntake.isAcceptingEvents()) {
            return;
          }

          try {
            await this.recovery.handleRuntimeEvent(
              event,
              context,
              effectiveWorkerRun.worker_run_id,
              runtimeUnsubscribe,
              () => eventIntake.stop()
            );

            if (event.type === "session_finished") {
              eventIntake.clearPendingIfCurrent(event);
            }
          } catch (error) {
            await this.recovery.handleRuntimeEventFailure({
              error,
              event,
              context,
              workerRunId: effectiveWorkerRun.worker_run_id,
              sessionId: session.session_id,
              runtimeAdapter,
              unsubscribe: runtimeUnsubscribe,
              stopEventIntake: () => eventIntake.stop(),
              resumeEventIntake: () => eventIntake.resume(),
              awaitPendingSessionFinishedEvent: () => eventIntake.awaitPendingSessionFinishedEvent(),
              clearPendingSessionFinishedEvent: (sessionFinishedEvent) => {
                eventIntake.clearPendingIfCurrent(sessionFinishedEvent);
              }
            });

            if (isObligationViolationError(error)) {
              throw error;
            }
          }
        });
      });
      unsubscribe = runtimeUnsubscribe;

      await runtimeAdapter.prompt(session.session_id, { prompt: runtimePrompt });
      await eventIntake.drain();

      return activeRun;
    } catch (error) {
      if (isObligationViolationError(error)) {
        eventIntake.stop();
        unsubscribe?.();
        if (sessionId !== null) {
          this.deps.eventNormalizer.clearSessionState(sessionId);
        }
        throw error;
      }

      await this.recovery.handleStartupFailure({
        error,
        workerRunId: effectiveWorkerRun.worker_run_id,
        sessionId,
        runtimeAdapter,
        unsubscribe,
        stopEventIntake: () => eventIntake.stop(),
        resumeEventIntake: () => eventIntake.resume(),
        drainEventQueue: () => eventIntake.drain()
      });
      throw error;
    }
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

function applyAugmentedLockToWorkerRun(
  workerRun: Readonly<DelegatedWorkerRun>,
  lock: Readonly<WorkerBaselineLock>
): DelegatedWorkerRun {
  return DelegatedWorkerRunSchema.parse({
    ...workerRun,
    principal_security_snapshot: {
      ...workerRun.principal_security_snapshot,
      hard_constraint_refs: mergeUniqueStrings(
        workerRun.principal_security_snapshot.hard_constraint_refs,
        lock.hard_constraint_refs
      ),
      denied_tool_categories: mergeUniqueStrings(
        workerRun.principal_security_snapshot.denied_tool_categories,
        lock.denied_tool_categories
      )
    }
  });
}

function mergeUniqueStrings(
  existing: readonly string[],
  additions: readonly string[]
): readonly string[] {
  return [...new Set([...existing, ...additions])];
}

function requireWorkerBaselineLock(
  lock: WorkerBaselineLock | null | undefined,
  lockName: string
): WorkerBaselineLock {
  if (lock == null) {
    throw new CoreError("VALIDATION", `Serial delegation requires a non-null ${lockName}.`);
  }

  return lock;
}

function isConflictError(error: unknown): error is Error & { readonly code: "CONFLICT" } {
  return (
    (error instanceof Error &&
      error.name === "StorageError" &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "CONFLICT")
  );
}

function isObligationViolationError(error: unknown): error is CoreError {
  return error instanceof CoreError && error.code === "OBLIGATION_VIOLATION";
}
