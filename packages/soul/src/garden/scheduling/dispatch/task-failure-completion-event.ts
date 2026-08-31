import {
  GARDEN_ROLE_TIER_MAP,
  GardenEventType,
  parseGardenEventPayload
} from "@do-soul/alaya-protocol";
import type { GardenTaskEventInput, GardenTaskRow } from "../scheduler-types.js";

export function buildTaskFailureCompletionEvent(
  task: Pick<GardenTaskRow, "id" | "workspace_id" | "role" | "kind">,
  occurredAt: string
): GardenTaskEventInput {
  return {
    event_type: GardenEventType.SOUL_GARDEN_TASK_COMPLETED,
    entity_type: "garden_task",
    entity_id: task.id,
    workspace_id: task.workspace_id,
    run_id: null,
    caused_by: "garden-scheduler",
    payload_json: parseGardenEventPayload(GardenEventType.SOUL_GARDEN_TASK_COMPLETED, {
      task_id: task.id,
      task_kind: task.kind,
      role: task.role,
      tier: GARDEN_ROLE_TIER_MAP[task.role],
      success: false,
      objects_affected: [],
      workspace_id: task.workspace_id,
      occurred_at: occurredAt
    })
  };
}
