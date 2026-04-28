import { CoreError } from "../errors.js";

export function normalizeOptionalNonEmptyString(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed;
}

export function parseObjectId(value: string, context = "object_id"): string {
  if (value.trim().length === 0) {
    throw new CoreError("VALIDATION", `${context} is required`);
  }

  return value;
}

export function parseNonEmptyString(value: string, field: string): string {
  if (value.trim().length === 0) {
    throw new CoreError("VALIDATION", `${field} is required`);
  }

  return value;
}
