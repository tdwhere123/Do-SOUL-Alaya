import type {
  BenchRetryClassification,
  BenchTransportFailureAttempt
} from "../compile-seed-types.js";

export interface GardenHttpRetryDecision {
  readonly classification: BenchRetryClassification;
  readonly retry: boolean;
  readonly counters: GardenHttpRetryCounters;
}

export interface GardenHttpRetryCounters {
  readonly timeoutRetries: number;
  readonly responseSchemaRetries: number;
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
    counters: GardenHttpRetryCounters,
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

interface GardenHttpRetryState {
  readonly attempt: number;
  readonly counters: GardenHttpRetryCounters;
  readonly rateLimitRetries: number;
  readonly classification: BenchRetryClassification;
  readonly transportFailures: readonly BenchTransportFailureAttempt[];
}

export async function runGardenHttpRetryLoop<Response>(
  input: GardenHttpRetryLoopInput<Response>
): Promise<GardenHttpRetryResult<Response>> {
  return runRetryAttempt(input, {
    attempt: 0,
    counters: { timeoutRetries: 0, responseSchemaRetries: 0 },
    rateLimitRetries: 0,
    classification: "failure_max_retries",
    transportFailures: []
  });
}

async function runRetryAttempt<Response>(
  input: GardenHttpRetryLoopInput<Response>,
  state: GardenHttpRetryState
): Promise<GardenHttpRetryResult<Response>> {
  await runBeforeAttempt(input, state);
  try {
    return {
      response: await input.runAttempt(state.attempt),
      attempt: state.attempt,
      rateLimitRetries: state.rateLimitRetries,
      transportFailures: Object.freeze([...state.transportFailures])
    };
  } catch (error) {
    const failure = input.describeFailure(error, state.attempt);
    const transportFailures = failure === undefined
      ? state.transportFailures
      : [...state.transportFailures, failure];
    const rateLimitRetries = state.rateLimitRetries + (input.isRateLimited(error) ? 1 : 0);
    const decision = input.decideRetry(
      error, state.attempt, state.counters, input.maxRetries
    );
    if (!decision.retry) {
      throw input.wrapFailure(
        error, decision.classification, state.attempt, rateLimitRetries, transportFailures
      );
    }
    await waitForRetry(input, state, decision.counters, rateLimitRetries, transportFailures);
    return runRetryAttempt(input, {
      attempt: state.attempt + 1,
      counters: decision.counters,
      rateLimitRetries,
      classification: decision.classification,
      transportFailures
    });
  }
}

async function runBeforeAttempt<Response>(
  input: GardenHttpRetryLoopInput<Response>,
  state: GardenHttpRetryState
): Promise<void> {
  try {
    await input.beforeAttempt(state.attempt, state.rateLimitRetries);
  } catch (cause) {
    if (state.attempt === 0) throw cause;
    throw input.wrapFailure(
      cause,
      state.classification,
      state.attempt - 1,
      state.rateLimitRetries,
      state.transportFailures
    );
  }
}

async function waitForRetry<Response>(
  input: GardenHttpRetryLoopInput<Response>,
  state: GardenHttpRetryState,
  counters: GardenHttpRetryCounters,
  rateLimitRetries: number,
  transportFailures: readonly BenchTransportFailureAttempt[]
): Promise<void> {
  try {
    await input.waitForRetry(state.attempt, rateLimitRetries);
  } catch (cause) {
    const decision = input.decideRetry(cause, state.attempt, counters, input.maxRetries);
    if (decision.classification !== "failure_aborted") throw cause;
    throw input.wrapFailure(
      cause, decision.classification, state.attempt, rateLimitRetries, transportFailures
    );
  }
}
