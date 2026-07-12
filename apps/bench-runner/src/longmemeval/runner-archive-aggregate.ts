import type { EdgeProposalKpiEventRow, PerScenarioRow } from "@do-soul/alaya-eval";
import type {
  BenchEmbeddingWarmupSummary,
  BenchQueryEmbeddingWarmupSummary,
  BenchTokenMetrics
} from "../harness/daemon.js";
import type { BenchRecallTokenEconomy } from "../harness/recall-diagnostics-schema.js";
import type {
  LongMemEvalQuestionDiagnostic,
  LongMemEvalReportSideEffectSnapshot
} from "./diagnostics.js";
import type { QaQuestionVerdict } from "./qa-harness.js";
import type { CompileSeedExtractionStats } from "./compile-seed.js";
import type { LongMemEvalWorkerResult } from "./runner-question.js";
import { classifyQuestionMeasurementStatus } from "./measurement/question-validity.js";

export interface LongMemEvalRunArchiveAggregate {
  readonly perScenario: PerScenarioRow[];
  readonly latencies: number[];
  readonly questionDiagnostics: LongMemEvalQuestionDiagnostic[];
  readonly tokenMetricsPerQuestion: BenchTokenMetrics[];
  readonly recallTokenEconomySamples: BenchRecallTokenEconomy[];
  readonly reportSideEffectSnapshots: LongMemEvalReportSideEffectSnapshot[];
  readonly embeddingWarmups: BenchEmbeddingWarmupSummary[];
  readonly queryEmbeddingWarmups: BenchQueryEmbeddingWarmupSummary[];
  readonly edgeProposalKpiRowsPerQuestion: EdgeProposalKpiEventRow[][];
  readonly qaVerdicts: QaQuestionVerdict[];
  tierHot: number;
  tierWarm: number;
  tierCold: number;
  degradeNone: number;
  degradeWarm: number;
  degradeCold: number;
  degradePartial: number;
  totalHitAt1: number;
  totalHitAt10: number;
  truncSeedTotal: number;
  truncAnswerTotal: number;
  truncCharsTotal: number;
  reportsAttempted: number;
  reportsUsed: number;
  reportsSkipped: number;
  reportUsedObjectCount: number;
  answerableCount: number;
}

export function logLongMemEvalExtractionStats(
  extractionStats: CompileSeedExtractionStats
): void {
  process.stdout.write(
    `[longmemeval compile-seed] path=${extractionStats.path} ` +
      `cache_hits=${extractionStats.cacheHits} ` +
      `llm_calls=${extractionStats.llmCalls} ` +
      `offline_fallbacks=${extractionStats.offlineFallbacks} ` +
      `facts=${extractionStats.factsProduced} ` +
      `signals_dropped=${extractionStats.signalsDropped}\n`
  );
}

export function aggregateLongMemEvalRunResults(
  collected: readonly LongMemEvalWorkerResult[]
): LongMemEvalRunArchiveAggregate {
  const aggregate = createLongMemEvalRunArchiveAggregate();
  for (const result of collected) {
    addLongMemEvalWorkerResult(aggregate, result);
  }
  return aggregate;
}

function createLongMemEvalRunArchiveAggregate(): LongMemEvalRunArchiveAggregate {
  return {
    perScenario: [],
    latencies: [],
    questionDiagnostics: [],
    tokenMetricsPerQuestion: [],
    recallTokenEconomySamples: [],
    reportSideEffectSnapshots: [],
    embeddingWarmups: [],
    queryEmbeddingWarmups: [],
    edgeProposalKpiRowsPerQuestion: [],
    qaVerdicts: [],
    tierHot: 0,
    tierWarm: 0,
    tierCold: 0,
    degradeNone: 0,
    degradeWarm: 0,
    degradeCold: 0,
    degradePartial: 0,
    totalHitAt1: 0,
    totalHitAt10: 0,
    truncSeedTotal: 0,
    truncAnswerTotal: 0,
    truncCharsTotal: 0,
    reportsAttempted: 0,
    reportsUsed: 0,
    reportsSkipped: 0,
    reportUsedObjectCount: 0,
    answerableCount: 0
  };
}

function addLongMemEvalWorkerResult(
  aggregate: LongMemEvalRunArchiveAggregate,
  result: LongMemEvalWorkerResult | null | undefined
): void {
  if (result === null || result === undefined) return;
  addQuestionArtifacts(aggregate, result);
  addQuestionCounters(aggregate, result);
  const scorable = classifyQuestionMeasurementStatus(result.diagnostics) === "scorable";
  aggregate.perScenario.push({
    id: result.questionId,
    version: 1,
    hit_at_5: result.hitAt5,
    scorable,
    tier: result.firstTier,
    latency_ms: result.latencyMs
  });
}

function addQuestionArtifacts(
  aggregate: LongMemEvalRunArchiveAggregate,
  result: LongMemEvalWorkerResult
): void {
  aggregate.questionDiagnostics.push(result.diagnostics);
  if (result.embeddingWarmup !== null) aggregate.embeddingWarmups.push(result.embeddingWarmup);
  if (result.queryEmbeddingWarmup !== null) aggregate.queryEmbeddingWarmups.push(result.queryEmbeddingWarmup);
  aggregate.latencies.push(result.latencyMs);
  aggregate.reportSideEffectSnapshots.push(result.reportSideEffectSnapshot);
  aggregate.tokenMetricsPerQuestion.push(result.tokenMetrics);
  if (result.recallTokenEconomy !== null) {
    aggregate.recallTokenEconomySamples.push(result.recallTokenEconomy);
  }
  aggregate.edgeProposalKpiRowsPerQuestion.push([...result.edgeProposalKpiRows]);
  if (result.qaVerdict !== undefined) aggregate.qaVerdicts.push(result.qaVerdict);
}

function addQuestionCounters(
  aggregate: LongMemEvalRunArchiveAggregate,
  result: LongMemEvalWorkerResult
): void {
  if (classifyQuestionMeasurementStatus(result.diagnostics) === "scorable") {
    aggregate.answerableCount++;
    if (result.hitAt1) aggregate.totalHitAt1++;
    if (result.hitAt10) aggregate.totalHitAt10++;
  }
  if (result.firstTier === "hot") aggregate.tierHot++;
  else if (result.firstTier === "warm") aggregate.tierWarm++;
  else aggregate.tierCold++;
  if (result.degradationReason === "warm_cascade_engaged") aggregate.degradeWarm++;
  else if (result.degradationReason === "cold_cascade_engaged") aggregate.degradeCold++;
  else if (result.degradationReason === "recall_explainability_partial") aggregate.degradePartial++;
  else aggregate.degradeNone++;
  aggregate.truncSeedTotal += result.seedTurnsTruncated;
  aggregate.truncAnswerTotal += result.answerTurnsTruncated;
  aggregate.truncCharsTotal += result.seedCharsClipped;
  aggregate.reportsAttempted += result.reportUsageStats.reportsAttempted;
  aggregate.reportsUsed += result.reportUsageStats.reportsUsed;
  aggregate.reportsSkipped += result.reportUsageStats.reportsSkipped;
  aggregate.reportUsedObjectCount += result.reportUsageStats.usedObjectCount;
}
