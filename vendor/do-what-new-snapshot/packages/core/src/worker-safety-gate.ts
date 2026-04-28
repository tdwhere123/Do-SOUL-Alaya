import type { DelegatedWorkerRun, WorkerBaselineLock, WorkerSafetyPort } from "@do-what/protocol";
import { CoreError } from "./errors.js";

export interface WorkerSafetyGateDependencies {
  readonly safetyPort: WorkerSafetyPort;
}

/**
 * Pre-dispatch safety gate.
 * Any assembly or validation failure refuses dispatch.
 */
export class WorkerSafetyGate {
  public constructor(private readonly dependencies: WorkerSafetyGateDependencies) {}

  public async enforceBeforeDispatch(
    workerRun: Readonly<DelegatedWorkerRun>
  ): Promise<WorkerBaselineLock> {
    let lock: WorkerBaselineLock;

    try {
      lock = await this.dependencies.safetyPort.assembleBaselineLock(workerRun.workspace_id);
    } catch (cause) {
      throw new CoreError(
        "VALIDATION",
        "Worker Baseline Safety cannot be assembled. Dispatch refused (degraded mode).",
        { cause }
      );
    }

    this.validateConstraintCoverage(workerRun, lock);

    return lock;
  }

  private validateConstraintCoverage(workerRun: Readonly<DelegatedWorkerRun>, lock: WorkerBaselineLock): void {
    const snapshotRefs = new Set(workerRun.principal_security_snapshot.hard_constraint_refs);
    const missingRefs = lock.hard_constraint_refs.filter((ref) => !snapshotRefs.has(ref));

    if (missingRefs.length > 0) {
      throw new CoreError(
        "VALIDATION",
        `Worker security snapshot is missing ${missingRefs.length} hard constraint ref(s) required by baseline. Dispatch refused.`
      );
    }
  }
}
