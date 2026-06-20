import { GardenRole, GardenTaskKind, GardenTier, type GardenTaskDescriptor } from "@do-soul/alaya-protocol";
import { createConsolidationCycleRunner } from "./scheduler-runtime-consolidation.js";
import { createEmbeddingBackfillRuntimeSupport } from "./scheduler-runtime-embedding-backfill.js";
import { createPathPlasticityRuntimeSupport } from "./scheduler-runtime-path-plasticity.js";
import type {
  CreateGardenSchedulerRuntimeSupportInput,
  EmbeddingBackfillTaskOutcome
} from "./scheduler-runtime-types.js";

export {
  createConsolidationCycleRunner,
  createEmbeddingBackfillRuntimeSupport,
  createPathPlasticityRuntimeSupport
};

export function createEventLogOrphanDetectionRunner(input: Readonly<{
  readonly enqueueForAllWorkspaces?: NonNullable<
    CreateGardenSchedulerRuntimeSupportInput["enqueueForAllWorkspaces"]
  >;
  readonly requestBacklogTelemetryCapture: (reason: string) => void;
  readonly runAuditorTask?: (task: Readonly<GardenTaskDescriptor>) => Promise<void>;
  readonly runtimeGardenScheduler: CreateGardenSchedulerRuntimeSupportInput["runtimeGardenScheduler"];
}>): Readonly<{
  runEventLogOrphanDetection(): Promise<void>;
}> {
  const runEventLogOrphanDetection = async (): Promise<void> => {
    if (input.enqueueForAllWorkspaces === undefined || input.runAuditorTask === undefined) {
      return;
    }
    await input.enqueueForAllWorkspaces(
      GardenTaskKind.EVENT_LOG_ORPHAN_DETECTION,
      GardenTier.TIER_1
    );

    while (true) {
      const task = await input.runtimeGardenScheduler.dispatchNextMatchingTaskKind(
        GardenRole.AUDITOR,
        [GardenTaskKind.EVENT_LOG_ORPHAN_DETECTION]
      );
      input.requestBacklogTelemetryCapture("startup:event_log_orphan_detection");
      if (task === null) {
        break;
      }

      await input.runAuditorTask(task);
    }
  };

  return { runEventLogOrphanDetection };
}
