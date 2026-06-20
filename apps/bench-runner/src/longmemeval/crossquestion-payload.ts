import {
  buildDiffVsPrevious,
  buildTokenEconomy,
  computeTokenSavedRatio,
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
import { assertBenchTokenEconomyContract } from "../harness/token-economy.js";
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
  ratio,
  variantToSplit
} from "./crossquestion-helpers.js";
import type { LongMemEvalCrossQuestionRunResult } from "./crossquestion.js";
import type {
  CrossQuestionExecutionResult,
  CrossQuestionRunContext
} from "./crossquestion-run.js";

const LONGMEMEVAL_DIAGNOSTICS_FILENAME = "longmemeval-diagnostics.json";

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
    sample_size: context.opts.fetchResult?.questionCount ?? context.questions.length,
    evaluated_count: context.window.length,
    harness_mode: "mcp_propose_review",
    kpi: buildCrossQuestionKpi(context, execution, allDiagnostics, providerSummary)
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
  const layout: HistoryLayout = { historyRoot: context.opts.historyRoot };
  const previous = await readLatest(layout, "public-crossquestion", {
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
  return writeCrossQuestionEntry(context, layout, payloadBuild, diff, previous);
}

function buildCrossQuestionDataset(
  context: CrossQuestionRunContext
): KpiPayload["dataset"] {
  return {
    name: `${context.opts.variant}:crossquestion`,
    size: context.opts.fetchResult?.questionCount ?? context.questions.length,
    source: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned"
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
  const halfRates = computeHalfRates(collected);
  const recallTokenEconomy = aggregateRecallTokenEconomy(
    collected
      .map((result) => result.recallTokenEconomy)
      .filter((sample): sample is NonNullable<typeof sample> => sample !== null)
  );
  return {
    r_at_1: ratio(collected.filter((r) => r.hitAt1).length, n),
    r_at_5: ratio(collected.filter((r) => r.hitAt5).length, n),
    r_at_10: ratio(collected.filter((r) => r.hitAt10).length, n),
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
    r_at_5_first_half: ratio(firstHalf.filter((r) => r.hitAt5).length, firstHalf.length),
    r_at_5_last_half: ratio(lastHalf.filter((r) => r.hitAt5).length, lastHalf.length)
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
    seed_extraction_path: payload.kpi.seed_extraction_path,
    provider_state_summary: providerSummary,
    questions: allDiagnostics
  } as const;
}

async function writeCrossQuestionEntry(
  context: CrossQuestionRunContext,
  layout: HistoryLayout,
  payloadBuild: CrossQuestionPayloadBuild,
  diff: ReturnType<typeof diffKpis>,
  previous: KpiPayload | null
): Promise<LongMemEvalCrossQuestionRunResult> {
  const slug = entrySlug(context.runAt, context.commitSha7);
  const diagnosticsPath = await writeCrossQuestionDiagnostics(
    context,
    slug,
    payloadBuild.diagnosticsPayload
  );
  const entry = await writeEntry(
    layout,
    "public-crossquestion",
    slug,
    payloadBuild.payload,
    buildCrossQuestionReport(payloadBuild.payload, previous, diff),
    buildCrossQuestionFindings(payloadBuild.payload, diff),
    { sidecars: [diagnosticsSidecar(payloadBuild.diagnosticsPayload, diagnosticsPath)] }
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

async function writeCrossQuestionDiagnostics(
  context: CrossQuestionRunContext,
  slug: string,
  diagnosticsPayload: CrossQuestionPayloadBuild["diagnosticsPayload"]
): Promise<string> {
  return writeExternalDiagnosticsArtifact({
    historyRoot: context.opts.historyRoot,
    benchName: "public-crossquestion",
    slug,
    filename: LONGMEMEVAL_DIAGNOSTICS_FILENAME,
    contents: renderDiagnosticsSidecar(diagnosticsPayload)
  });
}

function diagnosticsSidecar(
  diagnosticsPayload: CrossQuestionPayloadBuild["diagnosticsPayload"],
  diagnosticsPath: string
) {
  return {
    filename: LONGMEMEVAL_DIAGNOSTICS_FILENAME,
    contents: renderCompactDiagnosticsSidecar(diagnosticsPayload, diagnosticsPath)
  };
}

function buildCrossQuestionReport(
  payload: KpiPayload,
  previous: KpiPayload | null,
  diff: ReturnType<typeof diffKpis>
): string {
  return appendSeedExtractionReleaseBlockerToReport(
    renderReport(payload, previous, diff),
    payload
  );
}

function buildCrossQuestionFindings(
  payload: KpiPayload,
  diff: ReturnType<typeof diffKpis>
): string | null {
  return appendSeedExtractionReleaseBlockerToFindings(
    renderFindings(payload, diff),
    payload
  );
}
