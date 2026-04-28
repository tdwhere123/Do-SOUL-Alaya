export type StorageErrorCode =
  | "DATABASE_OPEN_FAILED"
  | "MIGRATION_NOT_FOUND"
  | "MIGRATION_FAILED"
  | "QUERY_FAILED"
  | "VALIDATION_FAILED"
  | "CONFLICT"
  | "NOT_FOUND";

export class StorageError extends Error {
  public readonly code: StorageErrorCode;
  public override readonly cause: unknown;

  public constructor(code: StorageErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "StorageError";
    this.code = code;
    this.cause = cause;
  }
}
