import { GardenEventType } from "@do-soul/alaya-protocol";
import { StorageError } from "../../shared/errors.js";
import { parseNonEmptyString, parseTimestamp } from "../shared/validators.js";
import { GardenTaskPendingFailureCasMiss } from "./garden-task-errors.js";
import type { GardenTaskSqliteStatement } from "./garden-task-statements.js";
import type {
  GardenTaskEventInput,
  GardenTaskEventPublisherPort
} from "./garden-task-types.js";

export async function failPendingGardenTaskWithCompletionEvent(
  eventPublisher: GardenTaskEventPublisherPort,
  statement: GardenTaskSqliteStatement,
  taskId: string,
  completedAt: string,
  lastErrorText: string,
  completionEvent: GardenTaskEventInput,
  precedingEvents: readonly GardenTaskEventInput[] = []
): Promise<boolean> {
  const parsedTaskId = parseNonEmptyString(taskId, "garden_task.id");
  const parsedCompletedAt = parseTimestamp(completedAt);
  const parsedError = parseNonEmptyString(lastErrorText, "garden_task.last_error_text");
  assertFailureCompletionEvent(parsedTaskId, completionEvent);

  try {
    return await eventPublisher.appendManyWithMutation([...precedingEvents, completionEvent], () => {
      const update = statement.run(parsedCompletedAt, parsedError, parsedTaskId);
      if (update.changes !== 1) throw new GardenTaskPendingFailureCasMiss();
      return true;
    });
  } catch (error) {
    if (error instanceof GardenTaskPendingFailureCasMiss) return false;
    if (error instanceof StorageError) throw error;
    throw new StorageError(
      "QUERY_FAILED",
      `Failed to atomically fail pending Garden task ${parsedTaskId}.`,
      error
    );
  }
}

function assertFailureCompletionEvent(taskId: string, event: GardenTaskEventInput): void {
  if (
    event.event_type !== GardenEventType.SOUL_GARDEN_TASK_COMPLETED ||
    event.entity_type !== "garden_task" ||
    event.entity_id !== taskId ||
    event.payload_json.task_id !== taskId ||
    event.payload_json.success !== false
  ) {
    throw new StorageError(
      "VALIDATION_FAILED",
      `Garden task ${taskId} pending failure requires its own unsuccessful completion event.`
    );
  }
}
