export interface AlayaErrorOptions extends ErrorOptions {
  readonly statusCode?: number;
}

/**
 * Shared error base so consumers can catch across package boundaries with
 * `instanceof AlayaError` without depending on each package's leaf class.
 */
export class AlayaError extends Error {
  public readonly code: string;
  public readonly statusCode?: number;

  public constructor(code: string, message: string, options?: AlayaErrorOptions) {
    super(message, options);
    this.name = "AlayaError";
    this.code = code;
    this.statusCode = options?.statusCode;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** A durable object exists even though a later side effect failed. */
export class CommittedObjectError extends AlayaError {
  public constructor(
    message: string,
    public readonly object: Readonly<{ object_kind: string; object_id: string }>,
    options?: ErrorOptions
  ) {
    super("COMMITTED_OBJECT_SIDE_EFFECT_FAILED", message, options);
    this.name = "CommittedObjectError";
  }
}
