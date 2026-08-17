export type ProviderTransportFailureKind =
  | "network_error"
  | "http_error"
  | "body_read_error"
  | "response_parse_error"
  | "timeout"
  | "aborted";

export class ProviderChatCompletionError extends Error {
  public readonly kind: ProviderTransportFailureKind;
  public readonly httpStatus: number | null;

  public constructor(
    message: string,
    kind: ProviderTransportFailureKind,
    httpStatus: number | null = null,
    options?: { readonly cause?: unknown }
  ) {
    super(message, options);
    this.name = "ProviderChatCompletionError";
    this.kind = kind;
    this.httpStatus = httpStatus;
    if (httpStatus !== null) {
      (this as { status?: number }).status = httpStatus;
    }
  }
}
