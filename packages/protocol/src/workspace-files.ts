export const DEFAULT_WORKSPACE_GIT_LOG_LIMIT = 20;
export const MAX_WORKSPACE_GIT_LOG_LIMIT = 100;

export function parseWorkspaceGitLogLimit(value: number | string | undefined): number {
  if (value === undefined) {
    return DEFAULT_WORKSPACE_GIT_LOG_LIMIT;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new RangeError(
        `limit must be an integer between 1 and ${MAX_WORKSPACE_GIT_LOG_LIMIT}`
      );
    }

    value = Number(trimmed);
  }

  if (!Number.isInteger(value) || value < 1 || value > MAX_WORKSPACE_GIT_LOG_LIMIT) {
    throw new RangeError(`limit must be an integer between 1 and ${MAX_WORKSPACE_GIT_LOG_LIMIT}`);
  }

  return value;
}
