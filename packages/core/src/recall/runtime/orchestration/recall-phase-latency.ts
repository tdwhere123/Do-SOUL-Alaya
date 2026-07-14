import { performance } from "node:perf_hooks";

export type TimedSpan = Readonly<{
  readonly startedAt: number;
  readonly endedAt: number;
  readonly latencyMs: number;
}>;

export type TimedResult<T> = Readonly<TimedSpan & { readonly value: T }>;

export async function measureAsync<T>(
  operation: () => Promise<T>
): Promise<TimedResult<T>> {
  const startedAt = performance.now();
  const value = await operation();
  return buildTimedResult(value, startedAt, performance.now());
}

export function measureSync<T>(operation: () => T): TimedResult<T> {
  const startedAt = performance.now();
  const value = operation();
  return buildTimedResult(value, startedAt, performance.now());
}

export function instantTimedResult<T>(value: T): TimedResult<T> {
  const at = performance.now();
  return Object.freeze({ value, startedAt: at, endedAt: at, latencyMs: 0 });
}

export function asTimedSpan<T>(result: TimedResult<T>): TimedSpan {
  return Object.freeze({
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    latencyMs: result.latencyMs
  });
}

export function sumLatencyExcluding(
  spans: readonly TimedSpan[],
  owner: TimedSpan
): number {
  return spans.reduce((sum, span) => sum + span.latencyMs - overlapMs(span, owner), 0);
}

function buildTimedResult<T>(value: T, startedAt: number, endedAt: number): TimedResult<T> {
  return Object.freeze({
    value,
    startedAt,
    endedAt,
    latencyMs: Math.max(0, endedAt - startedAt)
  });
}

function overlapMs(left: TimedSpan, right: TimedSpan): number {
  return Math.max(0, Math.min(left.endedAt, right.endedAt) - Math.max(left.startedAt, right.startedAt));
}
