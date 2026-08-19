import { providerRetryJitterUpperBoundMs } from "@do-soul/alaya-engine-gateway";

export const BENCH_HTTP_MAX_RETRIES = 3;
export const BENCH_HTTP_MAX_TIMEOUT_RETRIES = 1;
export const BENCH_HTTP_MAX_RESPONSE_SCHEMA_RETRIES = 2;

const BENCH_HTTP_JITTER_BASE_MS = 250;
const BENCH_HTTP_JITTER_MAX_MS = 1500;

export const EXTRACTION_HTTP_MAX_RETRY_JITTER_MS = Array.from(
  { length: BENCH_HTTP_MAX_RETRIES },
  (_, attempt) => gardenHttpJitterUpperBoundMs(attempt)
).reduce((total, delay) => total + delay, 0);

function gardenHttpJitterUpperBoundMs(attempt: number): number {
  return providerRetryJitterUpperBoundMs(
    attempt, BENCH_HTTP_JITTER_BASE_MS, BENCH_HTTP_JITTER_MAX_MS
  );
}
