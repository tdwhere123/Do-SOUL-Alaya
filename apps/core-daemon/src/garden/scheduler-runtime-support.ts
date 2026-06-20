import {
  GardenRole,
  GardenTaskKind,
  isPathActiveForRecall
} from "@do-soul/alaya-protocol";
import {
  AuditorSchedulingAdvisor as CoreAuditorSchedulingAdvisor,
  createVerificationBiasReaderFromPathLookup,
  type AuditorSchedulingAdvisor
} from "@do-soul/alaya-core";
import { createEdgeProposalMaintenance } from "./scheduler-edge-proposals.js";
import {
  createConsolidationCycleRunner,
  createEmbeddingBackfillRuntimeSupport,
  createEventLogOrphanDetectionRunner,
  createPathPlasticityRuntimeSupport
} from "./scheduler-runtime-maintenance.js";
import { createPathGraphSnapshotTaskRunner } from "./scheduler-path-graph.js";
import type {
  CreateGardenSchedulerRuntimeSupportInput,
  GardenSchedulerRuntimeSupport
} from "./scheduler-runtime-types.js";

export type {
  CreateGardenSchedulerRuntimeSupportInput,
  EmbeddingBackfillTaskOutcome,
  GardenSchedulerRuntimeSupport,
  RuntimeGardenScheduler
} from "./scheduler-runtime-types.js";

export function createGardenSchedulerRuntimeSupport(
  input: CreateGardenSchedulerRuntimeSupportInput
): GardenSchedulerRuntimeSupport {
  const auditorSchedulingAdvisor: AuditorSchedulingAdvisor = new CoreAuditorSchedulingAdvisor({
    verificationBiasReader: createVerificationBiasReaderFromPathLookup({
      findActiveByAnchorObjectIds: async (workspaceId, memoryObjectIds) => {
        if (memoryObjectIds.length === 0) {
          return [];
        }
        const anchors = memoryObjectIds.map((objectId) => ({
          kind: "object" as const,
          object_id: objectId
        }));
        const paths = await input.pathRelationRepo.findByAnchors(workspaceId, anchors);
        return paths.filter((path) => isPathActiveForRecall(path.lifecycle.status));
      }
    })
  });
  const pathPlasticityRuntime = createPathPlasticityRuntimeSupport(input);
  const embeddingBackfillRuntime = createEmbeddingBackfillRuntimeSupport(input);
  const consolidationRuntime = createConsolidationCycleRunner(input);
  const runPathGraphSnapshotTask = createPathGraphSnapshotTaskRunner(input);
  const { reconcileStuckEdgeProposalAccepts, sweepExpiredEdgeProposals } =
    createEdgeProposalMaintenance(input);
  const orphanDetectionRuntime = createEventLogOrphanDetectionRunner({
    enqueueForAllWorkspaces: input.enqueueForAllWorkspaces,
    requestBacklogTelemetryCapture: input.requestBacklogTelemetryCapture,
    runAuditorTask: input.runAuditorTask,
    runtimeGardenScheduler: input.runtimeGardenScheduler
  });

  return {
    auditorSchedulingAdvisor,
    markPathPlasticityProcessed: pathPlasticityRuntime.markPathPlasticityProcessed,
    pathPlasticityPendingPort: pathPlasticityRuntime.pathPlasticityPendingPort,
    enqueueEmbeddingBackfillForAllWorkspaces:
      embeddingBackfillRuntime.enqueueEmbeddingBackfillForAllWorkspaces,
    enqueuePathPlasticityForAllWorkspaces:
      pathPlasticityRuntime.enqueuePathPlasticityForAllWorkspaces,
    runPathGraphSnapshotTask,
    runEmbeddingBackfillTask: embeddingBackfillRuntime.runEmbeddingBackfillTask,
    runConsolidationCycleTask: consolidationRuntime.runConsolidationCycleTask,
    reconcileStuckEdgeProposalAccepts,
    sweepExpiredEdgeProposals,
    runEventLogOrphanDetection: orphanDetectionRuntime.runEventLogOrphanDetection,
    runEmbeddingBackfillPass: embeddingBackfillRuntime.runEmbeddingBackfillPass
  };
}
