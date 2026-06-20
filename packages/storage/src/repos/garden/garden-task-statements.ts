import type { SqliteConnection } from "../../sqlite/db.js";
import {
  prepareGardenTaskClaimStatements,
  prepareGardenTaskCountStatements,
  prepareGardenTaskMaintenanceStatements,
  prepareGardenTaskQueueStatements,
  type GardenTaskClaimStatements,
  type GardenTaskCountStatements,
  type GardenTaskMaintenanceStatements,
  type GardenTaskQueueStatements
} from "./garden-task-statement-groups.js";

export type { GardenTaskSqliteStatement } from "./garden-task-statement-groups.js";

export interface GardenTaskStatements
  extends GardenTaskQueueStatements,
    GardenTaskClaimStatements,
    GardenTaskMaintenanceStatements,
    GardenTaskCountStatements {}

export function prepareGardenTaskStatements(connection: SqliteConnection): GardenTaskStatements {
  return {
    ...prepareGardenTaskQueueStatements(connection),
    ...prepareGardenTaskClaimStatements(connection),
    ...prepareGardenTaskMaintenanceStatements(connection),
    ...prepareGardenTaskCountStatements(connection)
  };
}
