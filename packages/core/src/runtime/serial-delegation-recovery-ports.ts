import type { AgentRuntimePort, DelegatedWorkerRun, RuntimeEvent } from "@do-soul/alaya-protocol";

import type { ConstraintProxy } from "../security/constraint-proxy.js";
import type { NormalizerContext, RuntimeEventNormalizer } from "./runtime-event-normalizer.js";
import type { StrongRefService } from "../memory/strong-ref-service.js";
import type { WorkerRunLifecycleService } from "./worker-run-lifecycle-service.js";

export type SessionFinishedEvent = Extract<RuntimeEvent, { readonly type: "session_finished" }>;

export interface RecoveryWorkerRunRepoPort {
  getById(workerRunId: string): Promise<Readonly<DelegatedWorkerRun> | null>;
  deleteIfState(workerRunId: string, expectedState: DelegatedWorkerRun["state"]): Promise<void>;
}

export type RuntimeEventNormalizerPort = Pick<RuntimeEventNormalizer, "normalize" | "clearSessionState">;

export type ConstraintProxyPort = Pick<ConstraintProxy, "assertNoViolation">;

export type StrongRefServicePort = Pick<StrongRefService, "releaseBySource">;

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

export interface RuntimeEventFailureParams {
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
}

export interface TerminalEventRecoveryParams {
  readonly terminalEvent: SessionFinishedEvent;
  readonly failureEventType: RuntimeEvent["type"];
  readonly originalError: unknown;
  readonly context: NormalizerContext;
  readonly workerRunId: string;
  readonly sessionId: string;
  readonly unsubscribe: () => void;
  readonly stopEventIntake: () => void;
  readonly clearPendingSessionFinishedEvent: (event: SessionFinishedEvent) => void;
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

// Shared low-level recovery transitions used by both startup and event phases.
export interface RecoveryPrimitivesPort {
  readonly deps: SerialDelegationRecoveryDependencies;
  freezeWorkerRun(
    workerRunId: string,
    panicSource: string,
    summary: string,
    metadata: RecoveryMetadata
  ): Promise<RecoveryResult>;
  rollbackInsertedPreDispatchWorkerRun(
    workerRunId: string,
    metadata: RecoveryMetadata
  ): Promise<RecoveryResult>;
  abortWorkerRun(workerRunId: string, reason: string, metadata: RecoveryMetadata): Promise<RecoveryResult>;
  cancelRuntime(runtimeAdapter: AgentRuntimePort, metadata: RecoveryMetadata): Promise<RecoveryResult>;
  readTerminalWorkerState(workerRunId: string, metadata: RecoveryMetadata): Promise<boolean | null>;
  reportUnknownTerminalWorkerState(
    workerRunId: string,
    phase: string,
    metadata: RecoveryMetadata
  ): Promise<void>;
  isTerminalWorkerRun(workerRunId: string): Promise<boolean>;
  clearNormalizerSession(sessionId: string | null): void;
  safeReportAsyncFailure(error: unknown, metadata: RecoveryMetadata): Promise<void>;
  releaseWorkerConstraintStrongRefs(workerRunId: string, metadata: RecoveryMetadata): Promise<void>;
}
