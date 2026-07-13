import { StorageError } from "../../shared/errors.js";
import { parseClaimRequest } from "./garden-task-claim-request.js";
import { GardenTaskClaimCasMiss } from "./garden-task-errors.js";
import type { GardenTaskSqliteStatement } from "./garden-task-statements.js";
import type {
  GardenTaskClaimResult,
  GardenTaskEventInput,
  GardenTaskEventPublisherPort
} from "./garden-task-types.js";

export async function claimGardenTaskWithEvents(
  eventPublisher: GardenTaskEventPublisherPort,
  statement: GardenTaskSqliteStatement,
  taskId: string,
  claimedBy: string,
  claimedAt: string,
  dispatchedEvents: readonly GardenTaskEventInput[],
  workspaceId?: string
): Promise<GardenTaskClaimResult> {
  const request = parseClaimRequest(taskId, claimedBy, claimedAt, workspaceId);
  try {
    if (dispatchedEvents.length === 0) return runClaim(statement, request);
    return await eventPublisher.appendManyWithMutation(dispatchedEvents, () => {
      const result = runClaim(statement, request);
      if (result !== "claimed") throw new GardenTaskClaimCasMiss();
      return result;
    });
  } catch (error) {
    if (error instanceof GardenTaskClaimCasMiss) return "already-claimed";
    if (error instanceof StorageError) throw error;
    throw new StorageError(
      "QUERY_FAILED",
      `Failed to atomically claim Garden task ${request.taskId}.`,
      error
    );
  }
}

function runClaim(
  statement: GardenTaskSqliteStatement,
  request: ReturnType<typeof parseClaimRequest>
): GardenTaskClaimResult {
  const update = statement.run(
    request.claimedBy,
    request.claimedAt,
    request.taskId,
    request.workspaceId,
    request.workspaceId
  );
  return update.changes === 1 ? "claimed" : "already-claimed";
}
