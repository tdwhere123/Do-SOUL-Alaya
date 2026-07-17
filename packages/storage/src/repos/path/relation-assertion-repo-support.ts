import { StorageError } from "../../shared/errors.js";

export function parseRelationAssertionJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", `Invalid ${label} JSON.`, error);
  }
}

export function parseRelationAssertionJsonArray(value: string, label: string): readonly unknown[] {
  const parsed = parseRelationAssertionJson(value, label);
  if (!Array.isArray(parsed)) {
    throw new StorageError("VALIDATION_FAILED", `Invalid ${label} array.`);
  }
  return parsed;
}

export function requireUniqueRelationAssertionEvidenceIds(
  evidenceIds: readonly string[]
): readonly string[] {
  if (new Set(evidenceIds).size !== evidenceIds.length) {
    throw new StorageError("VALIDATION_FAILED", "Relation assertion evidence ids must be unique.");
  }
  return evidenceIds;
}

export function wrapRelationAssertionStorageError(operation: string, error: unknown): StorageError {
  return new StorageError("QUERY_FAILED", `Failed to ${operation}.`, error);
}
