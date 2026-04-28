import { normalizeOptionalNonEmptyString } from "./validators.js";

export const DEFAULT_ACTOR = "anonymous";
export const SYSTEM_ACTOR = "system";
export const SYSTEM_WORKSPACE_ID = SYSTEM_ACTOR;

export function resolveSystemWorkspaceId(workspaceId: string | null | undefined): string {
  return normalizeOptionalNonEmptyString(workspaceId) ?? SYSTEM_WORKSPACE_ID;
}
