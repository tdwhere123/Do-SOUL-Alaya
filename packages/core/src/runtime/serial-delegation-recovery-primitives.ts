import type { AgentRuntimePort } from "@do-soul/alaya-protocol";

import { CoreError } from "../shared/errors.js";

import { isTerminalWorkerState } from "./serial-delegation-recovery-errors.js";
import type {
  RecoveryMetadata,
  RecoveryPrimitivesPort,
  RecoveryResult,
  SerialDelegationRecoveryDependencies
} from "./serial-delegation-recovery-ports.js";

// Shared low-level recovery transitions used by both startup and event phases.
export class RecoveryPrimitives implements RecoveryPrimitivesPort {
  public constructor(public readonly deps: SerialDelegationRecoveryDependencies) {}

  public async freezeWorkerRun(
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

  public async rollbackInsertedPreDispatchWorkerRun(
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

  public async abortWorkerRun(
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

  public async cancelRuntime(
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

  public async readTerminalWorkerState(
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

  public async reportUnknownTerminalWorkerState(
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

  public async isTerminalWorkerRun(workerRunId: string): Promise<boolean> {
    const workerRun = await this.deps.workerRunRepo.getById(workerRunId);
    return workerRun !== null && isTerminalWorkerState(workerRun.state);
  }

  public clearNormalizerSession(sessionId: string | null): void {
    if (sessionId === null) {
      return;
    }

    this.deps.eventNormalizer.clearSessionState(sessionId);
  }

  public async safeReportAsyncFailure(error: unknown, metadata: RecoveryMetadata): Promise<void> {
    try {
      await this.deps.reportAsyncFailure?.(error, metadata);
    } catch {
      // Reporter failures must never block fail-closed recovery.
    }
  }

  public async releaseWorkerConstraintStrongRefs(
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
