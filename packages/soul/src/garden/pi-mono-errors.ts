import { AlayaError } from "@do-soul/alaya-protocol";

export type SignalExtractorErrorKind = "timeout" | "transport_failure" | "invalid_json";

export class SignalExtractorError extends AlayaError {
  // Retry metadata is an opaque receipt from the transport port. Soul does
  // not define or infer the provider retry vocabulary.
  public readonly kind: SignalExtractorErrorKind;
  public readonly retryCount: number;
  public readonly retryClassification: string;

  public constructor(
    kind: SignalExtractorErrorKind,
    message: string,
    options?: {
      readonly cause?: unknown;
      readonly retryCount?: number;
      readonly retryClassification?: string;
    }
  ) {
    super(kind, message, options);
    this.name = "SignalExtractorError";
    this.kind = kind;
    this.retryCount = options?.retryCount ?? 0;
    this.retryClassification = options?.retryClassification ?? "failure_consumer";
  }
}
