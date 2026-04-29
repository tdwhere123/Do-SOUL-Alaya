import type { AgentRuntimePort, DelegatedWorkerRun, RuntimeEvent } from "@do-soul/alaya-protocol";
import type { ConstraintProxy } from "./constraint-proxy.js";
import { CoreError } from "./errors.js";
import type { NormalizerContext, RuntimeEventNormalizer } from "./runtime-event-normalizer.js";
import type { StrongRefService } from "./strong-ref-service.js";
import type { WorkerRunLifecycleService } from "./worker-run-lifecycle-service.js";

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
  public constructor(private readonly deps: SerialDelegationRecoveryDependencies) {}

  public async recoverPreDispatchFailure(
    workerRunId: string,
    error: unknown,
    freezeIntent: PreDispatchFreezeIntent | null,
    durableDecisionCommitted: boolean
  ): Promise<void> {
    const metadata: RecoveryMetadata = {
      phase: "startup",
      workerRunId,
      sessionId: null
    };
    const shouldReportOriginalError = !(error instanceof CoreError && error.code === "CONFLICT");
    const terminalStateBeforeFreeze = await this.readTerminalWorkerState(workerRunId, metadata);

    if (terminalStateBeforeFreeze === true) {
      if (shouldReportOriginalError) {
        await this.safeReportAsyncFailure(error, metadata);
      }
      return;
    }

    if (terminalStateBeforeFreeze === null) {
      await this.reportUnknownTerminalWorkerState(workerRunId, "pre-runtime recovery", metadata);
    }

    const freezeResult = await this.freezeWorkerRun(
      workerRunId,
      freezeIntent?.panicSource ?? "serial_delegation_preflight",
      freezeIntent?.summary ?? summarizeError(error, "pre-dispatch guard failure"),
      metadata
    );

    if (freezeResult.succeeded) {
      if (shouldReportOriginalError) {
        await this.safeReportAsyncFailure(error, metadata);
      }
      return;
    }

    await this.releaseWorkerConstraintStrongRefs(workerRunId, metadata);

    const terminalStateAfterFreeze = await this.readTerminalWorkerState(workerRunId, metadata);

    if (terminalStateAfterFreeze === true) {
      if (shouldReportOriginalError) {
        await this.safeReportAsyncFailure(error, metadata);
      }
      return;
    }

    if (terminalStateAfterFreeze === null) {
      await this.reportUnknownTerminalWorkerState(
        workerRunId,
        "pre-runtime recovery after freeze failure",
        metadata
      );
    }

    if (freezeIntent === null && !durableDecisionCommitted) {
      const rollbackResult = await this.rollbackInsertedPreDispatchWorkerRun(workerRunId, metadata);

      if (rollbackResult.succeeded) {
        if (shouldReportOriginalError) {
          await this.safeReportAsyncFailure(error, metadata);
        }
        return;
      }

      if (shouldReportOriginalError) {
        await this.safeReportAsyncFailure(error, metadata);
      }

      throw new CoreError(
        "VALIDATION",
        `Serial delegation pre-runtime recovery could not roll back worker ${workerRunId} after integration gate failure. Worker may remain in-flight.`,
        toErrorOptions(rollbackResult.error ?? freezeResult.error)
      );
    }

    if (shouldReportOriginalError) {
      await this.safeReportAsyncFailure(error, metadata);
    }

    throw new CoreError(
      "VALIDATION",
      `Serial delegation pre-runtime recovery could not settle worker ${workerRunId} after startup guard failure. Worker remains in-flight.`,
      toErrorOptions(freezeResult.error)
    );
  }

  public async handleRuntimeEvent(
    event: RuntimeEvent,
    context: NormalizerContext,
    workerRunId: string,
    unsubscribe: () => void,
    stopEventIntake: () => void
  ): Promise<void> {
    if (event.type === "session_finished") {
      stopEventIntake();

      if (await this.isTerminalWorkerRun(workerRunId)) {
        unsubscribe();
        return;
      }
    }

    await this.deps.eventNormalizer.normalize(event, context);

    if (event.type !== "session_finished") {
      return;
    }

    if (event.status === "completed") {
      try {
        await this.deps.constraintProxy.assertNoViolation(
          context.workspaceId,
          context.principalRunId,
          "worker_complete"
        );
      } catch (error) {
        if (isObligationViolationError(error)) {
          await this.releaseWorkerConstraintStrongRefs(workerRunId, {
            phase: "event",
            workerRunId,
            sessionId: event.session_id,
            eventType: event.type
          });
        }
        throw error;
      }

      await this.deps.workerRunLifecycle.complete(workerRunId, []);
      await this.releaseWorkerConstraintStrongRefs(workerRunId, {
        phase: "event",
        workerRunId,
        sessionId: event.session_id,
        eventType: event.type
      });
      unsubscribe();
      return;
    }

    await this.deps.workerRunLifecycle.abort(workerRunId, {
      reason: event.result_summary ?? event.status,
      rollbackAttempted: false
    });
    await this.releaseWorkerConstraintStrongRefs(workerRunId, {
      phase: "event",
      workerRunId,
      sessionId: event.session_id,
      eventType: event.type
    });
    unsubscribe();
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
    const metadata: RecoveryMetadata = {
      phase: "startup",
      workerRunId: params.workerRunId,
      sessionId: params.sessionId
    };
    params.stopEventIntake();

    const cancelResult = await this.cancelRuntime(params.runtimeAdapter, metadata);
    if (!cancelResult.succeeded) {
      await params.drainEventQueue();

      const terminalStateAfterCancelFailure = await this.readTerminalWorkerState(
        params.workerRunId,
        metadata
      );

      if (terminalStateAfterCancelFailure === true) {
        params.unsubscribe?.();
        this.clearNormalizerSession(params.sessionId);
        await this.safeReportAsyncFailure(params.error, metadata);
        return;
      }

      if (terminalStateAfterCancelFailure === null) {
        params.resumeEventIntake();
        await this.reportUnknownTerminalWorkerState(
          params.workerRunId,
          "startup recovery after cancel failure",
          metadata
        );
        await this.safeReportAsyncFailure(params.error, metadata);
        throw new CoreError(
          "VALIDATION",
          `Serial delegation startup recovery could not verify worker ${params.workerRunId} terminal state after cancel failed. Worker may remain in-flight.`
        );
      }

      params.resumeEventIntake();
      await this.safeReportAsyncFailure(params.error, metadata);
      throw new CoreError(
        "VALIDATION",
        "Serial delegation startup recovery could not cancel the runtime session. Worker remains in-flight.",
        toErrorOptions(cancelResult.error)
      );
    }

    params.unsubscribe?.();
    await params.drainEventQueue();
    this.clearNormalizerSession(params.sessionId);

    const terminalStateBeforeFreeze = await this.readTerminalWorkerState(params.workerRunId, metadata);

    if (terminalStateBeforeFreeze === true) {
      await this.safeReportAsyncFailure(params.error, metadata);
      return;
    }

    if (terminalStateBeforeFreeze === null) {
      await this.reportUnknownTerminalWorkerState(
        params.workerRunId,
        "startup recovery",
        metadata
      );
    }

    const freezeResult = await this.freezeWorkerRun(
      params.workerRunId,
      "serial_delegation_startup",
      summarizeError(params.error, "runtime startup failure"),
      metadata
    );
    await this.safeReportAsyncFailure(params.error, metadata);

    if (freezeResult.succeeded) {
      return;
    }

    const terminalStateAfterFreeze = await this.readTerminalWorkerState(params.workerRunId, metadata);

    if (terminalStateAfterFreeze === true) {
      return;
    }

    if (terminalStateAfterFreeze === null) {
      await this.reportUnknownTerminalWorkerState(
        params.workerRunId,
        "startup recovery after freeze failure",
        metadata
      );
    }

    const abortResult = await this.abortWorkerRun(
      params.workerRunId,
      `serial_delegation_startup recovery fallback after freeze failure: ${summarizeError(
        freezeResult.error,
        "freeze transition failed"
      )}`,
      metadata
    );

    if (abortResult.succeeded) {
      return;
    }

    const terminalStateAfterAbort = await this.readTerminalWorkerState(params.workerRunId, metadata);

    if (terminalStateAfterAbort === true) {
      return;
    }

    if (terminalStateAfterAbort === null) {
      await this.reportUnknownTerminalWorkerState(
        params.workerRunId,
        "startup recovery after abort failure",
        metadata
      );
      throw new CoreError(
        "VALIDATION",
        `Serial delegation startup recovery could not verify worker ${params.workerRunId} terminal state after abort failed. Worker may remain in-flight.`,
        toErrorOptions(abortResult.error ?? freezeResult.error)
      );
    }

    throw new CoreError(
      "VALIDATION",
      `Serial delegation startup recovery could not settle worker ${params.workerRunId} after freeze failure. Worker remains in-flight.`,
      toErrorOptions(abortResult.error ?? freezeResult.error)
    );
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
    const metadata: RecoveryMetadata = {
      phase: "event",
      workerRunId: params.workerRunId,
      sessionId: params.sessionId,
      eventType: params.event.type
    };

    if (isObligationViolationError(params.error)) {
      params.stopEventIntake();
      params.unsubscribe();
      if (params.event.type === "session_finished") {
        if (params.event.status === "completed") {
          await this.suspendBlockedCompletionAfterObligationViolation(
            params.workerRunId,
            params.error,
            metadata
          );
        }
        params.clearPendingSessionFinishedEvent(params.event);
      }
      this.clearNormalizerSession(params.sessionId);
      await this.safeReportAsyncFailure(params.error, metadata);
      return;
    }

    const cancelResult = await this.cancelRuntime(params.runtimeAdapter, metadata);

    if (!cancelResult.succeeded) {
      if (params.event.type === "session_finished") {
        await this.recoverTerminalEvent(
          {
            terminalEvent: params.event,
            failureEventType: params.event.type,
            originalError: params.error,
            context: params.context,
            workerRunId: params.workerRunId,
            sessionId: params.sessionId,
            unsubscribe: params.unsubscribe,
            stopEventIntake: params.stopEventIntake,
            clearPendingSessionFinishedEvent: params.clearPendingSessionFinishedEvent
          },
          metadata
        );
        return;
      }

      params.resumeEventIntake();
      await this.safeReportAsyncFailure(params.error, metadata);
      await this.safeReportAsyncFailure(
        new CoreError(
          "VALIDATION",
          "Serial delegation event recovery could not cancel the runtime session. Worker remains in-flight.",
          toErrorOptions(cancelResult.error)
        ),
        metadata
      );
      return;
    }

    const terminalRecoveryEvent =
      params.event.type === "session_finished"
        ? params.event
        : await params.awaitPendingSessionFinishedEvent();

    if (terminalRecoveryEvent !== null) {
      await this.recoverTerminalEvent(
        {
          terminalEvent: terminalRecoveryEvent,
          failureEventType: params.event.type,
          originalError: params.error,
          context: params.context,
          workerRunId: params.workerRunId,
          sessionId: params.sessionId,
          unsubscribe: params.unsubscribe,
          stopEventIntake: params.stopEventIntake,
          clearPendingSessionFinishedEvent: params.clearPendingSessionFinishedEvent
        },
        metadata
      );
      return;
    }

    params.stopEventIntake();
    params.unsubscribe();
    this.clearNormalizerSession(params.sessionId);
    await this.settleRuntimeEventRecovery(
      params.workerRunId,
      "runtime_event_handler",
      `${params.event.type}: ${summarizeError(params.error, "event handling failure")}`,
      metadata
    );
    await this.safeReportAsyncFailure(params.error, metadata);
  }

  private async recoverTerminalEvent(
    params: {
      readonly terminalEvent: SessionFinishedEvent;
      readonly failureEventType: RuntimeEvent["type"];
      readonly originalError: unknown;
      readonly context: NormalizerContext;
      readonly workerRunId: string;
      readonly sessionId: string;
      readonly unsubscribe: () => void;
      readonly stopEventIntake: () => void;
      readonly clearPendingSessionFinishedEvent: (event: SessionFinishedEvent) => void;
    },
    metadata: RecoveryMetadata
  ): Promise<void> {
    try {
      await this.handleRuntimeEvent(
        params.terminalEvent,
        params.context,
        params.workerRunId,
        params.unsubscribe,
        params.stopEventIntake
      );
      this.clearNormalizerSession(params.sessionId);
      await this.safeReportAsyncFailure(params.originalError, metadata);
      if (isObligationViolationError(params.originalError)) {
        throw params.originalError;
      }
      return;
    } catch (terminalRecoveryError) {
      params.clearPendingSessionFinishedEvent(params.terminalEvent);
      this.clearNormalizerSession(params.sessionId);
      if (isObligationViolationError(terminalRecoveryError)) {
        await this.safeReportAsyncFailure(params.originalError, metadata);
        throw terminalRecoveryError;
      }
      await this.settleRuntimeEventRecovery(
        params.workerRunId,
        "runtime_event_handler",
        summarizeTerminalRecoveryFailure(
          params.failureEventType,
          params.terminalEvent,
          terminalRecoveryError
        ),
        metadata
      );
      await this.safeReportAsyncFailure(params.originalError, metadata);
      await this.safeReportAsyncFailure(terminalRecoveryError, {
        ...metadata,
        eventType: "session_finished"
      });
    } finally {
      params.unsubscribe();
      params.clearPendingSessionFinishedEvent(params.terminalEvent);
    }
  }

  private async settleRuntimeEventRecovery(
    workerRunId: string,
    panicSource: string,
    summary: string,
    metadata: RecoveryMetadata
  ): Promise<void> {
    const terminalStateBeforeFreeze = await this.readTerminalWorkerState(workerRunId, metadata);

    if (terminalStateBeforeFreeze === true) {
      return;
    }

    if (terminalStateBeforeFreeze === null) {
      await this.reportUnknownTerminalWorkerState(workerRunId, "event recovery", metadata);
    }

    const freezeResult = await this.freezeWorkerRun(workerRunId, panicSource, summary, metadata);

    if (freezeResult.succeeded) {
      return;
    }

    const terminalStateAfterFreeze = await this.readTerminalWorkerState(workerRunId, metadata);

    if (terminalStateAfterFreeze === true) {
      return;
    }

    if (terminalStateAfterFreeze === null) {
      await this.reportUnknownTerminalWorkerState(
        workerRunId,
        "event recovery after freeze failure",
        metadata
      );
    }

    const abortResult = await this.abortWorkerRun(
      workerRunId,
      `runtime_event_handler recovery fallback after freeze failure: ${summarizeError(
        freezeResult.error,
        "freeze transition failed"
      )}`,
      metadata
    );

    if (abortResult.succeeded) {
      return;
    }

    const terminalStateAfterAbort = await this.readTerminalWorkerState(workerRunId, metadata);

    if (terminalStateAfterAbort === true) {
      return;
    }

    if (terminalStateAfterAbort === null) {
      await this.reportUnknownTerminalWorkerState(
        workerRunId,
        "event recovery after abort failure",
        metadata
      );
      await this.safeReportAsyncFailure(
        new CoreError(
          "VALIDATION",
          `Serial delegation event recovery could not verify worker ${workerRunId} terminal state after abort failed. Worker may remain in-flight.`,
          toErrorOptions(abortResult.error ?? freezeResult.error)
        ),
        metadata
      );
      return;
    }

    await this.safeReportAsyncFailure(
      new CoreError(
        "VALIDATION",
        `Serial delegation event recovery could not settle worker ${workerRunId} after freeze failure. Worker remains in-flight.`,
        toErrorOptions(abortResult.error ?? freezeResult.error)
      ),
      metadata
    );
  }

  private async suspendBlockedCompletionAfterObligationViolation(
    workerRunId: string,
    originalError: unknown,
    metadata: RecoveryMetadata
  ): Promise<void> {
    const terminalStateBeforeSuspend = await this.readTerminalWorkerState(workerRunId, metadata);
    if (terminalStateBeforeSuspend === true) {
      return;
    }

    if (terminalStateBeforeSuspend === null) {
      await this.reportUnknownTerminalWorkerState(
        workerRunId,
        "obligation violation completion recovery",
        metadata
      );
    }

    let suspendError: unknown = null;
    try {
      await this.deps.workerRunLifecycle.suspend(workerRunId, "obligation_violation");
      await this.releaseWorkerConstraintStrongRefs(workerRunId, metadata);
      return;
    } catch (error) {
      suspendError = error;
      await this.safeReportAsyncFailure(suspendError, metadata);
    }

    const terminalStateAfterSuspendFailure = await this.readTerminalWorkerState(workerRunId, metadata);
    if (terminalStateAfterSuspendFailure === true) {
      return;
    }

    if (terminalStateAfterSuspendFailure === null) {
      await this.reportUnknownTerminalWorkerState(
        workerRunId,
        "obligation violation completion recovery after suspend failure",
        metadata
      );
    }

    await this.safeReportAsyncFailure(
      new CoreError(
        "VALIDATION",
        `Serial delegation completion recovery could not suspend worker ${workerRunId} after deferred-obligation violation. Worker may remain in-flight.`,
        toErrorOptions(suspendError ?? originalError)
      ),
      metadata
    );
  }

  private async freezeWorkerRun(
    workerRunId: string,
    panicSource: string,
    summary: string,
    metadata: RecoveryMetadata
  ): Promise<RecoveryResult> {
    try {
      await this.deps.workerRunLifecycle.freeze(workerRunId, panicSource, summary);
      await this.releaseWorkerConstraintStrongRefs(workerRunId, metadata);
      return { succeeded: true };
    } catch (freezeError) {
      await this.safeReportAsyncFailure(freezeError, metadata);
      return { succeeded: false, error: freezeError };
    }
  }

  private async rollbackInsertedPreDispatchWorkerRun(
    workerRunId: string,
    metadata: RecoveryMetadata
  ): Promise<RecoveryResult> {
    try {
      const workerRun = await this.deps.workerRunRepo.getById(workerRunId);

      if (workerRun === null || isTerminalWorkerState(workerRun.state)) {
        return { succeeded: true };
      }

      if (workerRun.state !== "init") {
        throw new CoreError(
          "VALIDATION",
          `Serial delegation pre-runtime rollback expected worker ${workerRunId} in init, found ${workerRun.state}.`
        );
      }

      await this.deps.workerRunRepo.deleteIfState(workerRunId, "init");
      return { succeeded: true };
    } catch (rollbackError) {
      await this.safeReportAsyncFailure(rollbackError, metadata);
      return { succeeded: false, error: rollbackError };
    }
  }

  private async abortWorkerRun(
    workerRunId: string,
    reason: string,
    metadata: RecoveryMetadata
  ): Promise<RecoveryResult> {
    try {
      await this.deps.workerRunLifecycle.abort(workerRunId, {
        reason,
        rollbackAttempted: false
      });
      await this.releaseWorkerConstraintStrongRefs(workerRunId, metadata);
      return { succeeded: true };
    } catch (abortError) {
      await this.safeReportAsyncFailure(abortError, metadata);
      return { succeeded: false, error: abortError };
    }
  }

  private async readTerminalWorkerState(
    workerRunId: string,
    metadata: RecoveryMetadata
  ): Promise<boolean | null> {
    try {
      const workerRun = await this.deps.workerRunRepo.getById(workerRunId);
      return workerRun !== null && isTerminalWorkerState(workerRun.state);
    } catch (lookupError) {
      await this.safeReportAsyncFailure(lookupError, metadata);
      return null;
    }
  }

  private async reportUnknownTerminalWorkerState(
    workerRunId: string,
    phase: string,
    metadata: RecoveryMetadata
  ): Promise<void> {
    await this.safeReportAsyncFailure(
      new CoreError(
        "VALIDATION",
        `Serial delegation ${phase} could not verify worker ${workerRunId} terminal state before a recovery transition. Worker may remain in-flight.`
      ),
      metadata
    );
  }

  private async isTerminalWorkerRun(workerRunId: string): Promise<boolean> {
    const workerRun = await this.deps.workerRunRepo.getById(workerRunId);
    return workerRun !== null && isTerminalWorkerState(workerRun.state);
  }

  private async cancelRuntime(
    runtimeAdapter: AgentRuntimePort,
    metadata: RecoveryMetadata
  ): Promise<RecoveryResult> {
    if (metadata.sessionId === null) {
      return { succeeded: true };
    }

    try {
      await runtimeAdapter.cancel(metadata.sessionId);
      return { succeeded: true };
    } catch (cancelError) {
      await this.safeReportAsyncFailure(cancelError, metadata);
      return { succeeded: false, error: cancelError };
    }
  }

  private clearNormalizerSession(sessionId: string | null): void {
    if (sessionId === null) {
      return;
    }

    this.deps.eventNormalizer.clearSessionState(sessionId);
  }

  private async safeReportAsyncFailure(error: unknown, metadata: RecoveryMetadata): Promise<void> {
    try {
      await this.deps.reportAsyncFailure?.(error, metadata);
    } catch {
      // Reporter failures must never block fail-closed recovery.
    }
  }

  private async releaseWorkerConstraintStrongRefs(
    workerRunId: string,
    metadata: RecoveryMetadata
  ): Promise<void> {
    if (this.deps.strongRefService === undefined) {
      return;
    }

    try {
      await this.deps.strongRefService.releaseBySource({
        sourceEntityType: "worker_run",
        sourceEntityId: workerRunId
      });
    } catch (error) {
      await this.safeReportAsyncFailure(error, metadata);
    }
  }
}

export function summarizeError(error: unknown, fallback = "worker runtime failure"): string {
  if (error instanceof CoreError) {
    switch (error.code) {
      case "CONFLICT":
        return "request conflict";
      case "NOT_FOUND":
        return "resource not found";
      case "VALIDATION":
      default:
        return "invalid request";
    }
  }

  return fallback;
}

export function toErrorOptions(cause: unknown): ErrorOptions | undefined {
  return cause instanceof Error ? { cause } : undefined;
}

function summarizeTerminalRecoveryFailure(
  originalEventType: RuntimeEvent["type"],
  terminalEvent: SessionFinishedEvent,
  error: unknown
): string {
  if (terminalEvent.type === originalEventType) {
    return `${originalEventType}: ${summarizeError(error, "terminal recovery failure")}`;
  }

  return `session_finished after ${originalEventType}: ${summarizeError(
    error,
    "terminal recovery failure"
  )}`;
}

function isTerminalWorkerState(state: DelegatedWorkerRun["state"]): boolean {
  return state === "completed" || state === "aborted" || state === "frozen";
}

function isObligationViolationError(error: unknown): error is CoreError {
  return error instanceof CoreError && error.code === "OBLIGATION_VIOLATION";
}
