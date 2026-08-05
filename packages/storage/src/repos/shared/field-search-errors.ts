import { StorageError } from "../../shared/errors.js";

export function toFieldSearchStorageError(
  error: unknown,
  message: string
): StorageError {
  if (error instanceof StorageError) return error;
  return new StorageError(
    error instanceof RangeError ? "VALIDATION_FAILED" : "QUERY_FAILED",
    message,
    error
  );
}
