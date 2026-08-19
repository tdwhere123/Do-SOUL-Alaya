import { isRetryableProviderHttpStatus } from "@do-soul/alaya-engine-gateway";
import type { BenchRetryClassification } from "../compile-seed-types.js";
import {
  readGardenHttpFailureHttpStatus,
  readGardenHttpFailureKind
} from "./garden-http-failure-attempt.js";

export type BenchHttpError = {
  readonly classification: BenchRetryClassification;
  readonly retryable: boolean;
};

export function classifyBenchHttpError(
  error: unknown,
  status: number | null
): BenchHttpError {
  const kind = readGardenHttpFailureKind(error);
  if (kind === "aborted") {
    return { classification: "failure_aborted", retryable: false };
  }
  if (kind === "response_parse_error" || kind === "empty_response") {
    return { classification: "failure_non_retryable_response", retryable: false };
  }
  if (status !== null && isRetryableProviderHttpStatus(status)) {
    return { classification: "failure_max_retries", retryable: true };
  }
  // A known HTTP status outside 429/5xx is terminal; dropping it must not fail-open.
  if (status !== null || kind === "http_error") {
    return { classification: "failure_non_retryable_4xx", retryable: false };
  }
  return { classification: "failure_max_retries", retryable: true };
}

export function readStatusFromBenchError(error: unknown): number | null {
  return readGardenHttpFailureHttpStatus(error);
}
