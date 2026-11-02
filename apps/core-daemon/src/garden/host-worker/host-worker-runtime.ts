import type { EventPublisher } from "@do-soul/alaya-core";
import type { GardenComputeProvider } from "@do-soul/alaya-soul";
import type { RuntimeGardenComputeConfig } from "@do-soul/alaya-protocol";
import type { SqliteGardenTaskRepo } from "@do-soul/alaya-storage";
import { createStatementSessionTaskProcessor } from "./statement-session-task-processor.js";
import {
  createGardenClaimReclaimer,
  createHostWorkerTaskExpirer
} from "./host-worker-task-maintenance.js";
import type { PostTurnSignalReceiver } from "../post-turn-extract/signal-receiver.js";
import type { HostSessionCapture } from "../host-session/host-session-capture.js";

export interface HostWorkerTaskRuntimeSupport {
  processStatementSessionTask(): Promise<void>;
  reclaimAbandonedGardenClaims(): Promise<void>;
  expireUnclaimedHostWorkerTasks(): Promise<void>;
}

export function createHostWorkerTaskRuntimeSupport(input: Readonly<{
  readonly now: () => string;
  readonly gardenTaskRepo?: SqliteGardenTaskRepo;
  readonly configService?: {
    getRuntimeGardenComputeConfig(): Promise<RuntimeGardenComputeConfig>;
  };
  readonly eventPublisher: EventPublisher;
  readonly localHeuristicsProvider?: GardenComputeProvider;
  readonly officialApiGardenProvider?: GardenComputeProvider | null;
  readonly signalReceiver?: PostTurnSignalReceiver;
  readonly hostSessionCapture?: HostSessionCapture;
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
}>): HostWorkerTaskRuntimeSupport {
  const processStatementSessionTask = createStatementSessionTaskProcessor(input);
  const reclaimAbandonedGardenClaims = createGardenClaimReclaimer(input);
  const expireUnclaimedHostWorkerTasks = createHostWorkerTaskExpirer(input);

  return {
    processStatementSessionTask,
    reclaimAbandonedGardenClaims,
    expireUnclaimedHostWorkerTasks
  };
}
