import {
  GardenTaskKind,
  type GardenTaskDescriptor,
  type GardenTaskResult
} from "@do-soul/alaya-protocol";
import { AuditorMaintenanceOperations } from "./auditor-maintenance-operations.js";
import type { AuditorDependencies } from "./auditor-types.js";

export { GreenRevokeNoopError } from "./auditor-core.js";
export {
  AUDITOR_CONSTANTS,
  type AuditorDependencies,
  type AuditorHealthIssueGroupPort
} from "./auditor-types.js";

export class Auditor extends AuditorMaintenanceOperations {
  public constructor(dependencies: AuditorDependencies) {
    super(dependencies);
  }

  public async run(task: GardenTaskDescriptor): Promise<GardenTaskResult> {
    const completedAt = this.now();

    try {
      switch (task.task_kind) {
        case GardenTaskKind.EVIDENCE_STALENESS_CHECK:
          return await this.executeEvidenceCheck(task, completedAt);
        case GardenTaskKind.POINTER_HEALTH_CHECK:
          return await this.executePointerHealthCheck(task, completedAt);
        case GardenTaskKind.POINTER_HEALING:
          return await this.executePointerHealing(task, completedAt);
        case GardenTaskKind.ORPHAN_DETECTION:
          return await this.executeOrphanDetection(task, completedAt);
        case GardenTaskKind.EVENT_LOG_ORPHAN_DETECTION:
          return await this.executeEventLogOrphanDetection(task, completedAt);
        case GardenTaskKind.GREEN_MAINTENANCE:
          return await this.executeGreenMaintenance(task, completedAt);
        case GardenTaskKind.BOOTSTRAPPING_SCAN:
          return await this.executeBootstrappingScan(task, completedAt);
        case GardenTaskKind.CRYSTALLIZATION_SCAN:
          return await this.executeCrystallizationScan(task, completedAt);
        default:
          throw new Error(`Auditor does not handle task kind: ${task.task_kind}`);
      }
    } catch (error) {
      const result = this.createFailureResult(task, completedAt, error);
      await this.dependencies.scheduler.reportCompletion(result);
      return result;
    }
  }
}
