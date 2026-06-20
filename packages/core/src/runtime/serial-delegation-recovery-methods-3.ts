import { CoreError } from "../shared/errors.js";
import {
  summarizeError,
  toErrorOptions
} from "./serial-delegation-recovery-errors.js";
import type {
  RecoveryMetadata,
  RecoveryResult,
  SerialDelegationRecoveryMethodOwner,
  StartupFailureRecoveryParams
} from "./serial-delegation-recovery-methods-1.js";

export async function handleStartupCancelFailure(
  owner: SerialDelegationRecoveryMethodOwner,
  params: StartupFailureRecoveryParams,
  metadata: RecoveryMetadata,
  cancelResult: RecoveryResult
): Promise<void> {
  await params.drainEventQueue();
  const terminalState = await owner.readTerminalWorkerState(params.workerRunId, metadata);
  if (terminalState === true) {
    params.unsubscribe?.();
    if (params.sessionId !== null) {
      owner.deps.eventNormalizer.clearSessionState(params.sessionId);
    }
    await owner.safeReportAsyncFailure(params.error, metadata);
    return;
  }
  if (terminalState === null) {
    params.resumeEventIntake();
    await owner.reportUnknownTerminalWorkerState(
      params.workerRunId,
      "startup recovery after cancel failure",
      metadata
    );
    await owner.safeReportAsyncFailure(params.error, metadata);
    throw new CoreError(
      "VALIDATION",
      `Serial delegation startup recovery could not verify worker ${params.workerRunId} terminal state after cancel failed. Worker may remain in-flight.`
    );
  }

  params.resumeEventIntake();
  await owner.safeReportAsyncFailure(params.error, metadata);
  throw new CoreError(
    "VALIDATION",
    "Serial delegation startup recovery could not cancel the runtime session. Worker remains in-flight.",
    toErrorOptions(cancelResult.error)
  );
}

export async function prepareCanceledStartupRecovery(
  owner: SerialDelegationRecoveryMethodOwner,
  params: StartupFailureRecoveryParams
): Promise<void> {
  params.unsubscribe?.();
  await params.drainEventQueue();
  if (params.sessionId !== null) {
    owner.deps.eventNormalizer.clearSessionState(params.sessionId);
  }
}

export async function settleCanceledStartupFailure(
  owner: SerialDelegationRecoveryMethodOwner,
  params: StartupFailureRecoveryParams,
  metadata: RecoveryMetadata
): Promise<void> {
  const terminalState = await owner.readTerminalWorkerState(params.workerRunId, metadata);
  if (terminalState === true) {
    await owner.safeReportAsyncFailure(params.error, metadata);
    return;
  }
  if (terminalState === null) {
    await owner.reportUnknownTerminalWorkerState(params.workerRunId, "startup recovery", metadata);
  }

  const freezeResult = await owner.freezeWorkerRun(
    params.workerRunId,
    "serial_delegation_startup",
    summarizeError(params.error, "runtime startup failure"),
    metadata
  );
  await owner.safeReportAsyncFailure(params.error, metadata);
  if (freezeResult.succeeded) {
    return;
  }

  await settleStartupFailureAfterFreezeFailure(owner, params, metadata, freezeResult);
}

export async function settleStartupFailureAfterFreezeFailure(
  owner: SerialDelegationRecoveryMethodOwner,
  params: StartupFailureRecoveryParams,
  metadata: RecoveryMetadata,
  freezeResult: RecoveryResult
): Promise<void> {
  const terminalState = await owner.readTerminalWorkerState(params.workerRunId, metadata);
  if (terminalState === true) {
    return;
  }
  if (terminalState === null) {
    await owner.reportUnknownTerminalWorkerState(
      params.workerRunId,
      "startup recovery after freeze failure",
      metadata
    );
  }

  const abortResult = await owner.abortWorkerRun(
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

  await verifyStartupAbortFallback(owner, params.workerRunId, metadata, freezeResult, abortResult);
}

export async function verifyStartupAbortFallback(
  owner: SerialDelegationRecoveryMethodOwner,
  workerRunId: string,
  metadata: RecoveryMetadata,
  freezeResult: RecoveryResult,
  abortResult: RecoveryResult
): Promise<void> {
  const terminalState = await owner.readTerminalWorkerState(workerRunId, metadata);
  if (terminalState === true) {
    return;
  }
  if (terminalState === null) {
    await owner.reportUnknownTerminalWorkerState(
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
