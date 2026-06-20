import type { AgentRuntimePort, DelegatedWorkerRun, RuntimeEvent } from "@do-soul/alaya-protocol";

import type { ConstraintProxy } from "../security/constraint-proxy.js";

import { CoreError } from "../shared/errors.js";

import {
  isObligationViolationError,
  summarizeError,
  toErrorOptions
} from "./serial-delegation-recovery-errors.js";

import type { NormalizerContext, RuntimeEventNormalizer } from "./runtime-event-normalizer.js";

import type { StrongRefService } from "../memory/strong-ref-service.js";

import type { WorkerRunLifecycleService } from "./worker-run-lifecycle-service.js";
import {
  handleStartupCancelFailure,
  prepareCanceledStartupRecovery,
  settleCanceledStartupFailure
} from "./serial-delegation-recovery-methods-3.js";

export type SerialDelegationRecoveryMethodOwner = {
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

export interface RecoveryResult {
  readonly succeeded: boolean;
  readonly error?: unknown;
}

export interface PreDispatchFreezeIntent {
  readonly panicSource: string;
  readonly summary: string;
}

export interface StartupFailureRecoveryParams {
  readonly error: unknown;
  readonly workerRunId: string;
  readonly sessionId: string | null;
  readonly runtimeAdapter: AgentRuntimePort;
  readonly unsubscribe: (() => void) | null;
  readonly stopEventIntake: () => void;
  readonly resumeEventIntake: () => void;
  readonly drainEventQueue: () => Promise<void>;
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

interface PreDispatchRecoveryContext {
  readonly owner: SerialDelegationRecoveryMethodOwner;
  readonly workerRunId: string;
  readonly error: unknown;
  readonly metadata: RecoveryMetadata;
  readonly shouldReportOriginalError: boolean;
}

export async function serialDelegationRecoveryRecoverPreDispatchFailure(owner: SerialDelegationRecoveryMethodOwner, workerRunId: string, error: unknown, freezeIntent: PreDispatchFreezeIntent | null, durableDecisionCommitted: boolean): Promise<void> {
    const metadata: RecoveryMetadata = {
      phase: "startup",
      workerRunId,
      sessionId: null
    };
    const context: PreDispatchRecoveryContext = {
      owner,
      workerRunId,
      error,
      metadata,
      shouldReportOriginalError: !(error instanceof CoreError && error.code === "CONFLICT")
    };

    if (await stopIfPreDispatchWorkerSettled(context, "pre-runtime recovery")) {
      return;
    }

    const freezeResult = await owner.freezeWorkerRun(
      workerRunId,
      freezeIntent?.panicSource ?? "serial_delegation_preflight",
      freezeIntent?.summary ?? summarizeError(error, "pre-dispatch guard failure"),
      metadata
    );

    if (freezeResult.succeeded) {
      await reportOriginalStartupError(context);
      return;
    }

    await owner.releaseWorkerConstraintStrongRefs(workerRunId, metadata);

    if (await stopIfPreDispatchWorkerSettled(context, "pre-runtime recovery after freeze failure")) {
      return;
    }

    if (freezeIntent === null && !durableDecisionCommitted) {
      await recoverRollbackAfterFreezeFailure(context, freezeResult);
      return;
    }

    await reportOriginalStartupError(context);
    throw new CoreError(
      "VALIDATION",
      `Serial delegation pre-runtime recovery could not settle worker ${workerRunId} after startup guard failure. Worker remains in-flight.`,
      toErrorOptions(freezeResult.error)
    );
  }

export async function serialDelegationRecoveryHandleRuntimeEvent(owner: SerialDelegationRecoveryMethodOwner, event: RuntimeEvent, context: NormalizerContext, workerRunId: string, unsubscribe: () => void, stopEventIntake: () => void): Promise<void> {
    if (await shouldSkipFinishedSessionEvent(owner, event, workerRunId, unsubscribe, stopEventIntake)) {
      return;
    }

    await owner.deps.eventNormalizer.normalize(event, context);

    if (event.type !== "session_finished") {
      return;
    }

    if (event.status === "completed") {
      await completeWorkerRunAfterSessionFinished(owner, context, workerRunId, event);
      unsubscribe();
      return;
    }

    await abortWorkerRunAfterSessionFinished(owner, workerRunId, event);
    unsubscribe();
  }

export async function serialDelegationRecoveryHandleStartupFailure(owner: SerialDelegationRecoveryMethodOwner, params: StartupFailureRecoveryParams): Promise<void> {
    const metadata: RecoveryMetadata = {
      phase: "startup",
      workerRunId: params.workerRunId,
      sessionId: params.sessionId
    };
    params.stopEventIntake();

    const cancelResult = await owner.cancelRuntime(params.runtimeAdapter, metadata);

    if (!cancelResult.succeeded) {
      await handleStartupCancelFailure(owner, params, metadata, cancelResult);
      return;
    }

    await prepareCanceledStartupRecovery(owner, params);
    await settleCanceledStartupFailure(owner, params, metadata);
  }

export async function serialDelegationRecoveryHandleRuntimeEventFailure(owner: SerialDelegationRecoveryMethodOwner, params: {
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
      await handleObligationViolationDuringEventRecovery(owner, params, metadata);
      return;
    }

    const cancelResult = await owner.cancelRuntime(params.runtimeAdapter, metadata);

    if (!cancelResult.succeeded) {
      await recoverAfterCancelFailure(owner, params, metadata, cancelResult);
      return;
    }

    const terminalRecoveryEvent =
      params.event.type === "session_finished"
        ? params.event
        : await params.awaitPendingSessionFinishedEvent();

    if (terminalRecoveryEvent !== null) {
      await owner.recoverTerminalEvent(
        buildTerminalRecoveryParams(params, terminalRecoveryEvent),
        metadata
      );
      return;
    }

    await settleUnhandledRuntimeEventFailure(owner, params, metadata);
  }

async function reportOriginalStartupError(context: PreDispatchRecoveryContext): Promise<void> {
  if (context.shouldReportOriginalError) {
    await context.owner.safeReportAsyncFailure(context.error, context.metadata);
  }
}

async function stopIfPreDispatchWorkerSettled(
  context: PreDispatchRecoveryContext,
  phase: string
): Promise<boolean> {
  const terminalState = await context.owner.readTerminalWorkerState(
    context.workerRunId,
    context.metadata
  );
  if (terminalState === true) {
    await reportOriginalStartupError(context);
    return true;
  }
  if (terminalState === null) {
    await context.owner.reportUnknownTerminalWorkerState(
      context.workerRunId,
      phase,
      context.metadata
    );
  }
  return false;
}

async function recoverRollbackAfterFreezeFailure(
  context: PreDispatchRecoveryContext,
  freezeResult: RecoveryResult
): Promise<void> {
  const rollbackResult = await context.owner.rollbackInsertedPreDispatchWorkerRun(
    context.workerRunId,
    context.metadata
  );
  await reportOriginalStartupError(context);
  if (rollbackResult.succeeded) {
    return;
  }
  throw new CoreError(
    "VALIDATION",
    `Serial delegation pre-runtime recovery could not roll back worker ${context.workerRunId} after integration gate failure. Worker may remain in-flight.`,
    toErrorOptions(rollbackResult.error ?? freezeResult.error)
  );
}

async function shouldSkipFinishedSessionEvent(
  owner: SerialDelegationRecoveryMethodOwner,
  event: RuntimeEvent,
  workerRunId: string,
  unsubscribe: () => void,
  stopEventIntake: () => void
): Promise<boolean> {
  if (event.type !== "session_finished") {
    return false;
  }
  stopEventIntake();
  if (!(await owner.isTerminalWorkerRun(workerRunId))) {
    return false;
  }
  unsubscribe();
  return true;
}

async function completeWorkerRunAfterSessionFinished(
  owner: SerialDelegationRecoveryMethodOwner,
  context: NormalizerContext,
  workerRunId: string,
  event: SessionFinishedEvent
): Promise<void> {
  const metadata = buildEventMetadata(workerRunId, event);
  try {
    await owner.deps.constraintProxy.assertNoViolation(
      context.workspaceId,
      context.principalRunId,
      "worker_complete"
    );
  } catch (error) {
    if (isObligationViolationError(error)) {
      await owner.releaseWorkerConstraintStrongRefs(workerRunId, metadata);
    }
    throw error;
  }
  await owner.deps.workerRunLifecycle.complete(workerRunId, []);
  await owner.releaseWorkerConstraintStrongRefs(workerRunId, metadata);
}

async function abortWorkerRunAfterSessionFinished(
  owner: SerialDelegationRecoveryMethodOwner,
  workerRunId: string,
  event: SessionFinishedEvent
): Promise<void> {
  await owner.deps.workerRunLifecycle.abort(workerRunId, {
    reason: event.result_summary ?? event.status,
    rollbackAttempted: false
  });
  await owner.releaseWorkerConstraintStrongRefs(workerRunId, buildEventMetadata(workerRunId, event));
}

async function handleObligationViolationDuringEventRecovery(
  owner: SerialDelegationRecoveryMethodOwner,
  params: {
    readonly error: unknown;
    readonly event: RuntimeEvent;
    readonly workerRunId: string;
    readonly sessionId: string;
    readonly unsubscribe: () => void;
    readonly stopEventIntake: () => void;
    readonly clearPendingSessionFinishedEvent: (event: SessionFinishedEvent) => void;
  },
  metadata: RecoveryMetadata
): Promise<void> {
  params.stopEventIntake();
  params.unsubscribe();
  if (params.event.type === "session_finished") {
    if (params.event.status === "completed") {
      await owner.suspendBlockedCompletionAfterObligationViolation(
        params.workerRunId,
        params.error,
        metadata
      );
    }
    params.clearPendingSessionFinishedEvent(params.event);
  }
  owner.deps.eventNormalizer.clearSessionState(params.sessionId);
  await owner.safeReportAsyncFailure(params.error, metadata);
}

async function recoverAfterCancelFailure(
  owner: SerialDelegationRecoveryMethodOwner,
  params: {
    readonly error: unknown;
    readonly event: RuntimeEvent;
    readonly context: NormalizerContext;
    readonly workerRunId: string;
    readonly sessionId: string;
    readonly unsubscribe: () => void;
    readonly stopEventIntake: () => void;
    readonly resumeEventIntake: () => void;
    readonly awaitPendingSessionFinishedEvent: () => Promise<SessionFinishedEvent | null>;
    readonly clearPendingSessionFinishedEvent: (event: SessionFinishedEvent) => void;
  },
  metadata: RecoveryMetadata,
  cancelResult: RecoveryResult
): Promise<void> {
  if (params.event.type === "session_finished") {
    await owner.recoverTerminalEvent(buildTerminalRecoveryParams(params, params.event), metadata);
    return;
  }

  const terminalEvent = await params.awaitPendingSessionFinishedEvent();
  if (terminalEvent !== null) {
    await owner.handleRuntimeEvent(
      terminalEvent,
      params.context,
      params.workerRunId,
      params.unsubscribe,
      params.stopEventIntake
    );
    params.clearPendingSessionFinishedEvent(terminalEvent);
    await owner.safeReportAsyncFailure(params.error, metadata);
    return;
  }

  params.resumeEventIntake();
  await owner.safeReportAsyncFailure(params.error, metadata);
  await owner.safeReportAsyncFailure(
    new CoreError(
      "VALIDATION",
      "Serial delegation event recovery could not cancel the runtime session. Worker remains in-flight.",
      toErrorOptions(cancelResult.error)
    ),
    metadata
  );
}

function buildTerminalRecoveryParams(
  params: {
    readonly error: unknown;
    readonly event: RuntimeEvent;
    readonly context: NormalizerContext;
    readonly workerRunId: string;
    readonly sessionId: string;
    readonly unsubscribe: () => void;
    readonly stopEventIntake: () => void;
    readonly clearPendingSessionFinishedEvent: (event: SessionFinishedEvent) => void;
  },
  terminalEvent: SessionFinishedEvent
) {
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

async function settleUnhandledRuntimeEventFailure(
  owner: SerialDelegationRecoveryMethodOwner,
  params: {
    readonly error: unknown;
    readonly event: RuntimeEvent;
    readonly workerRunId: string;
    readonly sessionId: string;
    readonly unsubscribe: () => void;
    readonly stopEventIntake: () => void;
  },
  metadata: RecoveryMetadata
): Promise<void> {
  params.stopEventIntake();
  params.unsubscribe();
  owner.deps.eventNormalizer.clearSessionState(params.sessionId);
  await owner.settleRuntimeEventRecovery(
    params.workerRunId,
    "runtime_event_handler",
    `${params.event.type}: ${summarizeError(params.error, "event handling failure")}`,
    metadata
  );
  await owner.safeReportAsyncFailure(params.error, metadata);
}

function buildEventMetadata(
  workerRunId: string,
  event: SessionFinishedEvent
): RecoveryMetadata {
  return {
    phase: "event",
    workerRunId,
    sessionId: event.session_id,
    eventType: event.type
  };
}
