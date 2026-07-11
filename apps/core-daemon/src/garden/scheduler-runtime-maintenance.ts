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

const EVENT_LOG_ORPHAN_DETECTION_ITERATION_BACKOFF_MS = 250;
const EVENT_LOG_ORPHAN_DETECTION_EXTENDED_BACKOFF_MS = 2_000;
const EVENT_LOG_ORPHAN_DETECTION_CIRCUIT_THRESHOLD = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createEventLogOrphanDetectionRunner(input: Readonly<{
  readonly enqueueForAllWorkspaces?: NonNullable<
    CreateGardenSchedulerRuntimeSupportInput["enqueueForAllWorkspaces"]
  >;
  readonly requestBacklogTelemetryCapture: (reason: string) => void;
  readonly runAuditorTask?: (task: Readonly<GardenTaskDescriptor>) => Promise<void>;
  readonly runtimeGardenScheduler: CreateGardenSchedulerRuntimeSupportInput["runtimeGardenScheduler"];
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
}>): Readonly<{
  runEventLogOrphanDetection(): Promise<void>;
}> {
  const warn =
    input.warn ??
    ((_message: string, _meta: Record<string, unknown>): void => {});

  const runEventLogOrphanDetection = async (): Promise<void> => {
    if (input.enqueueForAllWorkspaces === undefined || input.runAuditorTask === undefined) {
      return;
    }
    await input.enqueueForAllWorkspaces(
      GardenTaskKind.EVENT_LOG_ORPHAN_DETECTION,
      GardenTier.TIER_1
    );

    let consecutiveFailures = 0;

    while (true) {
      try {
        const task = await input.runtimeGardenScheduler.dispatchNextMatchingTaskKind(
          GardenRole.AUDITOR,
          [GardenTaskKind.EVENT_LOG_ORPHAN_DETECTION]
        );
        input.requestBacklogTelemetryCapture("startup:event_log_orphan_detection");
        if (task === null) {
          break;
        }

        await input.runAuditorTask(task);
        consecutiveFailures = 0;
      } catch (error) {
        consecutiveFailures += 1;
        const backoffMs =
          consecutiveFailures >= EVENT_LOG_ORPHAN_DETECTION_CIRCUIT_THRESHOLD
            ? EVENT_LOG_ORPHAN_DETECTION_EXTENDED_BACKOFF_MS
            : EVENT_LOG_ORPHAN_DETECTION_ITERATION_BACKOFF_MS;
        warn("event log orphan detection iteration failed; continuing after backoff", {
          error: error instanceof Error ? error.message : String(error),
          backoff_ms: backoffMs,
          consecutive_failures: consecutiveFailures
        });
        await sleep(backoffMs);
      }
    }
  };

  return { runEventLogOrphanDetection };
}
