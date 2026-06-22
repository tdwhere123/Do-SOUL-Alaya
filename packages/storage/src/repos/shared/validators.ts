import { StorageError } from "../../shared/errors.js";

// surface://segment(/segment)* — mirrors core/shared/surface-uri.ts; rejects
// empty paths, bare/duplicated slashes, colons, and control chars.
const SURFACE_URI_PATTERN = /^surface:\/\/[\w.-]+(?:\/[\w.-]+)*$/;
export const DEFAULT_REPO_LIST_PAGE_LIMIT = 500;
export const MAX_REPO_LIST_PAGE_LIMIT = 500;

export function parseNonEmptyString(value: string, field: string): string {
  if (value.trim().length === 0) {
    throw new StorageError("VALIDATION_FAILED", `Failed to validate ${field}.`);
  }

  return value;
}

export function parseSurfaceUri(value: string, field: string): string {
  const parsed = parseNonEmptyString(value, field);

  if (!SURFACE_URI_PATTERN.test(parsed)) {
    throw new StorageError("VALIDATION_FAILED", `Failed to validate ${field}.`);
  }

  return parsed;
}

export function parseNullableString(value: string | null, field: string): string | null {
  if (value === null) {
    return null;
  }

  return parseNonEmptyString(value, field);
}

export function parseTimestamp(value: string): string {
  return parseNonEmptyString(value, "timestamp");
}

export function parsePageLimit(
  value: number,
  field = "page limit",
  max = MAX_REPO_LIST_PAGE_LIMIT
): number {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new StorageError("VALIDATION_FAILED", `Failed to validate ${field}.`);
  }

  return value;
}

export function parsePageOffset(value: number, field = "page offset"): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new StorageError("VALIDATION_FAILED", `Failed to validate ${field}.`);
  }

  return value;
}
