import { parseNonEmptyString, parseTimestamp } from "../shared/validators.js";

export interface ParsedGardenTaskClaimRequest {
  readonly taskId: string;
  readonly claimedBy: string;
  readonly claimedAt: string;
  readonly workspaceId: string | null;
}

export function parseClaimRequest(
  taskId: string,
  claimedBy: string,
  claimedAt: string,
  workspaceId: string | undefined
): ParsedGardenTaskClaimRequest {
  return {
    taskId: parseNonEmptyString(taskId, "garden_task.id"),
    claimedBy: parseNonEmptyString(claimedBy, "garden_task.claimed_by"),
    claimedAt: parseTimestamp(claimedAt),
    workspaceId:
      workspaceId === undefined
        ? null
        : parseNonEmptyString(workspaceId, "garden_task.workspace_id")
  };
}
