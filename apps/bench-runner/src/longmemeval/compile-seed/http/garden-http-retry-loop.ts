import type {
  BenchRetryClassification,
  BenchTransportFailureAttempt
} from "../compile-seed-types.js";

export interface GardenHttpRetryDecision {
  readonly classification: BenchRetryClassification;
  readonly retry: boolean;
  readonly timeoutRetries: number;
}

export interface GardenHttpRetryLoopInput<Response> {
  readonly maxRetries: number;
  /** Authority/abort gate. Rejections are not transport failures and propagate unchanged. */
  readonly beforeAttempt: (attempt: number, rateLimitRetries: number) => Promise<void>;
  readonly runAttempt: (attempt: number) => Promise<Response>;
  readonly isRateLimited: (error: unknown) => boolean;
  readonly decideRetry: (
    error: unknown,
    attempt: number,
    timeoutRetries: number,
    maxRetries: number
  ) => GardenHttpRetryDecision;
  readonly waitForRetry: (attempt: number, rateLimitRetries: number) => Promise<void>;
  readonly describeFailure: (
    error: unknown,
    attempt: number
  ) => BenchTransportFailureAttempt | undefined;
  readonly wrapFailure: (
    cause: unknown,
    classification: BenchRetryClassification,
    retryCount: number,
    rateLimitRetries: number,
    transportFailures: readonly BenchTransportFailureAttempt[]
  ) => Error;
}

export interface GardenHttpRetryResult<Response> {
  readonly response: Response;
  readonly attempt: number;
  readonly rateLimitRetries: number;
  readonly transportFailures: readonly BenchTransportFailureAttempt[];
}

export async function runGardenHttpRetryLoop<Response>(
  input: GardenHttpRetryLoopInput<Response>
): Promise<GardenHttpRetryResult<Response>> {
  let attempt = 0;
  let timeoutRetries = 0;
  let rateLimitRetries = 0;
  let lastError: unknown = null;
  let lastClassification: BenchRetryClassification = "failure_max_retries";
  const transportFailures: BenchTransportFailureAttempt[] = [];
  while (attempt <= input.maxRetries) {
    await input.beforeAttempt(attempt, rateLimitRetries);
    try {
      return {
        response: await input.runAttempt(attempt),
        attempt,
        rateLimitRetries,
        transportFailures: Object.freeze([...transportFailures])
      };
    } catch (error) {
      lastError = error;
      const failure = input.describeFailure(error, attempt);
      if (failure !== undefined) transportFailures.push(failure);
      if (input.isRateLimited(error)) rateLimitRetries += 1;
      const decision = input.decideRetry(error, attempt, timeoutRetries, input.maxRetries);
      lastClassification = decision.classification;
      if (!decision.retry) {
        throw input.wrapFailure(
          error, decision.classification, attempt, rateLimitRetries, transportFailures
        );
      }
      timeoutRetries = decision.timeoutRetries;
      try {
        await input.waitForRetry(attempt, rateLimitRetries);
      } catch (waitError) {
        const waitDecision = input.decideRetry(
          waitError, attempt, timeoutRetries, input.maxRetries
        );
        if (waitDecision.classification !== "failure_aborted") throw waitError;
        throw input.wrapFailure(
          waitError,
          waitDecision.classification,
          attempt,
          rateLimitRetries,
          transportFailures
        );
      }
      attempt += 1;
    }
  }
  throw input.wrapFailure(
    lastError, lastClassification, attempt, rateLimitRetries, transportFailures
  );
}
