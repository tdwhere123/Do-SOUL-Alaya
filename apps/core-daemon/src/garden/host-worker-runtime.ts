import type { EventPublisher } from "@do-soul/alaya-core";
import type { GardenComputeProvider } from "@do-soul/alaya-soul";
import type { RuntimeGardenComputeConfig } from "@do-soul/alaya-protocol";
import type { SqliteGardenTaskRepo } from "@do-soul/alaya-storage";
import { createPostTurnExtractTaskProcessor } from "./host-worker-task-processors.js";
import {
  createGardenClaimReclaimer,
  createHostWorkerTaskExpirer
} from "./host-worker-task-maintenance.js";

export interface HostWorkerTaskRuntimeSupport {
  processPostTurnExtractTask(): Promise<void>;
  reclaimAbandonedGardenClaims(): Promise<void>;
  expireUnclaimedHostWorkerTasks(): Promise<void>;
}

export function createHostWorkerTaskRuntimeSupport(input: Readonly<{
  readonly gardenTaskRepo?: SqliteGardenTaskRepo;
  readonly configService?: {
    getRuntimeGardenComputeConfig(): Promise<RuntimeGardenComputeConfig>;
  };
  readonly eventPublisher: EventPublisher;
  readonly localHeuristicsProvider?: GardenComputeProvider;
  readonly officialApiGardenProvider?: GardenComputeProvider | null;
  readonly signalReceiver?: {
    receiveSignal(
      signal: import("@do-soul/alaya-protocol").CandidateMemorySignal
    ): Promise<Readonly<{ readonly signal: Readonly<{ readonly signal_id: string }> }>>;
  };
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
}>): HostWorkerTaskRuntimeSupport {
  const processPostTurnExtractTask = createPostTurnExtractTaskProcessor(input);
  const reclaimAbandonedGardenClaims = createGardenClaimReclaimer(input);
  const expireUnclaimedHostWorkerTasks = createHostWorkerTaskExpirer(input);

  return {
    processPostTurnExtractTask,
    reclaimAbandonedGardenClaims,
    expireUnclaimedHostWorkerTasks
  };
}
