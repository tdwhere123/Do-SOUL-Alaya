export type CoreErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "OBLIGATION_VIOLATION";

export class CoreError extends Error {
  public readonly code: CoreErrorCode;

  public constructor(code: CoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CoreError";
    this.code = code;
  }
}
