export type SignalExtractorErrorKind = "timeout" | "transport_failure" | "invalid_json";

// invariant: a closed enum so the bench / dump consumers (compute-provider
// dumpInvalidResponseDiagnostic, compile-seed dumpSeedExtractionFailureDiagnostic,
// seed-extraction-blocker) can branch on the terminal outcome without
// re-deriving it from retryCount + kind.
// see also: apps/bench-runner/src/longmemeval/compile-seed.ts
//   createGardenHttpExtractor mirrors this classification for the bench HTTP
//   transport that does not go through this file.
export type RetryClassification =
  | "success_first_try"
  | "success_after_retry"
  | "failure_max_retries"
  | "failure_non_retryable_4xx"
  | "failure_timeout"
  | "failure_aborted";

export class SignalExtractorError extends Error {
  // invariant: retryCount on the thrown error reflects the attempt index at
  // the moment the failure escaped (0 = first attempt threw and was not
  // retried, e.g. a 4xx auth fail; N = first attempt failed, retried N
  // times, all attempts still failed). retryClassification labels which
  // branch of the retry policy terminated.
  public readonly retryCount: number;
  public readonly retryClassification: RetryClassification;
  public constructor(
    public readonly kind: SignalExtractorErrorKind,
    message: string,
    options?: {
      readonly cause?: unknown;
      readonly retryCount?: number;
      readonly retryClassification?: RetryClassification;
    }
  ) {
    super(message, options);
    this.name = "SignalExtractorError";
    this.retryCount = options?.retryCount ?? 0;
    this.retryClassification = options?.retryClassification ?? "failure_max_retries";
  }
}
