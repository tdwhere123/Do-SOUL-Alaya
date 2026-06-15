export type StorageErrorCode =
  | "DATABASE_OPEN_FAILED"
  | "MIGRATION_NOT_FOUND"
  | "MIGRATION_FAILED"
  | "QUERY_FAILED"
  | "VALIDATION_FAILED"
  | "CONFLICT"
  | "NOT_FOUND"
  // Surfaces a UNIQUE-constraint collision so callers can branch on a
  // structured code rather than string-matching sqlite driver messages.
  | "DUPLICATE_KEY";

export class StorageError extends Error {
  public readonly code: StorageErrorCode;

  public constructor(code: StorageErrorCode, message: string, options?: ErrorOptions);
  public constructor(code: StorageErrorCode, message: string, cause?: unknown);
  public constructor(
    code: StorageErrorCode,
    message: string,
    optionsOrCause?: ErrorOptions | unknown
  ) {
    const options = normalizeStorageErrorOptions(optionsOrCause);
    super(message, options);
    this.name = "StorageError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function normalizeStorageErrorOptions(optionsOrCause: ErrorOptions | unknown): ErrorOptions | undefined {
  if (optionsOrCause === undefined) {
    return undefined;
  }

  if (isPlainErrorOptions(optionsOrCause)) {
    return optionsOrCause;
  }

  return { cause: optionsOrCause };
}

function isPlainErrorOptions(value: unknown): value is ErrorOptions {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  if (!Object.prototype.hasOwnProperty.call(value, "cause")) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
