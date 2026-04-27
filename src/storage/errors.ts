export type StorageErrorCode =
  | "VALIDATION_FAILED"
  | "QUERY_FAILED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "MIGRATION_FAILED";

export class StorageError extends Error {
  public constructor(
    public readonly code: StorageErrorCode,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "StorageError";
  }
}
