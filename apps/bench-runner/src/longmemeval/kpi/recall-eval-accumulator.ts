import type { EdgeProposalKpiEventRow, PerScenarioRow } from "@do-soul/alaya-eval";
import type { BenchTokenMetrics } from "../../harness/daemon.js";
import type { BenchRecallTokenEconomy } from "../../harness/recall-diagnostics-schema.js";
import type { LongMemEvalQuestionDiagnostic } from "../diagnostics.js";
import type { RecallEvalQuestionResult } from "../recall-eval.js";
import {
  classifyQuestionMeasurementCohort,
  classifyQuestionMeasurementStatus
} from "../measurement/question-validity.js";

export interface RecallEvalAccumulator {
  readonly perScenario: PerScenarioRow[];
  readonly latencies: number[];
  readonly questionDiagnostics: LongMemEvalQuestionDiagnostic[];
  readonly tokenMetricsPerQuestion: BenchTokenMetrics[];
  readonly recallTokenEconomySamples: BenchRecallTokenEconomy[];
  readonly edgeProposalRowsAcross: EdgeProposalKpiEventRow[];
  readonly edgeProposalRowsPerQuestion: EdgeProposalKpiEventRow[][];
  tierHot: number;
  tierWarm: number;
  tierCold: number;
  degradeNone: number;
  degradeWarm: number;
  degradeCold: number;
  degradePartial: number;
  totalHitAt1: number;
  totalHitAt10: number;
  answerableCount: number;
}

export function accumulateRecallEvalRows(
  collected: readonly RecallEvalQuestionResult[]
): RecallEvalAccumulator {
  const accumulator = createAccumulator();
  for (const result of collected) accumulateRow(accumulator, result);
  return accumulator;
}

function createAccumulator(): RecallEvalAccumulator {
  return {
    perScenario: [], latencies: [], questionDiagnostics: [],
    tokenMetricsPerQuestion: [], recallTokenEconomySamples: [],
    edgeProposalRowsAcross: [], edgeProposalRowsPerQuestion: [],
    tierHot: 0, tierWarm: 0, tierCold: 0,
    degradeNone: 0, degradeWarm: 0, degradeCold: 0, degradePartial: 0,
    totalHitAt1: 0, totalHitAt10: 0, answerableCount: 0
  };
}

function accumulateRow(acc: RecallEvalAccumulator, result: RecallEvalQuestionResult): void {
  acc.questionDiagnostics.push(result.diagnostics);
  acc.latencies.push(result.latencyMs);
  const scorable = classifyQuestionMeasurementStatus(result.diagnostics) === "scorable";
  if (scorable) {
    acc.answerableCount++;
    if (result.hitAt1) acc.totalHitAt1++;
    if (result.hitAt10) acc.totalHitAt10++;
  }
  if (result.firstTier === "hot") acc.tierHot++;
  else if (result.firstTier === "warm") acc.tierWarm++;
  else acc.tierCold++;
  if (result.degradationReason === "warm_cascade_engaged") acc.degradeWarm++;
  else if (result.degradationReason === "cold_cascade_engaged") acc.degradeCold++;
  else if (result.degradationReason === "recall_explainability_partial") acc.degradePartial++;
  else acc.degradeNone++;
  acc.tokenMetricsPerQuestion.push(result.tokenMetrics);
  if (result.recallTokenEconomy !== null) acc.recallTokenEconomySamples.push(result.recallTokenEconomy);
  acc.edgeProposalRowsAcross.push(...result.edgeProposalKpiRows);
  acc.edgeProposalRowsPerQuestion.push([...result.edgeProposalKpiRows]);
  acc.perScenario.push({
    id: result.questionId, version: 1, hit_at_5: result.hitAt5, scorable,
    measurement_cohort: classifyQuestionMeasurementCohort(result.diagnostics),
    tier: result.firstTier, latency_ms: result.latencyMs
  });
}
