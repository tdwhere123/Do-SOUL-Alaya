import { AlayaError, type AlayaErrorOptions } from "@do-soul/alaya-protocol";

export type StorageErrorCode =
  | "DATABASE_OPEN_FAILED"
  | "MIGRATION_NOT_FOUND"
  | "MIGRATION_FAILED"
  | "QUERY_FAILED"
  | "VALIDATION_FAILED"
  | "CONFLICT"
  | "NOT_FOUND"
  // Persisted schema version is ahead of this binary's known max; refuse to
  // operate rather than risk corrupting a newer database.
  | "STORAGE_VERSION_AHEAD"
  // Surfaces a UNIQUE-constraint collision so callers can branch on a
  // structured code rather than string-matching sqlite driver messages.
  | "DUPLICATE_KEY";

export class StorageError extends AlayaError {
  declare public readonly code: StorageErrorCode;

  public constructor(code: StorageErrorCode, message: string, options?: AlayaErrorOptions);
  public constructor(code: StorageErrorCode, message: string, cause?: unknown);
  public constructor(
    code: StorageErrorCode,
    message: string,
    optionsOrCause?: AlayaErrorOptions | unknown
  ) {
    const options = normalizeStorageErrorOptions(optionsOrCause);
    super(code, message, options);
    this.name = "StorageError";
  }
}

function normalizeStorageErrorOptions(
  optionsOrCause: AlayaErrorOptions | unknown
): AlayaErrorOptions | undefined {
  if (optionsOrCause === undefined) {
    return undefined;
  }

  if (isPlainErrorOptions(optionsOrCause)) {
    return optionsOrCause;
  }

  return { cause: optionsOrCause };
}

function isPlainErrorOptions(value: unknown): value is AlayaErrorOptions {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  if (!Object.prototype.hasOwnProperty.call(value, "cause")) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
