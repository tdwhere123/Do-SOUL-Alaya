export type StorageErrorCode =
  | "DATABASE_OPEN_FAILED"
  | "MIGRATION_NOT_FOUND"
  | "MIGRATION_FAILED"
  | "QUERY_FAILED"
  | "VALIDATION_FAILED"
  | "CONFLICT"
  | "NOT_FOUND"
  // gate-6-delta I3/N3: surfaces a UNIQUE-constraint collision so
  // callers (e.g. WorkspaceService.ensureLocalWorkspace) can branch on
  // a structured code rather than string-matching the underlying
  // sqlite driver message.
  | "DUPLICATE_KEY";

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
