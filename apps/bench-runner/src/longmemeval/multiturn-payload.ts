import {
  buildTokenEconomy,
  computeTokenSavedRatio,
  type KpiPayload,
  type PerScenarioRow
} from "@do-soul/alaya-eval";
import {
  aggregateBenchTokenMetrics,
  assertBenchTokenEconomyContract
} from "../harness/token-economy.js";
import { RECALL_PIPELINE_VERSION } from "../shared/version.js";
import {
  buildLongMemEvalQualityMetrics,
  rAt5WithProviderReturned,
  summarizeProviderStates
} from "./diagnostics.js";
import { aggregateRecallTokenEconomy } from "./recall-token-economy.js";
import { toSeedExtractionPathKpi } from "./compile-seed.js";
import {
  classifyQuestionMeasurementCohort,
  classifyQuestionMeasurementStatus
} from "./measurement/question-validity.js";
import {
  answerableRecallAt5,
  summarizeAnswerableRecall
} from "./measurement/answerable-recall.js";
import {
  computePercentile,
  countDegradationReasons,
  countTiers,
  ratio,
  variantToSplit
} from "./multiturn-helpers.js";
import type { LongMemEvalMultiturnRunResult, RoundResult } from "./multiturn.js";
import type { MultiturnExecutionResult, MultiturnRunContext } from "./multiturn-run.js";
import type { BenchRecallTokenEconomy } from "../harness/recall-diagnostics-schema.js";
import { selectionContractIdentity } from "./selection/contract.js";
import { writeTierOneLongMemEvalArchive } from "./archive/tier-one-evidence.js";

export interface MultiturnPayloadBuild {
  readonly payload: KpiPayload;
  readonly diagnosticsPayload: ReturnType<typeof buildMultiturnDiagnosticsPayload>;
}

export function buildMultiturnPayload(
  context: MultiturnRunContext,
  execution: MultiturnExecutionResult
): MultiturnPayloadBuild {
  const allDiagnostics = execution.collected.flatMap((result) =>
    result.rounds.map((round) => round.diagnostics)
  );
  const finalRounds = collectFinalRounds(execution.collected);
  const finalDiagnostics = finalRounds.map((round) => round.diagnostics);
  const providerSummary = summarizeProviderStates(finalDiagnostics);
  const kpi = buildMultiturnKpi(
    context,
    execution,
    finalDiagnostics,
    providerSummary
  );
  const payload: KpiPayload = {
    bench_name: "public-multiturn",
    split: variantToSplit(context.opts.variant),
    run_at: context.runAt.toISOString(),
    alaya_commit: context.commitSha7,
    alaya_version: context.alayaVersion,
    recall_pipeline_version: RECALL_PIPELINE_VERSION,
    embedding_provider: context.embeddingProviderLabel,
    chat_provider: "none",
    policy_shape: "stress",
    simulate_report: "none",
    dataset: buildMultiturnDataset(context),
    selection_contract: selectionContractIdentity(context.selectionContract),
    sample_size: context.opts.fetchResult?.questionCount ?? context.questions.length,
    evaluated_count: context.window.length,
    answerable_evaluated_count: kpi.per_scenario.filter(
      (row) => row.scorable === true
    ).length,
    harness_mode: "mcp_propose_review",
    kpi
  };
  return {
    payload,
    diagnosticsPayload: buildMultiturnDiagnosticsPayload(
      context,
      payload,
      providerSummary,
      allDiagnostics,
      finalDiagnostics
    )
  };
}

export async function writeMultiturnArtifacts(
  context: MultiturnRunContext,
  payloadBuild: MultiturnPayloadBuild
): Promise<LongMemEvalMultiturnRunResult> {
  return writeTierOneLongMemEvalArchive({
    benchName: "public-multiturn",
    opts: context.opts,
    datasetSha256: context.datasetSha256,
    datasetChecksumSource: context.datasetChecksumSource,
    datasetSourcePath: context.datasetSourcePath,
    releaseEvidenceAuthority: context.releaseEvidenceAuthority,
    selectionContract: context.selectionContract,
    payload: payloadBuild.payload,
    diagnosticsPayload: payloadBuild.diagnosticsPayload,
    releaseDiagnostics: payloadBuild.diagnosticsPayload.questions,
    commitSha7: context.commitSha7,
    embeddingProviderLabel: context.embeddingProviderLabel,
    runAt: context.runAt
  });
}

function collectFinalRounds(collected: MultiturnExecutionResult["collected"]) {
  return collected
    .map((result) => result.rounds[result.rounds.length - 1])
    .filter((round): round is RoundResult => round !== undefined);
}

function buildMultiturnDataset(context: MultiturnRunContext): KpiPayload["dataset"] {
  return {
    name: `${context.opts.variant}:multiturn`,
    size: context.opts.fetchResult?.questionCount ?? context.questions.length,
    source: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned",
    checksum_sha256: context.datasetSha256,
    checksum_source: context.datasetChecksumSource
  };
}

function buildMultiturnKpi(
  context: MultiturnRunContext,
  execution: MultiturnExecutionResult,
  finalDiagnostics: Parameters<typeof summarizeProviderStates>[0],
  providerSummary: ReturnType<typeof summarizeProviderStates>
): KpiPayload["kpi"] {
  const finalRounds = collectFinalRounds(execution.collected);
  const recallTokenEconomy = aggregateRecallTokenEconomy(
    execution.collected.flatMap((result) =>
      result.rounds
        .map((round) => round.recallTokenEconomy)
        .filter((sample): sample is BenchRecallTokenEconomy => sample !== null)
    )
  );
  const tokenEconomyInput = aggregateBenchTokenMetrics(
    execution.collected.map((result) => result.tokenMetrics)
  );
  assertBenchTokenEconomyContract("public", tokenEconomyInput);
  return {
    ...buildMultiturnRecallKpi(context, execution, finalDiagnostics),
    multiturn_rounds: context.rounds,
    ...buildMultiturnEmbeddingKpi(context, finalDiagnostics, providerSummary),
    latency_ms_p50: computePercentile(finalRounds.map((round) => round.latencyMs), 50),
    latency_ms_p95: computePercentile(finalRounds.map((round) => round.latencyMs), 95),
    latency_source: "exact",
    token_saved_ratio_vs_full_prompt: computeTokenSavedRatio(tokenEconomyInput),
    token_economy: buildTokenEconomy(tokenEconomyInput),
    ...(recallTokenEconomy === null ? {} : { recall_token_economy: recallTokenEconomy }),
    tier_distribution: countTiers(finalRounds),
    degradation_reasons: countDegradationReasons(finalRounds),
    seed_truncation: buildMultiturnSeedTruncation(execution.collected),
    seed_extraction_path: toSeedExtractionPathKpi(context.seedRunner.stats),
    quality_metrics: buildLongMemEvalQualityMetrics(finalDiagnostics),
    per_scenario: buildMultiturnPerScenario(execution.collected)
  };
}

function buildMultiturnRecallKpi(
  context: MultiturnRunContext,
  execution: MultiturnExecutionResult,
  finalDiagnostics: Parameters<typeof summarizeProviderStates>[0]
) {
  const final = summarizeAnswerableRecall(finalDiagnostics);
  return {
    r_at_1: final.rAt1,
    r_at_5: final.rAt5,
    r_at_10: final.rAt10,
    r_at_5_round_1: answerableRecallAt5(roundDiagnostics(execution, 1)),
    ...(context.rounds >= 2
      ? { r_at_5_round_2: answerableRecallAt5(roundDiagnostics(execution, 2)) }
      : {}),
    r_at_5_round_n: final.rAt5
  };
}

function roundDiagnostics(
  execution: MultiturnExecutionResult,
  roundIndex: number
) {
  return execution.collected.flatMap((result) => {
    const round = result.rounds[roundIndex - 1];
    return round === undefined ? [] : [round.diagnostics];
  });
}

function buildMultiturnEmbeddingKpi(
  context: MultiturnRunContext,
  finalDiagnostics: Parameters<typeof summarizeProviderStates>[0],
  providerSummary: ReturnType<typeof summarizeProviderStates>
) {
  if (context.opts.embeddingMode !== "env") return {};
  return {
    r_at_5_overall: ratio(finalDiagnostics.filter((row) => row.hit_at_5).length, finalDiagnostics.length),
    ...(rAt5WithProviderReturned(finalDiagnostics) === undefined
      ? {}
      : { r_at_5_with_embedding_returned: rAt5WithProviderReturned(finalDiagnostics) }),
    provider_returned_rate: providerSummary.provider_returned_rate,
    provider_pending_rate: providerSummary.provider_pending_rate,
    provider_failed_rate: providerSummary.provider_failed_rate
  };
}

function buildMultiturnSeedTruncation(
  collected: MultiturnExecutionResult["collected"]
) {
  return {
    seed_turns_truncated: collected.reduce((sum, result) => sum + result.seedTurnsTruncated, 0),
    answer_turns_truncated: collected.reduce((sum, result) => sum + result.answerTurnsTruncated, 0),
    seed_chars_clipped: collected.reduce((sum, result) => sum + result.seedCharsClipped, 0)
  };
}

function buildMultiturnPerScenario(
  collected: MultiturnExecutionResult["collected"]
): PerScenarioRow[] {
  return collected.flatMap((result) => {
    const round = result.rounds[result.rounds.length - 1];
    if (round === undefined) return [];
    return [{
      id: result.questionId,
      version: 1,
      hit_at_5: round.hitAt5,
      scorable: classifyQuestionMeasurementStatus(round.diagnostics) === "scorable",
      measurement_cohort: classifyQuestionMeasurementCohort(round.diagnostics),
      tier: round.firstTier
    }];
  });
}

function buildMultiturnDiagnosticsPayload(
  context: MultiturnRunContext,
  payload: KpiPayload,
  providerSummary: ReturnType<typeof summarizeProviderStates>,
  allDiagnostics: Parameters<typeof summarizeProviderStates>[0],
  finalDiagnostics: Parameters<typeof summarizeProviderStates>[0]
) {
  return {
    schema_version: 1,
    bench_name: "public-multiturn",
    split: payload.split,
    run_at: payload.run_at,
    alaya_commit: payload.alaya_commit,
    commit_resolution: context.commitInfo,
    recall_pipeline_version: payload.recall_pipeline_version,
    embedding_provider: payload.embedding_provider,
    embedding_mode: context.opts.embeddingMode ?? "disabled",
    policy_shape: payload.policy_shape,
    simulate_report: payload.simulate_report,
    seed_extraction_path: payload.kpi.seed_extraction_path,
    provider_state_summary: providerSummary,
    round_diagnostics: allDiagnostics,
    questions: finalDiagnostics
  } as const;
}
