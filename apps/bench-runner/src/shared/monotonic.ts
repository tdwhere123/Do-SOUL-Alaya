// Monotonic elapsed-time measurement for recall latency.
// process.hrtime.bigint() is non-decreasing, so an elapsed delta is always
// >= 0. Wall-clock (Date.now()) can jump backward on NTP resync/host suspend,
// producing a negative duration that fails KpiPayloadSchema's
// latency_ms / latency_ms_p50 / latency_ms_p95 nonnegative() guard.
// see also: packages/eval/src/schema/kpi-schema.ts (latency_ms* constraints).
// Date.now() is still correct for IDs and archive timestamps; only measured
// durations must use this monotonic source.

export function monotonicNowNs(): bigint {
  return process.hrtime.bigint();
}

export function monotonicElapsedMs(startNs: bigint): number {
  return Number(process.hrtime.bigint() - startNs) / 1_000_000;
}
