import type { AgentRuntimePort, DelegatedWorkerRun, RuntimeEvent } from "@do-soul/alaya-protocol";
import type { ConstraintProxy } from "../security/constraint-proxy.js";
import type { NormalizerContext, RuntimeEventNormalizer } from "./runtime-event-normalizer.js";
import type { StrongRefService } from "../memory/strong-ref-service.js";
import type { WorkerRunLifecycleService } from "./worker-run-lifecycle-service.js";

import { serialDelegationRecoveryRecoverPreDispatchFailure, serialDelegationRecoveryHandleRuntimeEvent, serialDelegationRecoveryHandleStartupFailure, serialDelegationRecoveryHandleRuntimeEventFailure } from "./serial-delegation-recovery-methods-1.js";
import { serialDelegationRecoveryRecoverTerminalEvent, serialDelegationRecoverySettleRuntimeEventRecovery, serialDelegationRecoverySuspendBlockedCompletionAfterObligationViolation, serialDelegationRecoveryFreezeWorkerRun, serialDelegationRecoveryRollbackInsertedPreDispatchWorkerRun, serialDelegationRecoveryAbortWorkerRun, serialDelegationRecoveryReadTerminalWorkerState, serialDelegationRecoveryReportUnknownTerminalWorkerState, serialDelegationRecoveryIsTerminalWorkerRun, serialDelegationRecoveryCancelRuntime, serialDelegationRecoveryClearNormalizerSession, serialDelegationRecoverySafeReportAsyncFailure, serialDelegationRecoveryReleaseWorkerConstraintStrongRefs } from "./serial-delegation-recovery-methods-2.js";

export { summarizeError, toErrorOptions } from "./serial-delegation-recovery-errors.js";

type SessionFinishedEvent = Extract<RuntimeEvent, { readonly type: "session_finished" }>;

interface RecoveryWorkerRunRepoPort {
  getById(workerRunId: string): Promise<Readonly<DelegatedWorkerRun> | null>;
  deleteIfState(workerRunId: string, expectedState: DelegatedWorkerRun["state"]): Promise<void>;
}

type RuntimeEventNormalizerPort = Pick<RuntimeEventNormalizer, "normalize" | "clearSessionState">;

type ConstraintProxyPort = Pick<ConstraintProxy, "assertNoViolation">;

type StrongRefServicePort = Pick<StrongRefService, "releaseBySource">;

export interface RecoveryMetadata {
  readonly phase: "startup" | "event";
  readonly workerRunId: string;
  readonly sessionId: string | null;
  readonly eventType?: RuntimeEvent["type"];
}

interface RecoveryResult {
  readonly succeeded: boolean;
  readonly error?: unknown;
}

export interface PreDispatchFreezeIntent {
  readonly panicSource: string;
  readonly summary: string;
}

export interface SerialDelegationRecoveryDependencies {
  readonly workerRunLifecycle: WorkerRunLifecycleService;
  readonly workerRunRepo: RecoveryWorkerRunRepoPort;
  readonly eventNormalizer: RuntimeEventNormalizerPort;
  readonly constraintProxy: ConstraintProxyPort;
  readonly strongRefService?: StrongRefServicePort;
  readonly reportAsyncFailure?: (
    error: unknown,
    metadata: RecoveryMetadata
  ) => void | Promise<void>;
}

export class SerialDelegationRecovery {
public constructor(public readonly deps: SerialDelegationRecoveryDependencies) {}

  public async recoverPreDispatchFailure(workerRunId: string, error: unknown, freezeIntent: PreDispatchFreezeIntent | null, durableDecisionCommitted: boolean): Promise<void> {
    return serialDelegationRecoveryRecoverPreDispatchFailure(this, workerRunId, error, freezeIntent, durableDecisionCommitted);
  }

  public async handleRuntimeEvent(event: RuntimeEvent, context: NormalizerContext, workerRunId: string, unsubscribe: () => void, stopEventIntake: () => void): Promise<void> {
    return serialDelegationRecoveryHandleRuntimeEvent(this, event, context, workerRunId, unsubscribe, stopEventIntake);
  }

  public async handleStartupFailure(params: {
    readonly error: unknown;
    readonly workerRunId: string;
    readonly sessionId: string | null;
    readonly runtimeAdapter: AgentRuntimePort;
    readonly unsubscribe: (() => void) | null;
    readonly stopEventIntake: () => void;
    readonly resumeEventIntake: () => void;
    readonly drainEventQueue: () => Promise<void>;
  }): Promise<void> {
    return serialDelegationRecoveryHandleStartupFailure(this, params);
  }

  public async handleRuntimeEventFailure(params: {
    readonly error: unknown;
    readonly event: RuntimeEvent;
    readonly context: NormalizerContext;
    readonly workerRunId: string;
    readonly sessionId: string;
    readonly runtimeAdapter: AgentRuntimePort;
    readonly unsubscribe: () => void;
    readonly stopEventIntake: () => void;
    readonly resumeEventIntake: () => void;
    readonly awaitPendingSessionFinishedEvent: () => Promise<SessionFinishedEvent | null>;
    readonly clearPendingSessionFinishedEvent: (event: SessionFinishedEvent) => void;
  }): Promise<void> {
    return serialDelegationRecoveryHandleRuntimeEventFailure(this, params);
  }

  private async recoverTerminalEvent(params: {
      readonly terminalEvent: SessionFinishedEvent;
      readonly failureEventType: RuntimeEvent["type"];
      readonly originalError: unknown;
      readonly context: NormalizerContext;
      readonly workerRunId: string;
      readonly sessionId: string;
      readonly unsubscribe: () => void;
      readonly stopEventIntake: () => void;
      readonly clearPendingSessionFinishedEvent: (event: SessionFinishedEvent) => void;
    }, metadata: RecoveryMetadata): Promise<void> {
    return serialDelegationRecoveryRecoverTerminalEvent(this, params, metadata);
  }

  private async settleRuntimeEventRecovery(workerRunId: string, panicSource: string, summary: string, metadata: RecoveryMetadata): Promise<void> {
    return serialDelegationRecoverySettleRuntimeEventRecovery(this, workerRunId, panicSource, summary, metadata);
  }

  private async suspendBlockedCompletionAfterObligationViolation(workerRunId: string, originalError: unknown, metadata: RecoveryMetadata): Promise<void> {
    return serialDelegationRecoverySuspendBlockedCompletionAfterObligationViolation(this, workerRunId, originalError, metadata);
  }

  private async freezeWorkerRun(workerRunId: string, panicSource: string, summary: string, metadata: RecoveryMetadata): Promise<RecoveryResult> {
    return serialDelegationRecoveryFreezeWorkerRun(this, workerRunId, panicSource, summary, metadata);
  }

  private async rollbackInsertedPreDispatchWorkerRun(workerRunId: string, metadata: RecoveryMetadata): Promise<RecoveryResult> {
    return serialDelegationRecoveryRollbackInsertedPreDispatchWorkerRun(this, workerRunId, metadata);
  }

  private async abortWorkerRun(workerRunId: string, reason: string, metadata: RecoveryMetadata): Promise<RecoveryResult> {
    return serialDelegationRecoveryAbortWorkerRun(this, workerRunId, reason, metadata);
  }

  private async readTerminalWorkerState(workerRunId: string, metadata: RecoveryMetadata): Promise<boolean | null> {
    return serialDelegationRecoveryReadTerminalWorkerState(this, workerRunId, metadata);
  }

  private async reportUnknownTerminalWorkerState(workerRunId: string, phase: string, metadata: RecoveryMetadata): Promise<void> {
    return serialDelegationRecoveryReportUnknownTerminalWorkerState(this, workerRunId, phase, metadata);
  }

  private async isTerminalWorkerRun(workerRunId: string): Promise<boolean> {
    return serialDelegationRecoveryIsTerminalWorkerRun(this, workerRunId);
  }

  private async cancelRuntime(runtimeAdapter: AgentRuntimePort, metadata: RecoveryMetadata): Promise<RecoveryResult> {
    return serialDelegationRecoveryCancelRuntime(this, runtimeAdapter, metadata);
  }

  private clearNormalizerSession(sessionId: string | null): void {
    return serialDelegationRecoveryClearNormalizerSession(this, sessionId);
  }

  private async safeReportAsyncFailure(error: unknown, metadata: RecoveryMetadata): Promise<void> {
    return serialDelegationRecoverySafeReportAsyncFailure(this, error, metadata);
  }

  private async releaseWorkerConstraintStrongRefs(workerRunId: string, metadata: RecoveryMetadata): Promise<void> {
    return serialDelegationRecoveryReleaseWorkerConstraintStrongRefs(this, workerRunId, metadata);
  }
}
