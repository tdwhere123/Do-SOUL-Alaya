import type { RuntimeEvent } from "@do-soul/alaya-protocol";

import { CoreError } from "../shared/errors.js";

import {
  isObligationViolationError,
  summarizeError,
  summarizeTerminalRecoveryFailure,
  toErrorOptions
} from "./serial-delegation-recovery-errors.js";

import type { NormalizerContext } from "./runtime-event-normalizer.js";

import type {
  RecoveryMetadata,
  RecoveryPrimitivesPort,
  RecoveryResult,
  RuntimeEventFailureParams,
  SessionFinishedEvent,
  TerminalEventRecoveryParams
} from "./serial-delegation-recovery-ports.js";

// Runtime-event and terminal-event recovery: normalize/complete/abort on
// session_finished, plus the freeze-then-abort escalation when a failed event
// cannot settle the worker.
export class SerialDelegationEventRecovery {
  public constructor(private readonly primitives: RecoveryPrimitivesPort) {}

  private get deps(): RecoveryPrimitivesPort["deps"] {
    return this.primitives.deps;
  }

  public async handleRuntimeEvent(
    event: RuntimeEvent,
    context: NormalizerContext,
    workerRunId: string,
    unsubscribe: () => void,
    stopEventIntake: () => void
  ): Promise<void> {
    if (await this.shouldSkipFinishedSessionEvent(event, workerRunId, unsubscribe, stopEventIntake)) {
      return;
    }

    await this.deps.eventNormalizer.normalize(event, context);

    if (event.type !== "session_finished") {
      return;
    }

    if (event.status === "completed") {
      await this.completeWorkerRunAfterSessionFinished(context, workerRunId, event);
      unsubscribe();
      return;
    }

    await this.abortWorkerRunAfterSessionFinished(workerRunId, event);
    unsubscribe();
  }

  public async handleRuntimeEventFailure(params: RuntimeEventFailureParams): Promise<void> {
    const metadata: RecoveryMetadata = {
      phase: "event",
      workerRunId: params.workerRunId,
      sessionId: params.sessionId,
      eventType: params.event.type
    };

    if (isObligationViolationError(params.error)) {
      await this.handleObligationViolationDuringEventRecovery(params, metadata);
      return;
    }

    const cancelResult = await this.primitives.cancelRuntime(params.runtimeAdapter, metadata);

    if (!cancelResult.succeeded) {
      await this.recoverAfterCancelFailure(params, metadata, cancelResult);
      return;
    }

    const terminalRecoveryEvent =
      params.event.type === "session_finished"
        ? params.event
        : await params.awaitPendingSessionFinishedEvent();

    if (terminalRecoveryEvent !== null) {
      await this.recoverTerminalEvent(buildTerminalRecoveryParams(params, terminalRecoveryEvent), metadata);
      return;
    }

    await this.settleUnhandledRuntimeEventFailure(params, metadata);
  }

  private async recoverTerminalEvent(
    params: TerminalEventRecoveryParams,
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
      await this.handleSuccessfulTerminalRecovery(params.originalError, params.sessionId, metadata);
    } catch (terminalRecoveryError) {
      await this.handleFailedTerminalRecovery(params, metadata, terminalRecoveryError);
    } finally {
      this.deps.eventNormalizer.clearSessionState(params.sessionId);
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
    const terminalStateBeforeFreeze = await this.primitives.readTerminalWorkerState(workerRunId, metadata);
    if (await this.stopIfWorkerAlreadySettled(workerRunId, terminalStateBeforeFreeze, "event recovery", metadata)) {
      return;
    }

    const freezeResult = await this.primitives.freezeWorkerRun(workerRunId, panicSource, summary, metadata);

    if (freezeResult.succeeded) {
      return;
    }

    const terminalStateAfterFreeze = await this.primitives.readTerminalWorkerState(workerRunId, metadata);
    if (
      await this.stopIfWorkerAlreadySettled(
        workerRunId,
        terminalStateAfterFreeze,
        "event recovery after freeze failure",
        metadata
      )
    ) {
      return;
    }

    const abortResult = await this.primitives.abortWorkerRun(
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
    await this.reportAbortRecoveryFailure(workerRunId, metadata, freezeResult, abortResult);
  }

  private async suspendBlockedCompletionAfterObligationViolation(
    workerRunId: string,
    originalError: unknown,
    metadata: RecoveryMetadata
  ): Promise<void> {
    const terminalStateBeforeSuspend = await this.primitives.readTerminalWorkerState(workerRunId, metadata);
    if (terminalStateBeforeSuspend === true) {
      return;
    }

    if (terminalStateBeforeSuspend === null) {
      await this.primitives.reportUnknownTerminalWorkerState(
        workerRunId,
        "obligation violation completion recovery",
        metadata
      );
    }

    let suspendError: unknown = null;
    try {
      await this.deps.workerRunLifecycle.suspend(workerRunId, "obligation_violation");
      await this.primitives.releaseWorkerConstraintStrongRefs(workerRunId, metadata);
      return;
    } catch (error) {
      suspendError = error;
      await this.primitives.safeReportAsyncFailure(suspendError, metadata);
    }

    const terminalStateAfterSuspendFailure = await this.primitives.readTerminalWorkerState(workerRunId, metadata);
    if (terminalStateAfterSuspendFailure === true) {
      return;
    }

    if (terminalStateAfterSuspendFailure === null) {
      await this.primitives.reportUnknownTerminalWorkerState(
        workerRunId,
        "obligation violation completion recovery after suspend failure",
        metadata
      );
    }

    await this.primitives.safeReportAsyncFailure(
      new CoreError(
        "VALIDATION",
        `Serial delegation completion recovery could not suspend worker ${workerRunId} after deferred-obligation violation. Worker may remain in-flight.`,
        toErrorOptions(suspendError ?? originalError)
      ),
      metadata
    );
  }

  private async shouldSkipFinishedSessionEvent(
    event: RuntimeEvent,
    workerRunId: string,
    unsubscribe: () => void,
    stopEventIntake: () => void
  ): Promise<boolean> {
    if (event.type !== "session_finished") {
      return false;
    }
    stopEventIntake();
    if (!(await this.primitives.isTerminalWorkerRun(workerRunId))) {
      return false;
    }
    unsubscribe();
    return true;
  }

  private async completeWorkerRunAfterSessionFinished(
    context: NormalizerContext,
    workerRunId: string,
    event: SessionFinishedEvent
  ): Promise<void> {
    const metadata = buildEventMetadata(workerRunId, event);
    try {
      await this.deps.constraintProxy.assertNoViolation(
        context.workspaceId,
        context.principalRunId,
        "worker_complete"
      );
    } catch (error) {
      if (isObligationViolationError(error)) {
        await this.primitives.releaseWorkerConstraintStrongRefs(workerRunId, metadata);
      }
      throw error;
    }
    await this.deps.workerRunLifecycle.complete(workerRunId, []);
    await this.primitives.releaseWorkerConstraintStrongRefs(workerRunId, metadata);
  }

  private async abortWorkerRunAfterSessionFinished(
    workerRunId: string,
    event: SessionFinishedEvent
  ): Promise<void> {
    await this.deps.workerRunLifecycle.abort(workerRunId, {
      reason: event.result_summary ?? event.status,
      rollbackAttempted: false
    });
    await this.primitives.releaseWorkerConstraintStrongRefs(
      workerRunId,
      buildEventMetadata(workerRunId, event)
    );
  }

  private async handleObligationViolationDuringEventRecovery(
    params: RuntimeEventFailureParams,
    metadata: RecoveryMetadata
  ): Promise<void> {
    params.stopEventIntake();
    params.unsubscribe();
    if (params.event.type === "session_finished") {
      if (params.event.status === "completed") {
        await this.suspendBlockedCompletionAfterObligationViolation(params.workerRunId, params.error, metadata);
      }
      params.clearPendingSessionFinishedEvent(params.event);
    }
    this.deps.eventNormalizer.clearSessionState(params.sessionId);
    await this.primitives.safeReportAsyncFailure(params.error, metadata);
  }

  private async recoverAfterCancelFailure(
    params: RuntimeEventFailureParams,
    metadata: RecoveryMetadata,
    cancelResult: RecoveryResult
  ): Promise<void> {
    if (params.event.type === "session_finished") {
      await this.recoverTerminalEvent(buildTerminalRecoveryParams(params, params.event), metadata);
      return;
    }

    const terminalEvent = await params.awaitPendingSessionFinishedEvent();
    if (terminalEvent !== null) {
      await this.handleRuntimeEvent(
        terminalEvent,
        params.context,
        params.workerRunId,
        params.unsubscribe,
        params.stopEventIntake
      );
      params.clearPendingSessionFinishedEvent(terminalEvent);
      await this.primitives.safeReportAsyncFailure(params.error, metadata);
      return;
    }

    params.resumeEventIntake();
    await this.primitives.safeReportAsyncFailure(params.error, metadata);
    await this.primitives.safeReportAsyncFailure(
      new CoreError(
        "VALIDATION",
        "Serial delegation event recovery could not cancel the runtime session. Worker remains in-flight.",
        toErrorOptions(cancelResult.error)
      ),
      metadata
    );
  }

  private async settleUnhandledRuntimeEventFailure(
    params: RuntimeEventFailureParams,
    metadata: RecoveryMetadata
  ): Promise<void> {
    params.stopEventIntake();
    params.unsubscribe();
    this.deps.eventNormalizer.clearSessionState(params.sessionId);
    await this.settleRuntimeEventRecovery(
      params.workerRunId,
      "runtime_event_handler",
      `${params.event.type}: ${summarizeError(params.error, "event handling failure")}`,
      metadata
    );
    await this.primitives.safeReportAsyncFailure(params.error, metadata);
  }

  private async handleSuccessfulTerminalRecovery(
    originalError: unknown,
    sessionId: string,
    metadata: RecoveryMetadata
  ): Promise<void> {
    this.deps.eventNormalizer.clearSessionState(sessionId);
    await this.primitives.safeReportAsyncFailure(originalError, metadata);
    if (isObligationViolationError(originalError)) {
      throw originalError;
    }
  }

  private async handleFailedTerminalRecovery(
    params: TerminalEventRecoveryParams,
    metadata: RecoveryMetadata,
    terminalRecoveryError: unknown
  ): Promise<void> {
    params.clearPendingSessionFinishedEvent(params.terminalEvent);
    this.deps.eventNormalizer.clearSessionState(params.sessionId);
    await this.primitives.safeReportAsyncFailure(params.originalError, metadata);
    if (isObligationViolationError(terminalRecoveryError)) {
      throw terminalRecoveryError;
    }
    await this.primitives.safeReportAsyncFailure(terminalRecoveryError, {
      ...metadata,
      eventType: "session_finished"
    });
    await this.settleRuntimeEventRecovery(
      params.workerRunId,
      "runtime_event_handler",
      summarizeTerminalRecoveryFailure(params.failureEventType, params.terminalEvent, terminalRecoveryError),
      metadata
    );
  }

  private async stopIfWorkerAlreadySettled(
    workerRunId: string,
    terminalState: boolean | null,
    phase: string,
    metadata: RecoveryMetadata
  ): Promise<boolean> {
    if (terminalState === true) {
      return true;
    }
    if (terminalState === null) {
      await this.primitives.reportUnknownTerminalWorkerState(workerRunId, phase, metadata);
    }
    return false;
  }

  private async reportAbortRecoveryFailure(
    workerRunId: string,
    metadata: RecoveryMetadata,
    freezeResult: RecoveryResult,
    abortResult: RecoveryResult
  ): Promise<void> {
    const terminalStateAfterAbort = await this.primitives.readTerminalWorkerState(workerRunId, metadata);
    if (terminalStateAfterAbort === true) {
      return;
    }
    if (terminalStateAfterAbort === null) {
      await this.primitives.reportUnknownTerminalWorkerState(
        workerRunId,
        "event recovery after abort failure",
        metadata
      );
      await this.primitives.safeReportAsyncFailure(
        new CoreError(
          "VALIDATION",
          `Serial delegation event recovery could not verify worker ${workerRunId} terminal state after abort failed. Worker may remain in-flight.`,
          toErrorOptions(abortResult.error ?? freezeResult.error)
        ),
        metadata
      );
      return;
    }
    await this.primitives.safeReportAsyncFailure(
      new CoreError(
        "VALIDATION",
        `Serial delegation event recovery could not settle worker ${workerRunId} after freeze failure. Worker remains in-flight.`,
        toErrorOptions(abortResult.error ?? freezeResult.error)
      ),
      metadata
    );
  }
}

function buildTerminalRecoveryParams(
  params: RuntimeEventFailureParams,
  terminalEvent: SessionFinishedEvent
): TerminalEventRecoveryParams {
  return {
    terminalEvent,
    failureEventType: params.event.type,
    originalError: params.error,
    context: params.context,
    workerRunId: params.workerRunId,
    sessionId: params.sessionId,
    unsubscribe: params.unsubscribe,
    stopEventIntake: params.stopEventIntake,
    clearPendingSessionFinishedEvent: params.clearPendingSessionFinishedEvent
  };
}

function buildEventMetadata(workerRunId: string, event: SessionFinishedEvent): RecoveryMetadata {
  return {
    phase: "event",
    workerRunId,
    sessionId: event.session_id,
    eventType: event.type
  };
}
