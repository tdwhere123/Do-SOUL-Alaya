import { AlayaError, type AlayaErrorOptions } from "@do-soul/alaya-protocol";

export type CoreErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "OBLIGATION_VIOLATION";

// Finer-grained classification carried alongside the broad `code` (chiefly the
// overloaded CONFLICT). Kept as a backward-compatible side channel so existing
// `code`-based handling is unaffected, while callers that need to recover
// differently can branch on it. PORT_UNAVAILABLE = an optional capability is not
// wired (degrade); CONCURRENT_MODIFICATION = lost a race (safe to retry).
export type CoreErrorSubCode = "PORT_UNAVAILABLE" | "CONCURRENT_MODIFICATION";

export interface CoreErrorOptions extends AlayaErrorOptions {
  readonly subCode?: CoreErrorSubCode;
}

export class CoreError extends AlayaError {
  declare public readonly code: CoreErrorCode;
  public readonly subCode?: CoreErrorSubCode;

  public constructor(code: CoreErrorCode, message: string, options?: CoreErrorOptions) {
    super(code, message, options);
    this.name = "CoreError";
    this.subCode = options?.subCode;
  }
}
