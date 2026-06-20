import { CoreError } from "../shared/errors.js";

import { summarizeError, toErrorOptions } from "./serial-delegation-recovery-errors.js";

import type {
  PreDispatchFreezeIntent,
  RecoveryMetadata,
  RecoveryPrimitivesPort,
  RecoveryResult,
  StartupFailureRecoveryParams
} from "./serial-delegation-recovery-ports.js";

interface PreDispatchRecoveryContext {
  readonly workerRunId: string;
  readonly error: unknown;
  readonly metadata: RecoveryMetadata;
  readonly shouldReportOriginalError: boolean;
}

// Startup / pre-dispatch recovery: cancel the runtime then freeze-or-rollback
// the worker, escalating to abort when freeze cannot settle it.
export class SerialDelegationStartupRecovery {
  public constructor(private readonly primitives: RecoveryPrimitivesPort) {}

  private get deps(): RecoveryPrimitivesPort["deps"] {
    return this.primitives.deps;
  }

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
    const context: PreDispatchRecoveryContext = {
      workerRunId,
      error,
      metadata,
      shouldReportOriginalError: !(error instanceof CoreError && error.code === "CONFLICT")
    };

    if (await this.stopIfPreDispatchWorkerSettled(context, "pre-runtime recovery")) {
      return;
    }

    const freezeResult = await this.primitives.freezeWorkerRun(
      workerRunId,
      freezeIntent?.panicSource ?? "serial_delegation_preflight",
      freezeIntent?.summary ?? summarizeError(error, "pre-dispatch guard failure"),
      metadata
    );

    if (freezeResult.succeeded) {
      await this.reportOriginalStartupError(context);
      return;
    }

    await this.primitives.releaseWorkerConstraintStrongRefs(workerRunId, metadata);

    if (await this.stopIfPreDispatchWorkerSettled(context, "pre-runtime recovery after freeze failure")) {
      return;
    }

    if (freezeIntent === null && !durableDecisionCommitted) {
      await this.recoverRollbackAfterFreezeFailure(context, freezeResult);
      return;
    }

    await this.reportOriginalStartupError(context);
    throw new CoreError(
      "VALIDATION",
      `Serial delegation pre-runtime recovery could not settle worker ${workerRunId} after startup guard failure. Worker remains in-flight.`,
      toErrorOptions(freezeResult.error)
    );
  }

  public async handleStartupFailure(params: StartupFailureRecoveryParams): Promise<void> {
    const metadata: RecoveryMetadata = {
      phase: "startup",
      workerRunId: params.workerRunId,
      sessionId: params.sessionId
    };
    params.stopEventIntake();

    const cancelResult = await this.primitives.cancelRuntime(params.runtimeAdapter, metadata);

    if (!cancelResult.succeeded) {
      await this.handleStartupCancelFailure(params, metadata, cancelResult);
      return;
    }

    await this.prepareCanceledStartupRecovery(params);
    await this.settleCanceledStartupFailure(params, metadata);
  }

  private async reportOriginalStartupError(context: PreDispatchRecoveryContext): Promise<void> {
    if (context.shouldReportOriginalError) {
      await this.primitives.safeReportAsyncFailure(context.error, context.metadata);
    }
  }

  private async stopIfPreDispatchWorkerSettled(
    context: PreDispatchRecoveryContext,
    phase: string
  ): Promise<boolean> {
    const terminalState = await this.primitives.readTerminalWorkerState(context.workerRunId, context.metadata);
    if (terminalState === true) {
      await this.reportOriginalStartupError(context);
      return true;
    }
    if (terminalState === null) {
      await this.primitives.reportUnknownTerminalWorkerState(context.workerRunId, phase, context.metadata);
    }
    return false;
  }

  private async recoverRollbackAfterFreezeFailure(
    context: PreDispatchRecoveryContext,
    freezeResult: RecoveryResult
  ): Promise<void> {
    const rollbackResult = await this.primitives.rollbackInsertedPreDispatchWorkerRun(
      context.workerRunId,
      context.metadata
    );
    await this.reportOriginalStartupError(context);
    if (rollbackResult.succeeded) {
      return;
    }
    throw new CoreError(
      "VALIDATION",
      `Serial delegation pre-runtime recovery could not roll back worker ${context.workerRunId} after integration gate failure. Worker may remain in-flight.`,
      toErrorOptions(rollbackResult.error ?? freezeResult.error)
    );
  }

  private async handleStartupCancelFailure(
    params: StartupFailureRecoveryParams,
    metadata: RecoveryMetadata,
    cancelResult: RecoveryResult
  ): Promise<void> {
    await params.drainEventQueue();
    const terminalState = await this.primitives.readTerminalWorkerState(params.workerRunId, metadata);
    if (terminalState === true) {
      params.unsubscribe?.();
      if (params.sessionId !== null) {
        this.deps.eventNormalizer.clearSessionState(params.sessionId);
      }
      await this.primitives.safeReportAsyncFailure(params.error, metadata);
      return;
    }
    if (terminalState === null) {
      params.resumeEventIntake();
      await this.primitives.reportUnknownTerminalWorkerState(
        params.workerRunId,
        "startup recovery after cancel failure",
        metadata
      );
      await this.primitives.safeReportAsyncFailure(params.error, metadata);
      throw new CoreError(
        "VALIDATION",
        `Serial delegation startup recovery could not verify worker ${params.workerRunId} terminal state after cancel failed. Worker may remain in-flight.`
      );
    }

    params.resumeEventIntake();
    await this.primitives.safeReportAsyncFailure(params.error, metadata);
    throw new CoreError(
      "VALIDATION",
      "Serial delegation startup recovery could not cancel the runtime session. Worker remains in-flight.",
      toErrorOptions(cancelResult.error)
    );
  }

  private async prepareCanceledStartupRecovery(params: StartupFailureRecoveryParams): Promise<void> {
    params.unsubscribe?.();
    await params.drainEventQueue();
    if (params.sessionId !== null) {
      this.deps.eventNormalizer.clearSessionState(params.sessionId);
    }
  }

  private async settleCanceledStartupFailure(
    params: StartupFailureRecoveryParams,
    metadata: RecoveryMetadata
  ): Promise<void> {
    const terminalState = await this.primitives.readTerminalWorkerState(params.workerRunId, metadata);
    if (terminalState === true) {
      await this.primitives.safeReportAsyncFailure(params.error, metadata);
      return;
    }
    if (terminalState === null) {
      await this.primitives.reportUnknownTerminalWorkerState(params.workerRunId, "startup recovery", metadata);
    }

    const freezeResult = await this.primitives.freezeWorkerRun(
      params.workerRunId,
      "serial_delegation_startup",
      summarizeError(params.error, "runtime startup failure"),
      metadata
    );
    await this.primitives.safeReportAsyncFailure(params.error, metadata);
    if (freezeResult.succeeded) {
      return;
    }

    await this.settleStartupFailureAfterFreezeFailure(params, metadata, freezeResult);
  }

  private async settleStartupFailureAfterFreezeFailure(
    params: StartupFailureRecoveryParams,
    metadata: RecoveryMetadata,
    freezeResult: RecoveryResult
  ): Promise<void> {
    const terminalState = await this.primitives.readTerminalWorkerState(params.workerRunId, metadata);
    if (terminalState === true) {
      return;
    }
    if (terminalState === null) {
      await this.primitives.reportUnknownTerminalWorkerState(
        params.workerRunId,
        "startup recovery after freeze failure",
        metadata
      );
    }

    const abortResult = await this.primitives.abortWorkerRun(
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

    await this.verifyStartupAbortFallback(params.workerRunId, metadata, freezeResult, abortResult);
  }

  private async verifyStartupAbortFallback(
    workerRunId: string,
    metadata: RecoveryMetadata,
    freezeResult: RecoveryResult,
    abortResult: RecoveryResult
  ): Promise<void> {
    const terminalState = await this.primitives.readTerminalWorkerState(workerRunId, metadata);
    if (terminalState === true) {
      return;
    }
    if (terminalState === null) {
      await this.primitives.reportUnknownTerminalWorkerState(
        workerRunId,
        "startup recovery after abort failure",
        metadata
      );
      throw new CoreError(
        "VALIDATION",
        `Serial delegation startup recovery could not verify worker ${workerRunId} terminal state after abort failed. Worker may remain in-flight.`,
        toErrorOptions(abortResult.error ?? freezeResult.error)
      );
    }

    throw new CoreError(
      "VALIDATION",
      `Serial delegation startup recovery could not settle worker ${workerRunId} after freeze failure. Worker remains in-flight.`,
      toErrorOptions(abortResult.error ?? freezeResult.error)
    );
  }
}
