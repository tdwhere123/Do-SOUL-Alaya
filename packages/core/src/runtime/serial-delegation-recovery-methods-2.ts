import type { AgentRuntimePort, DelegatedWorkerRun, RuntimeEvent } from "@do-soul/alaya-protocol";

import type { ConstraintProxy } from "../security/constraint-proxy.js";

import { CoreError } from "../shared/errors.js";

import {
  isObligationViolationError,
  isTerminalWorkerState,
  summarizeError,
  summarizeTerminalRecoveryFailure,
  toErrorOptions
} from "./serial-delegation-recovery-errors.js";

import type { NormalizerContext, RuntimeEventNormalizer } from "./runtime-event-normalizer.js";

import type { StrongRefService } from "../memory/strong-ref-service.js";

import type { WorkerRunLifecycleService } from "./worker-run-lifecycle-service.js";
type SerialDelegationRecoveryMethodOwner = {
  deps: SerialDelegationRecoveryDependencies;
  [key: string]: any;
};


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

export async function serialDelegationRecoveryRecoverTerminalEvent(owner: SerialDelegationRecoveryMethodOwner, params: {
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
    try {
      await owner.handleRuntimeEvent(
        params.terminalEvent,
        params.context,
        params.workerRunId,
        params.unsubscribe,
        params.stopEventIntake
      );
      await handleSuccessfulTerminalRecovery(owner, params.originalError, params.sessionId, metadata);
    } catch (terminalRecoveryError) {
      await handleFailedTerminalRecovery(owner, params, metadata, terminalRecoveryError);
    } finally {
      owner.deps.eventNormalizer.clearSessionState(params.sessionId);
      params.unsubscribe();
      params.clearPendingSessionFinishedEvent(params.terminalEvent);
    }
  }

export async function serialDelegationRecoverySettleRuntimeEventRecovery(owner: SerialDelegationRecoveryMethodOwner, workerRunId: string, panicSource: string, summary: string, metadata: RecoveryMetadata): Promise<void> {
    const terminalStateBeforeFreeze = await owner.readTerminalWorkerState(workerRunId, metadata);
    if (await stopIfWorkerAlreadySettled(owner, workerRunId, terminalStateBeforeFreeze, "event recovery", metadata)) {
      return;
    }

    const freezeResult = await owner.freezeWorkerRun(workerRunId, panicSource, summary, metadata);

    if (freezeResult.succeeded) {
      return;
    }

    const terminalStateAfterFreeze = await owner.readTerminalWorkerState(workerRunId, metadata);
    if (
      await stopIfWorkerAlreadySettled(
        owner,
        workerRunId,
        terminalStateAfterFreeze,
        "event recovery after freeze failure",
        metadata
      )
    ) {
      return;
    }

    const abortResult = await owner.abortWorkerRun(
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
    await reportAbortRecoveryFailure(owner, workerRunId, metadata, freezeResult, abortResult);
  }

export async function serialDelegationRecoverySuspendBlockedCompletionAfterObligationViolation(owner: SerialDelegationRecoveryMethodOwner, workerRunId: string, originalError: unknown, metadata: RecoveryMetadata): Promise<void> {
    const terminalStateBeforeSuspend = await owner.readTerminalWorkerState(workerRunId, metadata);
    if (terminalStateBeforeSuspend === true) {
      return;
    }

    if (terminalStateBeforeSuspend === null) {
      await owner.reportUnknownTerminalWorkerState(
        workerRunId,
        "obligation violation completion recovery",
        metadata
      );
    }

    let suspendError: unknown = null;
    try {
      await owner.deps.workerRunLifecycle.suspend(workerRunId, "obligation_violation");
      await owner.releaseWorkerConstraintStrongRefs(workerRunId, metadata);
      return;
    } catch (error) {
      suspendError = error;
      await owner.safeReportAsyncFailure(suspendError, metadata);
    }

    const terminalStateAfterSuspendFailure = await owner.readTerminalWorkerState(workerRunId, metadata);
    if (terminalStateAfterSuspendFailure === true) {
      return;
    }

    if (terminalStateAfterSuspendFailure === null) {
      await owner.reportUnknownTerminalWorkerState(
        workerRunId,
        "obligation violation completion recovery after suspend failure",
        metadata
      );
    }

    await owner.safeReportAsyncFailure(
      new CoreError(
        "VALIDATION",
        `Serial delegation completion recovery could not suspend worker ${workerRunId} after deferred-obligation violation. Worker may remain in-flight.`,
        toErrorOptions(suspendError ?? originalError)
      ),
      metadata
    );
  }

export async function serialDelegationRecoveryFreezeWorkerRun(owner: SerialDelegationRecoveryMethodOwner, workerRunId: string, panicSource: string, summary: string, metadata: RecoveryMetadata): Promise<RecoveryResult> {
    try {
      await owner.deps.workerRunLifecycle.freeze(workerRunId, panicSource, summary);
      await owner.releaseWorkerConstraintStrongRefs(workerRunId, metadata);
      return { succeeded: true };
    } catch (freezeError) {
      await owner.safeReportAsyncFailure(freezeError, metadata);
      return { succeeded: false, error: freezeError };
    }
  }

export async function serialDelegationRecoveryRollbackInsertedPreDispatchWorkerRun(owner: SerialDelegationRecoveryMethodOwner, workerRunId: string, metadata: RecoveryMetadata): Promise<RecoveryResult> {
    try {
      const workerRun = await owner.deps.workerRunRepo.getById(workerRunId);

      if (workerRun === null || isTerminalWorkerState(workerRun.state)) {
        return { succeeded: true };
      }

      if (workerRun.state !== "init") {
        throw new CoreError(
          "VALIDATION",
          `Serial delegation pre-runtime rollback expected worker ${workerRunId} in init, found ${workerRun.state}.`
        );
      }

      await owner.deps.workerRunRepo.deleteIfState(workerRunId, "init");
      return { succeeded: true };
    } catch (rollbackError) {
      await owner.safeReportAsyncFailure(rollbackError, metadata);
      return { succeeded: false, error: rollbackError };
    }
  }

export async function serialDelegationRecoveryAbortWorkerRun(owner: SerialDelegationRecoveryMethodOwner, workerRunId: string, reason: string, metadata: RecoveryMetadata): Promise<RecoveryResult> {
    try {
      await owner.deps.workerRunLifecycle.abort(workerRunId, {
        reason,
        rollbackAttempted: false
      });
      await owner.releaseWorkerConstraintStrongRefs(workerRunId, metadata);
      return { succeeded: true };
    } catch (abortError) {
      await owner.safeReportAsyncFailure(abortError, metadata);
      return { succeeded: false, error: abortError };
    }
  }

export async function serialDelegationRecoveryReadTerminalWorkerState(owner: SerialDelegationRecoveryMethodOwner, workerRunId: string, metadata: RecoveryMetadata): Promise<boolean | null> {
    try {
      const workerRun = await owner.deps.workerRunRepo.getById(workerRunId);
      return workerRun !== null && isTerminalWorkerState(workerRun.state);
    } catch (lookupError) {
      await owner.safeReportAsyncFailure(lookupError, metadata);
      return null;
    }
  }

export async function serialDelegationRecoveryReportUnknownTerminalWorkerState(owner: SerialDelegationRecoveryMethodOwner, workerRunId: string, phase: string, metadata: RecoveryMetadata): Promise<void> {
    await owner.safeReportAsyncFailure(
      new CoreError(
        "VALIDATION",
        `Serial delegation ${phase} could not verify worker ${workerRunId} terminal state before a recovery transition. Worker may remain in-flight.`
      ),
      metadata
    );
  }

export async function serialDelegationRecoveryIsTerminalWorkerRun(owner: SerialDelegationRecoveryMethodOwner, workerRunId: string): Promise<boolean> {
    const workerRun = await owner.deps.workerRunRepo.getById(workerRunId);
    return workerRun !== null && isTerminalWorkerState(workerRun.state);
  }

export async function serialDelegationRecoveryCancelRuntime(owner: SerialDelegationRecoveryMethodOwner, runtimeAdapter: AgentRuntimePort, metadata: RecoveryMetadata): Promise<RecoveryResult> {
    if (metadata.sessionId === null) {
      return { succeeded: true };
    }

    try {
      await runtimeAdapter.cancel(metadata.sessionId);
      return { succeeded: true };
    } catch (cancelError) {
      await owner.safeReportAsyncFailure(cancelError, metadata);
      return { succeeded: false, error: cancelError };
    }
  }

export function serialDelegationRecoveryClearNormalizerSession(owner: SerialDelegationRecoveryMethodOwner, sessionId: string | null): void {
    if (sessionId === null) {
      return;
    }

    owner.deps.eventNormalizer.clearSessionState(sessionId);
  }

export async function serialDelegationRecoverySafeReportAsyncFailure(owner: SerialDelegationRecoveryMethodOwner, error: unknown, metadata: RecoveryMetadata): Promise<void> {
    try {
      await owner.deps.reportAsyncFailure?.(error, metadata);
    } catch {
      // Reporter failures must never block fail-closed recovery.
    }
  }

export async function serialDelegationRecoveryReleaseWorkerConstraintStrongRefs(owner: SerialDelegationRecoveryMethodOwner, workerRunId: string, metadata: RecoveryMetadata): Promise<void> {
    if (owner.deps.strongRefService === undefined) {
      return;
    }

    try {
      await owner.deps.strongRefService.releaseBySource({
        sourceEntityType: "worker_run",
        sourceEntityId: workerRunId
      });
    } catch (error) {
      await owner.safeReportAsyncFailure(error, metadata);
    }
  }

async function handleSuccessfulTerminalRecovery(
  owner: SerialDelegationRecoveryMethodOwner,
  originalError: unknown,
  sessionId: string,
  metadata: RecoveryMetadata
): Promise<void> {
  owner.deps.eventNormalizer.clearSessionState(sessionId);
  await serialDelegationRecoverySafeReportAsyncFailure(owner, originalError, metadata);
  if (isObligationViolationError(originalError)) {
    throw originalError;
  }
}

async function handleFailedTerminalRecovery(
  owner: SerialDelegationRecoveryMethodOwner,
  params: {
    readonly terminalEvent: SessionFinishedEvent;
    readonly failureEventType: RuntimeEvent["type"];
    readonly originalError: unknown;
    readonly workerRunId: string;
    readonly sessionId: string;
    readonly clearPendingSessionFinishedEvent: (event: SessionFinishedEvent) => void;
  },
  metadata: RecoveryMetadata,
  terminalRecoveryError: unknown
): Promise<void> {
  params.clearPendingSessionFinishedEvent(params.terminalEvent);
  owner.deps.eventNormalizer.clearSessionState(params.sessionId);
  await serialDelegationRecoverySafeReportAsyncFailure(owner, params.originalError, metadata);
  if (isObligationViolationError(terminalRecoveryError)) {
    throw terminalRecoveryError;
  }
  await serialDelegationRecoverySafeReportAsyncFailure(owner, terminalRecoveryError, {
    ...metadata,
    eventType: "session_finished"
  });
  await owner.settleRuntimeEventRecovery(
    params.workerRunId,
    "runtime_event_handler",
    summarizeTerminalRecoveryFailure(params.failureEventType, params.terminalEvent, terminalRecoveryError),
    metadata
  );
}

async function stopIfWorkerAlreadySettled(
  owner: SerialDelegationRecoveryMethodOwner,
  workerRunId: string,
  terminalState: boolean | null,
  phase: string,
  metadata: RecoveryMetadata
): Promise<boolean> {
  if (terminalState === true) {
    return true;
  }
  if (terminalState === null) {
    await owner.reportUnknownTerminalWorkerState(workerRunId, phase, metadata);
  }
  return false;
}

async function reportAbortRecoveryFailure(
  owner: SerialDelegationRecoveryMethodOwner,
  workerRunId: string,
  metadata: RecoveryMetadata,
  freezeResult: RecoveryResult,
  abortResult: RecoveryResult
): Promise<void> {
  const terminalStateAfterAbort = await owner.readTerminalWorkerState(workerRunId, metadata);
  if (terminalStateAfterAbort === true) {
    return;
  }
  if (terminalStateAfterAbort === null) {
    await owner.reportUnknownTerminalWorkerState(workerRunId, "event recovery after abort failure", metadata);
    await owner.safeReportAsyncFailure(
      new CoreError(
        "VALIDATION",
        `Serial delegation event recovery could not verify worker ${workerRunId} terminal state after abort failed. Worker may remain in-flight.`,
        toErrorOptions(abortResult.error ?? freezeResult.error)
      ),
      metadata
    );
    return;
  }
  await owner.safeReportAsyncFailure(
    new CoreError(
      "VALIDATION",
      `Serial delegation event recovery could not settle worker ${workerRunId} after freeze failure. Worker remains in-flight.`,
      toErrorOptions(abortResult.error ?? freezeResult.error)
    ),
    metadata
  );
}
