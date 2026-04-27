import { StorageError } from "./errors.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonArray = readonly JsonValue[];
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

export function stringifyJson(value: JsonValue, fieldName: string): string {
  try {
    return JSON.stringify(value);
  } catch (error) {
    throw new StorageError(
      "VALIDATION_FAILED",
      `Failed to serialize ${fieldName} as JSON.`,
      error
    );
  }
}

export function parseJsonField(value: unknown, fieldName: string): JsonValue {
  if (typeof value !== "string") {
    throw new StorageError(
      "VALIDATION_FAILED",
      `Expected ${fieldName} to be stored as a JSON string.`
    );
  }

  try {
    return JSON.parse(value) as JsonValue;
  } catch (error) {
    throw new StorageError(
      "VALIDATION_FAILED",
      `Failed to parse ${fieldName} JSON.`,
      error
    );
  }
}
