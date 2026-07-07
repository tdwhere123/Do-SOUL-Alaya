import type {
  EventType,
  HealthJournalRecordPort
} from "@do-soul/alaya-protocol";
import { GardenScheduler, type GardenSchedulerEventLogPort } from "@do-soul/alaya-soul";
import { SqliteGardenTaskRepo } from "@do-soul/alaya-storage";
import type { CreateGardenRuntimeInput } from "./runtime-types.js";

export function createGardenSchedulerEventLogPort(
  eventPublisher: CreateGardenRuntimeInput["eventPublisher"]
): GardenSchedulerEventLogPort {
  return {
    append: async (entry) => {
      await eventPublisher.publish({
        event_type: entry.event_type as EventType,
        entity_type: entry.entity_type,
        entity_id: entry.entity_id,
        workspace_id: entry.workspace_id,
        run_id: entry.run_id,
        caused_by: "garden-scheduler",
        payload_json: entry.payload
      });
    }
  };
}

export function createHealthJournalPort(
  healthJournalRepo: CreateGardenRuntimeInput["healthJournalRepo"]
): HealthJournalRecordPort {
  return {
    record: async (entry) => {
      void (await healthJournalRepo.append(entry));
    }
  };
}

export function createGardenTaskRepo(
  input: CreateGardenRuntimeInput
): SqliteGardenTaskRepo | undefined {
  return typeof (input.databaseConnection as { readonly prepare?: unknown }).prepare === "function"
    ? new SqliteGardenTaskRepo(input.databaseConnection, input.eventPublisher)
    : undefined;
}

export function createGardenScheduler(
  input: CreateGardenRuntimeInput,
  schedulerEventLogPort: GardenSchedulerEventLogPort,
  healthJournalPort: HealthJournalRecordPort,
  gardenTaskRepo: SqliteGardenTaskRepo | undefined,
  warn: (message: string, meta: Record<string, unknown>) => void
): GardenScheduler {
  return new GardenScheduler(
    schedulerEventLogPort,
    {
      backlogWarningThresholds: {
        warning_queue_depth: input.backlogThresholds.warning_queue_depth,
        warning_rearm_depth: input.backlogThresholds.warning_rearm_depth
      },
      warn
    },
    healthJournalPort,
    gardenTaskRepo
  );
}
