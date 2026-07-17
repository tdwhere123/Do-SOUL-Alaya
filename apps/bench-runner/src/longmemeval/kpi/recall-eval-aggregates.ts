import {
  aggregateEdgeProposalAutoAccept,
  aggregateEdgeProposalRate,
  buildTokenEconomy,
  computeTokenSavedRatio
} from "@do-soul/alaya-eval";
import { aggregateBenchTokenMetrics, assertBenchTokenEconomyContract } from "../../harness/token/token-economy.js";
import { aggregateRecallTokenEconomy } from "../qa/recall-token-economy.js";
import type { RecallEvalAccumulator } from "./recall-eval-accumulator.js";

export interface RecallEvalAggregates {
  readonly rAt1: number;
  readonly rAt5: number;
  readonly rAt10: number;
  readonly latencyP50: number;
  readonly latencyP95: number;
  readonly tokenEconomy: ReturnType<typeof buildTokenEconomy>;
  readonly tokenSavedRatio: number;
  readonly recallTokenEconomy: ReturnType<typeof aggregateRecallTokenEconomy>;
  readonly edgeProposalRate: ReturnType<typeof aggregateEdgeProposalRate>;
  readonly edgeProposalAutoAccept: ReturnType<typeof aggregateEdgeProposalAutoAccept>;
}

export function computeRecallEvalAggregates(
  accumulator: RecallEvalAccumulator
): RecallEvalAggregates {
  const n = accumulator.answerableCount;
  const scorableRows = accumulator.perScenario.filter((row) => row.scorable === true);
  const tokenInput = aggregateBenchTokenMetrics(accumulator.tokenMetricsPerQuestion);
  assertBenchTokenEconomyContract("public", tokenInput);
  return {
    rAt1: n === 0 ? 0 : accumulator.totalHitAt1 / n,
    rAt5: n === 0 ? 0 : scorableRows.filter((row) => row.hit_at_5).length / n,
    rAt10: n === 0 ? 0 : accumulator.totalHitAt10 / n,
    latencyP50: percentile(accumulator.latencies, 50),
    latencyP95: percentile(accumulator.latencies, 95),
    tokenEconomy: buildTokenEconomy(tokenInput),
    tokenSavedRatio: computeTokenSavedRatio(tokenInput),
    recallTokenEconomy: aggregateRecallTokenEconomy(accumulator.recallTokenEconomySamples),
    edgeProposalRate: aggregateEdgeProposalRate(
      accumulator.edgeProposalRowsAcross,
      accumulator.edgeProposalRowsPerQuestion
    ),
    edgeProposalAutoAccept: aggregateEdgeProposalAutoAccept(accumulator.edgeProposalRowsAcross)
  };
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)] ?? 0;
}
