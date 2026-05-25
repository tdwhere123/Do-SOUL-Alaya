import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
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
  RECALL_PIPELINE_VERSION,
  resolveBenchCommitSha7,
  resolveBenchRunnerVersion
} from "../version.js";
import { rotatingSeedObjectKind } from "../harness/seed-rotation.js";
import {
  startBenchDaemon,
  type BenchEmbeddingMode,
  type BenchEmbeddingProviderKind,
  type BenchEmbeddingWarmupSummary,
  type BenchQueryEmbeddingWarmupSummary
} from "../harness/daemon.js";
import {
  buildLongMemEvalQualityMetrics,
  buildQuestionDiagnostic,
  rAt5WithProviderReturned,
  renderCompactDiagnosticsSidecar,
  renderDiagnosticsSidecar,
  summarizeLongMemEvalRecallEvidence,
  summarizeProviderStates,
  type LongMemEvalQuestionDiagnostic
} from "../longmemeval/diagnostics.js";
import { writeExternalDiagnosticsArtifact } from "../longmemeval/diagnostics-artifacts.js";
import {
  aggregateRecallTokenEconomy,
  extractRecallTokenEconomy
} from "../longmemeval/recall-token-economy.js";
import type { BenchRecallTokenEconomy } from "../harness/recall-diagnostics-schema.js";
import { extractSessions, type LocomoQa, type LocomoSample, type LocomoVariant } from "./dataset.js";
import { loadLocomo, type LocomoFetchResult } from "./fetch.js";

const LOCOMO_SOURCE_URL = "https://github.com/snap-research/locomo/blob/main/data/locomo10.json";

export interface LocomoRunOptions {
  readonly variant: LocomoVariant;
  readonly limit?: number;
  readonly historyRoot: string;
  readonly dataDir?: string;
  readonly fetchResult?: LocomoFetchResult;
  readonly embeddingMode?: BenchEmbeddingMode;
  readonly embeddingProviderKind?: BenchEmbeddingProviderKind;
  readonly pinnedMetaRoot?: string;
  readonly offset?: number;
}

export interface LocomoRunResult {
  readonly slug: string;
  readonly kpiPath: string;
  readonly reportPath: string;
  readonly findingsPath: string;
  readonly diagnosticsPath: string;
  readonly payload: KpiPayload;
}

interface LocomoEmbeddingVectorCacheSummary {
  readonly expected_count: number;
  readonly ready_count: number;
  readonly not_ready_count: number;
  readonly ready_rate: number;
  readonly max_pass_count: number;
}

interface LocomoQueryEmbeddingCacheSummary {
  readonly requested_count: number;
  readonly ready_count: number;
  readonly not_ready_count: number;
  readonly ready_rate: number;
  readonly cache_hit_count: number;
  readonly provider_requested_count: number;
  readonly last_error?: string;
}

export async function runLocomo(opts: LocomoRunOptions): Promise<LocomoRunResult> {
  const conversations = await loadLocomo(opts.variant, {
    dataDir: opts.dataDir,
    pinnedMetaRoot: opts.pinnedMetaRoot
  });
  const offset = Math.max(0, opts.offset ?? 0);
  const sliceEnd = opts.limit !== undefined ? offset + opts.limit : conversations.length;
  const window = conversations.slice(offset, sliceEnd);

  const alayaVersion = resolveBenchRunnerVersion();
  const commitSha7 = resolveCommitSha7();
  const runAt = new Date();
  const embeddingMode = opts.embeddingMode ?? "disabled";
  const embeddingProvider = embeddingMode === "env" ? "yunwu:text-embedding-3-small" : "none";

  const perScenario: PerScenarioRow[] = [];
  const questionDiagnostics: LongMemEvalQuestionDiagnostic[] = [];
  const latencies: number[] = [];
  let tierHot = 0;
  let tierWarm = 0;
  let tierCold = 0;
  let totalHitAt1 = 0;
  let totalHitAt5 = 0;
  let totalHitAt10 = 0;
  let totalQa = 0;
  const conversationResults: ConversationResult[] = [];

  for (let i = 0; i < window.length; i++) {
    const conversation = window[i];
    if (conversation === undefined) continue;
    const convResult = await runOneConversation(conversation, opts);
    conversationResults.push(convResult);
    totalQa += convResult.qaCount;
    totalHitAt1 += convResult.hitAt1;
    totalHitAt5 += convResult.hitAt5;
    totalHitAt10 += convResult.hitAt10;
    tierHot += convResult.tierHot;
    tierWarm += convResult.tierWarm;
    tierCold += convResult.tierCold;
    questionDiagnostics.push(...convResult.questionDiagnostics);
    for (const latency of convResult.latencies) {
      latencies.push(latency);
    }
    perScenario.push({
      id: conversation.sample_id,
      version: 1,
      hit_at_5: convResult.qaCount > 0 && convResult.hitAt5 / convResult.qaCount >= 0.5,
      tier: convResult.tierHot >= convResult.tierWarm && convResult.tierHot >= convResult.tierCold
        ? "hot"
        : convResult.tierWarm >= convResult.tierCold
          ? "warm"
          : "cold"
    });
    process.stdout.write(
      `[${i + 1}/${window.length}] ${conversation.sample_id} ` +
        `qa=${convResult.qaCount} R@5=${(convResult.hitAt5 / Math.max(1, convResult.qaCount) * 100).toFixed(1)}%\n`
    );
  }

  const rAt1 = totalQa === 0 ? 0 : totalHitAt1 / totalQa;
  const rAt5 = totalQa === 0 ? 0 : totalHitAt5 / totalQa;
  const rAt10 = totalQa === 0 ? 0 : totalHitAt10 / totalQa;
  const providerStateSummary = summarizeProviderStates(questionDiagnostics);
  const rAt5EmbeddingReturned = rAt5WithProviderReturned(questionDiagnostics);
  const embeddingVectorCache = summarizeEmbeddingVectorCache(
    conversationResults.flatMap((result) =>
      result.embeddingWarmup === null ? [] : [result.embeddingWarmup]
    )
  );
  const queryEmbeddingCache = summarizeQueryEmbeddingCache(
    conversationResults.flatMap((result) =>
      result.queryEmbeddingWarmup === null ? [] : [result.queryEmbeddingWarmup]
    )
  );
  // Phase 7: aggregate per-recall structural samples across every QA in
  // every conversation; one sample per recall call.
  const recallTokenEconomy = aggregateRecallTokenEconomy(
    conversationResults.flatMap((result) => result.recallTokenEconomySamples)
  );

  const payload: KpiPayload = {
    bench_name: "public-locomo",
    split: "locomo10",
    run_at: runAt.toISOString(),
    alaya_commit: commitSha7,
    alaya_version: alayaVersion,
    recall_pipeline_version: RECALL_PIPELINE_VERSION,
    embedding_provider: embeddingProvider,
    chat_provider: "none",
    policy_shape: "stress",
    simulate_report: "none",
    dataset: {
      name: opts.variant,
      size: opts.fetchResult?.conversationCount ?? conversations.length,
      source: LOCOMO_SOURCE_URL
    },
    // invariant: sample_size + evaluated_count count QAs, not
    // conversations. The R@K denominator is `totalQa` (questions
    // actually scored across all conversations in the window); the
    // dataset-wide upper bound is the QA total of the full LoCoMo set.
    // see also: packages/eval/src/wilson-ci.ts (label cascade reads
    // evaluatedCount in question units).
    sample_size: resolveLocomoSampleSize(conversations),
    evaluated_count: totalQa,
    harness_mode: "mcp_propose_review",
    kpi: {
      r_at_1: rAt1,
      r_at_5: rAt5,
      r_at_10: rAt10,
      ...(rAt5EmbeddingReturned === undefined
        ? {}
        : { r_at_5_with_embedding_returned: rAt5EmbeddingReturned }),
      provider_returned_rate: providerStateSummary.provider_returned_rate,
      provider_pending_rate: providerStateSummary.provider_pending_rate,
      provider_failed_rate: providerStateSummary.provider_failed_rate,
      provider_not_requested_rate: providerStateSummary.provider_not_requested_rate,
      ...(embeddingVectorCache === null
        ? {}
        : {
            embedding_vector_cache_ready_rate:
              embeddingVectorCache.ready_rate
          }),
      ...(queryEmbeddingCache === null
        ? {}
        : {
            query_embedding_cache_ready_rate:
              queryEmbeddingCache.ready_rate
          }),
      latency_ms_p50: computePercentile(latencies, 50),
      latency_ms_p95: computePercentile(latencies, 95),
      latency_source: "exact",
      token_saved_ratio_vs_full_prompt: 0,
      ...(recallTokenEconomy === null
        ? {}
        : { recall_token_economy: recallTokenEconomy }),
      tier_distribution: { hot: tierHot, warm: tierWarm, cold: tierCold },
      degradation_reasons: {
        none: totalQa,
        warm_cascade_engaged: 0,
        cold_cascade_engaged: 0,
        recall_explainability_partial: 0
      },
      seed_truncation: {
        seed_turns_truncated: 0,
        answer_turns_truncated: 0,
        seed_chars_clipped: 0
      },
      quality_metrics: buildLongMemEvalQualityMetrics(questionDiagnostics),
      per_scenario: perScenario
    }
  };

  const layout: HistoryLayout = { historyRoot: opts.historyRoot };
  const previous = await readLatest(layout, "public-locomo", {
    split: "locomo10",
    embeddingProvider: payload.embedding_provider,
    pointerKind: "passing"
  });
  const diff = diffKpis(payload, previous);
  payload.diff_vs_previous = buildDiffVsPrevious(
    payload,
    previous,
    previous?.run_at ?? ""
  );
  const slug = entrySlug(runAt, commitSha7);
  const report = renderReport(payload, previous, diff);
  const findings = renderFindings(payload, diff);
  const diagnosticsPayload = {
    schema_version: 1,
    bench_name: "public-locomo",
    split: "locomo10",
    run_at: payload.run_at,
    alaya_commit: payload.alaya_commit,
    embedding_provider: payload.embedding_provider,
    embedding_mode: embeddingMode,
    ...(embeddingVectorCache === null
      ? {}
      : { embedding_vector_cache: embeddingVectorCache }),
    ...(queryEmbeddingCache === null
      ? {}
      : { query_embedding_cache: queryEmbeddingCache }),
    provider_state_summary: providerStateSummary,
    scored_recall_evidence: summarizeLongMemEvalRecallEvidence(questionDiagnostics),
    questions: questionDiagnostics
  } as const;
  const diagnosticsSidecar = renderDiagnosticsSidecar(diagnosticsPayload);
  const diagnosticsArtifactPath = await writeExternalDiagnosticsArtifact({
    historyRoot: opts.historyRoot,
    benchName: "public-locomo",
    slug,
    filename: "locomo-diagnostics.json",
    contents: diagnosticsSidecar
  });
  const compactDiagnosticsSidecar = renderCompactDiagnosticsSidecar(
    diagnosticsPayload,
    diagnosticsArtifactPath
  );
  const entry = await writeEntry(layout, "public-locomo", slug, payload, report, findings, {
    sidecars: [
      {
        filename: "locomo-diagnostics.json",
        contents: compactDiagnosticsSidecar
      }
    ]
  });
  const diagnosticsPath = entry.sidecarPaths["locomo-diagnostics.json"]!;

  return {
    slug,
    kpiPath: entry.kpiPath,
    reportPath: entry.reportPath,
    findingsPath: entry.findingsPath,
    diagnosticsPath,
    payload
  };
}

interface ConversationResult {
  readonly qaCount: number;
  readonly hitAt1: number;
  readonly hitAt5: number;
  readonly hitAt10: number;
  readonly tierHot: number;
  readonly tierWarm: number;
  readonly tierCold: number;
  readonly latencies: readonly number[];
  readonly questionDiagnostics: readonly LongMemEvalQuestionDiagnostic[];
  readonly embeddingWarmup: BenchEmbeddingWarmupSummary | null;
  readonly queryEmbeddingWarmup: BenchQueryEmbeddingWarmupSummary | null;
  // Phase 7: one per-recall token-economy sample per QA in this
  // conversation. Degraded recalls (any non-null degradation_reason from
  // RecallService) emit no token_economy block, so the bench extractor
  // returns null and those samples are skipped (not pushed) — the
  // conversation-level array length therefore matches the number of
  // structurally-instrumented recalls, never the total recall count.
  // see also: packages/core/src/recall-service.ts
  // (computeRecallTokenEconomy call site).
  readonly recallTokenEconomySamples: readonly BenchRecallTokenEconomy[];
}

async function runOneConversation(
  conversation: LocomoSample,
  opts: LocomoRunOptions
): Promise<ConversationResult> {
  const embeddingMode = opts.embeddingMode ?? "disabled";
  const daemon = await startBenchDaemon({
    workspaceId: `locomo-${conversation.sample_id}`,
    runId: `run-${conversation.sample_id}`,
    embeddingMode,
    ...(opts.embeddingProviderKind === undefined
      ? {}
      : { embeddingProviderKind: opts.embeddingProviderKind })
  });
  try {
    const diaIdByMemoryId = new Map<string, string>();
    const memoryIdByDiaId = new Map<string, string>();
    const sessions = extractSessions(conversation.conversation);
    // invariant: rotate the seeded object_kind across each turn so the
    // archive witnesses both MaterializationRouter branches (memory-
    // only + memory-and-claim-draft). Recall surface is unchanged
    // (memory_entry is persisted in both branches).
    // see also: apps/bench-runner/src/harness/seed-rotation.ts
    let seedIndex = 0;
    for (const session of sessions) {
      // see also: longmemeval/runner.ts session-adjacent derives_from anchor
      let previousTurnSeedMemoryIds: readonly string[] = [];
      for (const turn of session.turns) {
        const seedContent = `${turn.speaker}: ${turn.text}`;
        const evidenceRef = `${conversation.sample_id}-${turn.dia_id}`;
        const seed = await daemon.proposeMemory(seedContent, evidenceRef, {
          objectKind: rotatingSeedObjectKind(seedIndex),
          ...(previousTurnSeedMemoryIds.length === 0
            ? {}
            : { sourceMemoryRefs: previousTurnSeedMemoryIds })
        });
        diaIdByMemoryId.set(seed.memoryId, turn.dia_id);
        memoryIdByDiaId.set(turn.dia_id, seed.memoryId);
        seedIndex += 1;
        previousTurnSeedMemoryIds = [seed.memoryId];
      }
    }

    const embeddingWarmup =
      opts.embeddingMode === "env"
        ? await daemon.warmEmbeddingCache([...memoryIdByDiaId.values()])
        : null;
    const scoredQuestions = conversation.qa.filter((qa) => qa.evidence.length > 0);
    const queryEmbeddingWarmup =
      opts.embeddingMode === "env"
        ? await daemon.warmQueryEmbeddingCache(scoredQuestions.map((qa) => qa.question))
        : null;

    let hitAt1 = 0;
    let hitAt5 = 0;
    let hitAt10 = 0;
    let tierHot = 0;
    let tierWarm = 0;
    let tierCold = 0;
    let scoredCount = 0;
    const latencies: number[] = [];
    const questionDiagnostics: LongMemEvalQuestionDiagnostic[] = [];
    const recallTokenEconomySamples: BenchRecallTokenEconomy[] = [];

    // invariant: R@K denominator counts only QAs with non-empty evidence.
    // LoCoMo category-5 (adversarial) and some other rows carry no
    // evidence; including them in the denominator would deflate
    // published R@K against external baselines that score the same
    // way.
    for (const qa of conversation.qa) {
      const evidenceSet = new Set(qa.evidence);
      if (evidenceSet.size === 0) {
        continue;
      }
      scoredCount += 1;
      const result = await runQuestion(daemon, qa);
      latencies.push(result.latencyMs);
      const ranked = result.pointers
        .slice(0, 10)
        .map((pointer) => diaIdByMemoryId.get(pointer.object_id));
      const hit1 = ranked[0] !== undefined && evidenceSet.has(ranked[0]);
      const hit5 = ranked.slice(0, 5).some((dia) => dia !== undefined && evidenceSet.has(dia));
      const hit10 = ranked.some((dia) => dia !== undefined && evidenceSet.has(dia));
      if (hit1) hitAt1 += 1;
      if (hit5) hitAt5 += 1;
      if (hit10) hitAt10 += 1;
      const firstScore = result.pointers[0]?.relevance_score ?? 0;
      if (firstScore >= 0.7) tierHot += 1;
      else if (firstScore >= 0.4) tierWarm += 1;
      else tierCold += 1;
      const evidenceIds = [...evidenceSet];
      questionDiagnostics.push(
        buildQuestionDiagnostic({
          questionId: `${conversation.sample_id}:${scoredCount}`,
          goldMemoryIds: evidenceIds
            .map((diaId) => memoryIdByDiaId.get(diaId))
            .filter((memoryId): memoryId is string => memoryId !== undefined),
          answerSessionIds: evidenceIds,
          deliveredResults: result.pointers.map((pointer, index) => ({
            object_id: pointer.object_id,
            rank: index + 1,
            relevance_score: pointer.relevance_score
          })),
          hitAt1: hit1,
          hitAt5: hit5,
          hitAt10: hit10,
          degradationReason: result.degradationReason,
          recallResult: result.recallResult,
          embeddingMode
        })
      );
      const tokenEconomySample = extractRecallTokenEconomy(result.recallResult);
      if (tokenEconomySample !== null) {
        recallTokenEconomySamples.push(tokenEconomySample);
      }
    }

    return {
      qaCount: scoredCount,
      hitAt1,
      hitAt5,
      hitAt10,
      tierHot,
      tierWarm,
      tierCold,
      latencies,
      questionDiagnostics,
      embeddingWarmup,
      queryEmbeddingWarmup,
      recallTokenEconomySamples
    };
  } finally {
    await daemon.shutdown();
  }
}

interface QaResult {
  readonly latencyMs: number;
  readonly pointers: ReadonlyArray<{ readonly object_id: string; readonly relevance_score: number }>;
  readonly degradationReason: string | null;
  readonly recallResult: unknown;
}

async function runQuestion(
  daemon: Awaited<ReturnType<typeof startBenchDaemon>>,
  qa: LocomoQa
): Promise<QaResult> {
  const recallStart = Date.now();
  const recallResult = await daemon.recall(qa.question, { maxResults: 10 });
  const latencyMs = Date.now() - recallStart;
  const pointers = recallResult.results.slice(0, 10).map((pointer) => ({
    object_id: pointer.object_id,
    relevance_score: pointer.relevance_score
  }));
  return {
    latencyMs,
    pointers,
    degradationReason: recallResult.degradation_reason ?? null,
    recallResult
  };
}

function computePercentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

function summarizeEmbeddingVectorCache(
  summaries: readonly BenchEmbeddingWarmupSummary[]
): LocomoEmbeddingVectorCacheSummary | null {
  const readySummaries = summaries.filter((summary) => summary.status === "ready");
  if (readySummaries.length === 0) {
    return null;
  }

  const expectedCount = readySummaries.reduce(
    (sum, summary) => sum + summary.expected_count,
    0
  );
  const readyCount = readySummaries.reduce(
    (sum, summary) => sum + summary.ready_count,
    0
  );
  const maxPassCount = readySummaries.reduce(
    (max, summary) => Math.max(max, summary.pass_count),
    0
  );

  return {
    expected_count: expectedCount,
    ready_count: readyCount,
    not_ready_count: Math.max(0, expectedCount - readyCount),
    ready_rate: expectedCount === 0 ? 0 : readyCount / expectedCount,
    max_pass_count: maxPassCount
  };
}

function summarizeQueryEmbeddingCache(
  summaries: readonly BenchQueryEmbeddingWarmupSummary[]
): LocomoQueryEmbeddingCacheSummary | null {
  const readySummaries = summaries.filter((summary) => summary.status === "ready");
  if (readySummaries.length === 0) {
    return null;
  }

  const requestedCount = readySummaries.reduce(
    (sum, summary) => sum + summary.requested_count,
    0
  );
  const readyCount = readySummaries.reduce(
    (sum, summary) => sum + summary.ready_count,
    0
  );
  const cacheHitCount = readySummaries.reduce(
    (sum, summary) => sum + summary.cache_hit_count,
    0
  );
  const providerRequestedCount = readySummaries.reduce(
    (sum, summary) => sum + summary.provider_requested_count,
    0
  );
  const lastError = [...readySummaries].reverse().find((summary) => summary.last_error !== undefined)?.last_error;

  return {
    requested_count: requestedCount,
    ready_count: readyCount,
    not_ready_count: Math.max(0, requestedCount - readyCount),
    ready_rate: requestedCount === 0 ? 0 : readyCount / requestedCount,
    cache_hit_count: cacheHitCount,
    provider_requested_count: providerRequestedCount,
    ...(lastError === undefined ? {} : { last_error: lastError })
  };
}

function resolveCommitSha7(): string {
  return resolveBenchCommitSha7();
}

// invariant: sample_size counts the scoreable-QA upper bound across
// the full dataset (every QA carrying non-empty evidence), not the
// number of conversations. evaluated_count is the subset this run
// actually scored, so evaluated_count <= sample_size holds even when
// --limit slices the conversation window.
export function resolveLocomoSampleSize(
  conversations: readonly LocomoSample[]
): number {
  let total = 0;
  for (const conv of conversations) {
    for (const qa of conv.qa) {
      if (qa.evidence.length > 0) {
        total += 1;
      }
    }
  }
  return total;
}
