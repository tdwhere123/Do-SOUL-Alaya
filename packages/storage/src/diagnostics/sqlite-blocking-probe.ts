import { performance } from "node:perf_hooks";

export interface SqliteBlockingProbeResult {
  readonly syncWorkDurationMs: number;
  readonly baselineReadP99Ms: number;
  readonly interleavedReadP99Ms: number;
  readonly interleavedReadSamplesMs: readonly number[];
  readonly blockingRatioP99: number;
}

function percentileP99(samples: readonly number[]): number {
  if (samples.length === 0) {
    return 0;
  }
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[sorted.length - 1] ?? 0;
}

export function measureSqliteBlockingOnEventLoop(input: {
  readonly runSyncWork: () => void;
  readonly runInterleavedRead: () => void;
  readonly sampleCount?: number;
}): SqliteBlockingProbeResult {
  const sampleCount = input.sampleCount ?? 32;
  const baselineSamples: number[] = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const start = performance.now();
    input.runInterleavedRead();
    baselineSamples.push(performance.now() - start);
  }

  const interleavedSamples: number[] = [];
  const syncStart = performance.now();
  input.runSyncWork();
  while (interleavedSamples.length < sampleCount) {
    const readStart = performance.now();
    input.runInterleavedRead();
    interleavedSamples.push(performance.now() - readStart);
  }
  const syncWorkDurationMs = performance.now() - syncStart;

  const baselineReadP99Ms = percentileP99(baselineSamples);
  const interleavedReadP99Ms = percentileP99(interleavedSamples);
  const blockingRatioP99 =
    baselineReadP99Ms > 0 ? interleavedReadP99Ms / baselineReadP99Ms : Number.POSITIVE_INFINITY;

  return {
    syncWorkDurationMs,
    baselineReadP99Ms,
    interleavedReadP99Ms,
    interleavedReadSamplesMs: interleavedSamples,
    blockingRatioP99
  };
}
