import {
  emptyProviderFailureIdentity,
  type ProviderFailureIdentity
} from "./failure-identity.js";
import type { ProviderResponseInspectionReason } from "./inspect-response.js";

export type { ProviderResponseInspectionReason };

export type ProviderTransportFailureKind =
  | "network_error"
  | "http_error"
  | "body_read_error"
  | "response_parse_error"
  | "aborted";

export class ProviderChatCompletionError extends Error {
  public readonly kind: ProviderTransportFailureKind;
  public readonly httpStatus: number | null;
  public readonly inspectionReason: ProviderResponseInspectionReason | null;
  readonly #identity: ProviderFailureIdentity;

  public constructor(
    message: string,
    kind: ProviderTransportFailureKind,
    httpStatus: number | null = null,
    options?: {
      readonly cause?: unknown;
      readonly identity?: ProviderFailureIdentity;
      readonly inspectionReason?: ProviderResponseInspectionReason;
    }
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProviderChatCompletionError";
    this.kind = kind;
    this.httpStatus = httpStatus;
    this.inspectionReason = kind === "response_parse_error"
      ? options?.inspectionReason ?? "parse"
      : null;
    this.#identity = options?.identity ?? emptyProviderFailureIdentity();
    // Abort keeps httpStatus for diagnostics; enumerable .status would let
    // status-first retry treat hanging 429/5xx as retryable HTTP.
    if (kind === "http_error" && httpStatus !== null) {
      (this as { status?: number }).status = httpStatus;
    }
  }

  public get providerCode(): string | null {
    return this.#identity.providerCode;
  }

  public get providerType(): string | null {
    return this.#identity.providerType;
  }

  public get bodyDigest(): string | null {
    return this.#identity.bodyDigest;
  }
}
