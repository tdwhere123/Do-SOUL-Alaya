import { StorageError } from "../../shared/errors.js";

const SURFACE_URI_PATTERN = /^surface:\/\/[\w\-.:/]+$/;

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
