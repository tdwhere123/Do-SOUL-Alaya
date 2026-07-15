import {
  buildTokenEconomy,
  computeTokenSavedRatio,
  type KpiPayload,
  type PerScenarioRow
} from "@do-soul/alaya-eval";
import { assertBenchTokenEconomyContract } from "../harness/token-economy.js";
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
} from "./crossquestion-helpers.js";
import type { LongMemEvalCrossQuestionRunResult } from "./crossquestion.js";
import type {
  CrossQuestionExecutionResult,
  CrossQuestionRunContext
} from "./crossquestion-run.js";
import { selectionContractIdentity } from "./selection/contract.js";
import { writeTierOneLongMemEvalArchive } from "./archive/tier-one-evidence.js";

export interface CrossQuestionPayloadBuild {
  readonly payload: KpiPayload;
  readonly diagnosticsPayload: ReturnType<typeof buildCrossQuestionDiagnosticsPayload>;
}

export function buildCrossQuestionPayload(
  context: CrossQuestionRunContext,
  execution: CrossQuestionExecutionResult
): CrossQuestionPayloadBuild {
  assertBenchTokenEconomyContract("public", execution.tokenEconomyInput);
  const allDiagnostics = execution.collected.map((result) => result.diagnostics);
  const providerSummary = summarizeProviderStates(allDiagnostics);
  const split = variantToSplit(context.opts.variant);
  const kpi = buildCrossQuestionKpi(context, execution, allDiagnostics, providerSummary);
  const payload: KpiPayload = {
    bench_name: "public-crossquestion",
    split,
    run_at: context.runAt.toISOString(),
    alaya_commit: context.commitSha7,
    alaya_version: context.alayaVersion,
    recall_pipeline_version: RECALL_PIPELINE_VERSION,
    embedding_provider: context.embeddingProviderLabel,
    chat_provider: "none",
    policy_shape: "stress",
    simulate_report: "none",
    dataset: buildCrossQuestionDataset(context),
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
    diagnosticsPayload: buildCrossQuestionDiagnosticsPayload(
      context,
      payload,
      providerSummary,
      allDiagnostics
    )
  };
}

export async function writeCrossQuestionArtifacts(
  context: CrossQuestionRunContext,
  payloadBuild: CrossQuestionPayloadBuild
): Promise<LongMemEvalCrossQuestionRunResult> {
  return writeTierOneLongMemEvalArchive({
    benchName: "public-crossquestion",
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

function buildCrossQuestionDataset(
  context: CrossQuestionRunContext
): KpiPayload["dataset"] {
  return {
    name: `${context.opts.variant}:crossquestion`,
    size: context.opts.fetchResult?.questionCount ?? context.questions.length,
    source: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned",
    checksum_sha256: context.datasetSha256,
    checksum_source: context.datasetChecksumSource
  };
}

function buildCrossQuestionKpi(
  context: CrossQuestionRunContext,
  execution: CrossQuestionExecutionResult,
  allDiagnostics: Parameters<typeof summarizeProviderStates>[0],
  providerSummary: ReturnType<typeof summarizeProviderStates>
): KpiPayload["kpi"] {
  const collected = execution.collected;
  const n = collected.length;
  const recall = summarizeAnswerableRecall(allDiagnostics);
  const halfRates = computeHalfRates(collected);
  const recallTokenEconomy = aggregateRecallTokenEconomy(
    collected
      .map((result) => result.recallTokenEconomy)
      .filter((sample): sample is NonNullable<typeof sample> => sample !== null)
  );
  return {
    r_at_1: recall.rAt1,
    r_at_5: recall.rAt5,
    r_at_10: recall.rAt10,
    ...halfRates,
    crossquestion_questions: n,
    ...buildEmbeddingProviderKpi(context, allDiagnostics, providerSummary),
    latency_ms_p50: computePercentile(collected.map((r) => r.latencyMs), 50),
    latency_ms_p95: computePercentile(collected.map((r) => r.latencyMs), 95),
    latency_source: "exact",
    token_saved_ratio_vs_full_prompt: computeTokenSavedRatio(execution.tokenEconomyInput),
    token_economy: buildTokenEconomy(execution.tokenEconomyInput),
    ...(recallTokenEconomy === null ? {} : { recall_token_economy: recallTokenEconomy }),
    tier_distribution: countTiers(collected),
    degradation_reasons: countDegradationReasons(collected),
    seed_truncation: buildSeedTruncation(collected),
    seed_extraction_path: toSeedExtractionPathKpi(execution.seedStats),
    quality_metrics: buildLongMemEvalQualityMetrics(allDiagnostics),
    per_scenario: buildPerScenarioRows(collected)
  };
}

function computeHalfRates(collected: readonly CrossQuestionExecutionResult["collected"][number][]) {
  const n = collected.length;
  const half = Math.floor(n / 2);
  const firstHalf = collected.slice(0, half);
  const lastHalf = collected.slice(n - half);
  if (half === 0) return {};
  return {
    r_at_5_first_half: answerableRecallAt5(firstHalf.map((row) => row.diagnostics)),
    r_at_5_last_half: answerableRecallAt5(lastHalf.map((row) => row.diagnostics))
  };
}

function buildEmbeddingProviderKpi(
  context: CrossQuestionRunContext,
  allDiagnostics: Parameters<typeof summarizeProviderStates>[0],
  providerSummary: ReturnType<typeof summarizeProviderStates>
) {
  if (context.opts.embeddingMode !== "env") return {};
  return {
    r_at_5_overall: ratio(allDiagnostics.filter((r) => r.hit_at_5).length, allDiagnostics.length),
    ...(rAt5WithProviderReturned(allDiagnostics) === undefined
      ? {}
      : { r_at_5_with_embedding_returned: rAt5WithProviderReturned(allDiagnostics) }),
    provider_returned_rate: providerSummary.provider_returned_rate,
    provider_pending_rate: providerSummary.provider_pending_rate,
    provider_failed_rate: providerSummary.provider_failed_rate
  };
}

function buildSeedTruncation(
  collected: readonly CrossQuestionExecutionResult["collected"][number][]
) {
  return {
    seed_turns_truncated: collected.reduce((acc, r) => acc + r.seedTurnsTruncated, 0),
    answer_turns_truncated: collected.reduce((acc, r) => acc + r.answerTurnsTruncated, 0),
    seed_chars_clipped: collected.reduce((acc, r) => acc + r.seedCharsClipped, 0)
  };
}

function buildPerScenarioRows(
  collected: readonly CrossQuestionExecutionResult["collected"][number][]
): PerScenarioRow[] {
  return collected.map((result) => ({
    id: result.questionId,
    version: 1,
    hit_at_5: result.hitAt5,
    scorable: classifyQuestionMeasurementStatus(result.diagnostics) === "scorable",
    measurement_cohort: classifyQuestionMeasurementCohort(result.diagnostics),
    tier: result.firstTier
  }));
}

function buildCrossQuestionDiagnosticsPayload(
  context: CrossQuestionRunContext,
  payload: KpiPayload,
  providerSummary: ReturnType<typeof summarizeProviderStates>,
  allDiagnostics: Parameters<typeof summarizeProviderStates>[0]
) {
  return {
    schema_version: 1,
    bench_name: "public-crossquestion",
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
    questions: allDiagnostics
  } as const;
}
