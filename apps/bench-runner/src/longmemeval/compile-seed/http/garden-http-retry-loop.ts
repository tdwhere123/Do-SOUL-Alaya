import type { BenchRetryClassification } from "../compile-seed-types.js";

export interface GardenHttpRetryDecision {
  readonly classification: BenchRetryClassification;
  readonly retry: boolean;
  readonly timeoutRetries: number;
}

export interface GardenHttpRetryLoopInput<Response> {
  readonly maxRetries: number;
  readonly runAttempt: (attempt: number) => Promise<Response>;
  readonly throwIfAborted: (attempt: number, rateLimitRetries: number) => void;
  readonly isRateLimited: (error: unknown) => boolean;
  readonly decideRetry: (
    error: unknown,
    attempt: number,
    timeoutRetries: number,
    maxRetries: number
  ) => GardenHttpRetryDecision;
  readonly waitForRetry: (attempt: number, rateLimitRetries: number) => Promise<void>;
  readonly wrapFailure: (
    cause: unknown,
    classification: BenchRetryClassification,
    retryCount: number,
    rateLimitRetries: number
  ) => Error;
}

export interface GardenHttpRetryResult<Response> {
  readonly response: Response;
  readonly attempt: number;
  readonly rateLimitRetries: number;
}

export async function runGardenHttpRetryLoop<Response>(
  input: GardenHttpRetryLoopInput<Response>
): Promise<GardenHttpRetryResult<Response>> {
  let attempt = 0;
  let timeoutRetries = 0;
  let rateLimitRetries = 0;
  let lastError: unknown = null;
  let lastClassification: BenchRetryClassification = "failure_max_retries";
  while (attempt <= input.maxRetries) {
    input.throwIfAborted(attempt, rateLimitRetries);
    try {
      return { response: await input.runAttempt(attempt), attempt, rateLimitRetries };
    } catch (error) {
      lastError = error;
      if (input.isRateLimited(error)) rateLimitRetries += 1;
      const decision = input.decideRetry(error, attempt, timeoutRetries, input.maxRetries);
      lastClassification = decision.classification;
      if (!decision.retry) {
        throw input.wrapFailure(error, decision.classification, attempt, rateLimitRetries);
      }
      timeoutRetries = decision.timeoutRetries;
      await input.waitForRetry(attempt, rateLimitRetries);
      attempt += 1;
    }
  }
  throw input.wrapFailure(lastError, lastClassification, attempt, rateLimitRetries);
}
