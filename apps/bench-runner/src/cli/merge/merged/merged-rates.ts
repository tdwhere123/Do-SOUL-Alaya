import { computePercentile } from "../../merge-shared.js";

interface MergedRateAggregate {
  readonly answerableTotal: number;
  readonly totalHitAt1: number;
  readonly totalHitAt5: number;
  readonly totalHitAt10: number;
  readonly evaluatedTotal: number;
  readonly perScenario: readonly { readonly latency_ms?: number }[];
  readonly latencyP50Max: number;
  readonly latencyP95Max: number;
}

export interface MergedRates {
  readonly rAt1: number;
  readonly rAt5: number;
  readonly rAt10: number;
  readonly latencyP50: number;
  readonly latencyP95: number;
  readonly hasExactMergedLatency: boolean;
}

export function buildMergedRates(aggregate: MergedRateAggregate): MergedRates {
  const n = aggregate.answerableTotal;
  const mergedLatencies = aggregate.perScenario
    .map((row) => row.latency_ms)
    .filter((latency): latency is number => latency !== undefined);
  const hasExactMergedLatency = aggregate.evaluatedTotal > 0 &&
    mergedLatencies.length === aggregate.evaluatedTotal;
  return {
    rAt1: n === 0 ? 0 : aggregate.totalHitAt1 / n,
    rAt5: n === 0 ? 0 : aggregate.totalHitAt5 / n,
    rAt10: n === 0 ? 0 : aggregate.totalHitAt10 / n,
    latencyP50: hasExactMergedLatency
      ? computePercentile(mergedLatencies, 50)
      : aggregate.latencyP50Max,
    latencyP95: hasExactMergedLatency
      ? computePercentile(mergedLatencies, 95)
      : aggregate.latencyP95Max,
    hasExactMergedLatency
  };
}
