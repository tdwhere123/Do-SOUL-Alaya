import type {
  BenchRetryClassification,
  BenchTransportFailureAttempt
} from "../compile-seed-types.js";
import {
  isOutputTokenTruncation,
  markOutputTokenTruncation
} from "./output-token-retry.js";
import { aggregateGardenHttpAttemptUsage } from "./garden-http-failure-attempt.js";

export function wrapGardenHttpTransportError(
  cause: unknown,
  classification: BenchRetryClassification,
  retryCount: number,
  rateLimitRetries: number,
  transportFailures: readonly BenchTransportFailureAttempt[]
): Error {
  const message = cause instanceof Error
    ? cause.message
    : `garden extraction failed: ${String(cause)}`;
  const wrapped = new Error(message, { cause });
  const aggregate = aggregateGardenHttpAttemptUsage(transportFailures);
  (wrapped as { benchRetry?: unknown }).benchRetry = {
    retryCount,
    retryClassification: classification,
    rateLimitRetries,
    transportFailures: Object.freeze([...transportFailures]),
    successfulRequestCount: 0,
    usageRequestCount: aggregate.usageRequestCount,
    ...(aggregate.usage === undefined ? {} : { usage: aggregate.usage })
  };
  return isOutputTokenTruncation(cause)
    ? markOutputTokenTruncation(wrapped)
    : wrapped;
}
