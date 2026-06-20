import {
  DYNAMICS_CONSTANTS,
  type GardenTaskDescriptor
} from "@do-soul/alaya-protocol";
import {
  createBulkEnrichWorkspaceQueue,
  resolveBulkEnrichAvailability,
  type CreateBulkEnrichRuntimeSupportInput
} from "./bulk-enrich-runtime-helpers.js";
import {
  createBulkEnrichReporter,
  runBulkEnrichTask,
  runClaimableBulkEnrichWorkspacePass
} from "./bulk-enrich-runtime-runner.js";

export interface BulkEnrichRuntimeSupport {
  enqueueForAllWorkspaces(enqueuedThisPass: Set<string>): Promise<void>;
  enqueueForCountThreshold(enqueuedThisPass: Set<string>): Promise<void>;
  reclaimStaleClaims(): void;
  runClaimableWorkspacePass(workspaceId: string, maxBatches: number): Promise<void>;
  runTask(task: Readonly<GardenTaskDescriptor>): Promise<void>;
}

export function createBulkEnrichRuntimeSupport(
  input: CreateBulkEnrichRuntimeSupportInput
): BulkEnrichRuntimeSupport {
  const availability = resolveBulkEnrichAvailability(input);
  const workspaceQueue = createBulkEnrichWorkspaceQueue({
    availability,
    gardenScheduler: input.gardenScheduler,
    gardenTaskRepo: input.gardenTaskRepo,
    onTaskEnqueued: input.onTaskEnqueued,
    workspaceRepo: input.workspaceRepo
  });
  const reporter = createBulkEnrichReporter({
    eventPublisher: input.eventPublisher,
    gardenScheduler: input.gardenScheduler,
    warn: input.warn
  });

  const reclaimStaleClaims = (): void => {
    input.enrichPendingRepo?.reclaimStale(
      new Date().toISOString(),
      DYNAMICS_CONSTANTS.enrich.claim_stale_after_ms
    );
  };

  return {
    enqueueForAllWorkspaces: async (enqueuedThisPass) =>
      await workspaceQueue.enqueueForAllWorkspaces(enqueuedThisPass),
    enqueueForCountThreshold: async (enqueuedThisPass) =>
      await workspaceQueue.enqueueForCountThreshold(enqueuedThisPass),
    reclaimStaleClaims,
    runClaimableWorkspacePass: async (workspaceId, maxBatches) =>
      await runClaimableBulkEnrichWorkspacePass({
        availability,
        workspaceId,
        maxBatches,
        reporter
      }),
    runTask: async (task) =>
      await runBulkEnrichTask({
        task,
        availability,
        reporter
      })
  };
}
