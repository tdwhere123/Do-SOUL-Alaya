export const BENCH_HTTP_MAX_RETRIES = 3;
export const BENCH_HTTP_MAX_TIMEOUT_RETRIES = 1;
export const BENCH_HTTP_MAX_RESPONSE_SCHEMA_RETRIES = 2;

const BENCH_HTTP_JITTER_BASE_MS = 250;
const BENCH_HTTP_JITTER_MAX_MS = 1500;

export const EXTRACTION_HTTP_MAX_RETRY_JITTER_MS = Array.from(
  { length: BENCH_HTTP_MAX_RETRIES },
  (_, attempt) => gardenHttpJitterUpperBoundMs(attempt)
).reduce((total, delay) => total + delay, 0);

export function computeGardenHttpJitterMs(
  attempt: number,
  random: () => number
): number {
  const baseMs = Math.min(
    BENCH_HTTP_JITTER_BASE_MS * Math.max(1, 2 ** Math.max(0, attempt)),
    BENCH_HTTP_JITTER_MAX_MS
  );
  const upper = gardenHttpJitterUpperBoundMs(attempt);
  const span = upper - baseMs;
  return baseMs + Math.floor(random() * (span + 1));
}

function gardenHttpJitterUpperBoundMs(attempt: number): number {
  return Math.min(
    BENCH_HTTP_JITTER_BASE_MS * Math.max(1, 2 ** Math.max(0, attempt + 1)),
    BENCH_HTTP_JITTER_MAX_MS
  );
}
