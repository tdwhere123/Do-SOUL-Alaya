import {
  GardenTaskKind,
  type GardenTaskDescriptor,
  type GardenTaskKindValue,
  type GardenTaskResult
} from "@do-soul/alaya-protocol";
import { AuditorMaintenanceOperations } from "./auditor-maintenance-operations.js";
import type { AuditorDependencies } from "./auditor-types.js";
import { type GardenTaskHandler, safeRunGardenTask } from "./garden-task-runner.js";

export { GreenRevokeNoopError } from "./auditor-core.js";
export {
  AUDITOR_CONSTANTS,
  type AuditorDependencies,
  type AuditorHealthIssueGroupPort
} from "./auditor-types.js";

export class Auditor extends AuditorMaintenanceOperations {
  private readonly taskHandlers: ReadonlyMap<GardenTaskKindValue, GardenTaskHandler>;

  public constructor(dependencies: AuditorDependencies) {
    super(dependencies);
    this.taskHandlers = new Map<GardenTaskKindValue, GardenTaskHandler>([
      [GardenTaskKind.EVIDENCE_STALENESS_CHECK, this.executeEvidenceCheck.bind(this)],
      [GardenTaskKind.POINTER_HEALTH_CHECK, this.executePointerHealthCheck.bind(this)],
      [GardenTaskKind.POINTER_HEALING, this.executePointerHealing.bind(this)],
      [GardenTaskKind.ORPHAN_DETECTION, this.executeOrphanDetection.bind(this)],
      [GardenTaskKind.EVENT_LOG_ORPHAN_DETECTION, this.executeEventLogOrphanDetection.bind(this)],
      [GardenTaskKind.GREEN_MAINTENANCE, this.executeGreenMaintenance.bind(this)],
      [GardenTaskKind.BOOTSTRAPPING_SCAN, this.executeBootstrappingScan.bind(this)],
      [GardenTaskKind.CRYSTALLIZATION_SCAN, this.executeCrystallizationScan.bind(this)]
    ]);
  }

  public async run(task: GardenTaskDescriptor): Promise<GardenTaskResult> {
    return safeRunGardenTask({
      roleLabel: "Auditor",
      task,
      completedAt: this.now(),
      handlers: this.taskHandlers,
      createFailureResult: this.createFailureResult.bind(this),
      reportCompletion: (result) => this.dependencies.scheduler.reportCompletion(result)
    });
  }
}
