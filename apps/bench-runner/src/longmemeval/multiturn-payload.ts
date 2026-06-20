import {
  buildTokenEconomy,
  computeTokenSavedRatio,
  buildDiffVsPrevious,
  diffKpis,
  entrySlug,
  readLatest,
  renderFindings,
  renderReport,
  writeEntry,
  type HistoryLayout,
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
  renderCompactDiagnosticsSidecar,
  renderDiagnosticsSidecar,
  summarizeProviderStates
} from "./diagnostics.js";
import { writeExternalDiagnosticsArtifact } from "./diagnostics-artifacts.js";
import { aggregateRecallTokenEconomy } from "./recall-token-economy.js";
import {
  appendSeedExtractionReleaseBlockerToFindings,
  appendSeedExtractionReleaseBlockerToReport
} from "./seed-extraction-release-blocker.js";
import { toSeedExtractionPathKpi } from "./compile-seed.js";
import {
  computePercentile,
  countDegradationReasons,
  countTiers,
  rAt5ForRound,
  ratio,
  variantToSplit
} from "./multiturn-helpers.js";
import type { LongMemEvalMultiturnRunResult, RoundResult } from "./multiturn.js";
import type { MultiturnExecutionResult, MultiturnRunContext } from "./multiturn-run.js";
import type { BenchRecallTokenEconomy } from "../harness/recall-diagnostics-schema.js";

const LONGMEMEVAL_DIAGNOSTICS_FILENAME = "longmemeval-diagnostics.json";

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
  const providerSummary = summarizeProviderStates(allDiagnostics);
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
    sample_size: context.opts.fetchResult?.questionCount ?? context.questions.length,
    evaluated_count: context.window.length,
    harness_mode: "mcp_propose_review",
    kpi: buildMultiturnKpi(context, execution, allDiagnostics, finalDiagnostics, providerSummary)
  };
  return {
    payload,
    diagnosticsPayload: buildMultiturnDiagnosticsPayload(
      context,
      payload,
      providerSummary,
      allDiagnostics
    )
  };
}

export async function writeMultiturnArtifacts(
  context: MultiturnRunContext,
  payloadBuild: MultiturnPayloadBuild
): Promise<LongMemEvalMultiturnRunResult> {
  const layout: HistoryLayout = { historyRoot: context.opts.historyRoot };
  const previous = await readLatest(layout, "public-multiturn", {
    split: payloadBuild.payload.split,
    embeddingProvider: payloadBuild.payload.embedding_provider,
    pointerKind: "passing"
  });
  const diff = diffKpis(payloadBuild.payload, previous);
  payloadBuild.payload.diff_vs_previous = buildDiffVsPrevious(
    payloadBuild.payload,
    previous,
    previous?.run_at ?? ""
  );
  return writeMultiturnEntry(context, layout, payloadBuild, diff, previous);
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
    source: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned"
  };
}

function buildMultiturnKpi(
  context: MultiturnRunContext,
  execution: MultiturnExecutionResult,
  allDiagnostics: Parameters<typeof summarizeProviderStates>[0],
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
    r_at_1: ratio(finalRounds.filter((round) => round.hitAt1).length, finalRounds.length),
    r_at_5: ratio(finalRounds.filter((round) => round.hitAt5).length, finalRounds.length),
    r_at_10: ratio(finalRounds.filter((round) => round.hitAt10).length, finalRounds.length),
    r_at_5_round_1: rAt5ForRound(execution.collected, 1),
    ...(context.rounds >= 2 ? { r_at_5_round_2: rAt5ForRound(execution.collected, 2) } : {}),
    r_at_5_round_n: ratio(finalRounds.filter((round) => round.hitAt5).length, finalRounds.length),
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
  return collectFinalRounds(collected).map((round, index) => ({
    id: collected[index]?.questionId ?? `question-${index + 1}`,
    version: 1,
    hit_at_5: round.hitAt5,
    tier: round.firstTier
  }));
}

function buildMultiturnDiagnosticsPayload(
  context: MultiturnRunContext,
  payload: KpiPayload,
  providerSummary: ReturnType<typeof summarizeProviderStates>,
  allDiagnostics: Parameters<typeof summarizeProviderStates>[0]
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
    seed_extraction_path: payload.kpi.seed_extraction_path,
    provider_state_summary: providerSummary,
    questions: allDiagnostics
  } as const;
}

async function writeMultiturnEntry(
  context: MultiturnRunContext,
  layout: HistoryLayout,
  payloadBuild: MultiturnPayloadBuild,
  diff: ReturnType<typeof diffKpis>,
  previous: KpiPayload | null
): Promise<LongMemEvalMultiturnRunResult> {
  const slug = entrySlug(context.runAt, context.commitSha7);
  const diagnosticsPath = await writeMultiturnDiagnostics(
    context,
    slug,
    payloadBuild.diagnosticsPayload
  );
  const entry = await writeEntry(
    layout,
    "public-multiturn",
    slug,
    payloadBuild.payload,
    buildMultiturnReport(payloadBuild.payload, previous, diff),
    buildMultiturnFindings(payloadBuild.payload, diff),
    { sidecars: [multiturnDiagnosticsSidecar(payloadBuild.diagnosticsPayload, diagnosticsPath)] }
  );
  return {
    slug,
    kpiPath: entry.kpiPath,
    reportPath: entry.reportPath,
    findingsPath: entry.findingsPath,
    diagnosticsPath: entry.sidecarPaths[LONGMEMEVAL_DIAGNOSTICS_FILENAME] ?? null,
    payload: payloadBuild.payload
  };
}

async function writeMultiturnDiagnostics(
  context: MultiturnRunContext,
  slug: string,
  diagnosticsPayload: MultiturnPayloadBuild["diagnosticsPayload"]
): Promise<string> {
  return writeExternalDiagnosticsArtifact({
    historyRoot: context.opts.historyRoot,
    benchName: "public-multiturn",
    slug,
    filename: LONGMEMEVAL_DIAGNOSTICS_FILENAME,
    contents: renderDiagnosticsSidecar(diagnosticsPayload)
  });
}

function multiturnDiagnosticsSidecar(
  diagnosticsPayload: MultiturnPayloadBuild["diagnosticsPayload"],
  diagnosticsPath: string
) {
  return {
    filename: LONGMEMEVAL_DIAGNOSTICS_FILENAME,
    contents: renderCompactDiagnosticsSidecar(diagnosticsPayload, diagnosticsPath)
  };
}

function buildMultiturnReport(
  payload: KpiPayload,
  previous: KpiPayload | null,
  diff: ReturnType<typeof diffKpis>
): string {
  return appendSeedExtractionReleaseBlockerToReport(
    renderReport(payload, previous, diff),
    payload
  );
}

function buildMultiturnFindings(
  payload: KpiPayload,
  diff: ReturnType<typeof diffKpis>
): string | null {
  return appendSeedExtractionReleaseBlockerToFindings(
    renderFindings(payload, diff),
    payload
  );
}
