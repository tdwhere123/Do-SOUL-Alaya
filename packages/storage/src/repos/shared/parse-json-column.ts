import { StorageError } from "../../shared/errors.js";

export function parseJsonColumn(value: string, fieldName: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new StorageError(
      "VALIDATION_FAILED",
      `Failed to parse ${fieldName} JSON.`,
      error
    );
  }
}

export function parseNullableJsonColumn(value: string | null, fieldName: string): unknown {
  if (value === null) {
    return null;
  }
  return parseJsonColumn(value, fieldName);
}

export function parseJsonColumnWithSchema<T>(
  value: string,
  fieldName: string,
  schema: { parse(input: unknown): T }
): T {
  const parsed = parseJsonColumn(value, fieldName);
  try {
    return schema.parse(parsed);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", `Invalid ${fieldName}.`, error);
  }
}
