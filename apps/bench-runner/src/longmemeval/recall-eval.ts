import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  benchArchiveDiscriminator,
  buildDiffVsPrevious,
  buildTokenEconomy,
  computeTokenSavedRatio,
  diffKpis,
  entrySlug,
  readLatest,
  renderFindings,
  renderReport,
  writeEntry,
  aggregateEdgeProposalAutoAccept,
  aggregateEdgeProposalRate,
  type BenchPolicyShape,
  type BenchSimulateReportMode,
  type BenchSplit,
  type EdgeProposalKpiEventRow,
  type HistoryLayout,
  type KpiPayload,
  type PerScenarioRow
} from "@do-soul/alaya-eval";
import {
  RECALL_PIPELINE_VERSION,
  resolveBenchCommitSha7,
  resolveBenchRunnerVersion
} from "../version.js";
import {
  startBenchDaemon,
  type BenchDaemonHandle,
  type BenchRecallOptions,
  type BenchTokenMetrics,
  type BenchWorkspaceHandle
} from "../harness/daemon.js";
import { aggregateBenchTokenMetrics } from "./token-economy.js";
import {
  aggregateRecallTokenEconomy,
  extractRecallTokenEconomy
} from "./recall-token-economy.js";
import type { BenchRecallTokenEconomy } from "../harness/recall-diagnostics-schema.js";
import {
  ALAYA_RECALL_WEIGHT_OVERRIDES_ENV,
  formatBenchRecallWeightOverrides,
  resolveBenchRecallWeightOverrides,
  type BenchRecallWeightOverrides
} from "../harness/recall-weight-overrides.js";
import {
  buildLongMemEvalQualityMetrics,
  buildQuestionDiagnostic,
  type LongMemEvalQuestionDiagnostic
} from "./diagnostics.js";
import { isAbstentionQuestionId } from "./abstention.js";
import { runLongMemEvalRecallCycle } from "./runner.js";
import {
  buildLongMemEvalSidecarKey,
  deriveLongMemEvalGoldMemoryIds,
  resolveLongMemEvalHitVerdict,
  type LongMemEvalSidecarEntry
} from "./runner.js";
import {
  assertSnapshotVersionMatch,
  readSnapshotManifest,
  readSnapshotSidecar,
  restoreSnapshotToDataDir,
  type LongMemEvalSnapshotManifest,
  type LongMemEvalSnapshotQuestion
} from "./snapshot.js";
import type { LongMemEvalVariant } from "./dataset.js";

/**
 * @anchor longmemeval-recall-eval
 *
 * Layer 2+3 (fast, every iteration). Restores a seeded-DB snapshot into a
 * working dataDirRoot, attaches the daemon to it, and runs PURE Layer-3 recall
 * per question — no LLM, no extraction, no materialization. Minutes for 100Q.
 *
 * It re-uses the seed-time scoring sidecar persisted alongside the snapshot, so
 * it never re-runs the seed loop. Recall-derived KPI fields (r_at_*, per-plane,
 * per-hop, per-edge-type, recall_token_economy, token_economy,
 * edge_proposal_rate) are computed from this run's recall; gate-only fields
 * (seed_extraction_path / seed_truncation / embedding warmup) are INHERITED
 * from the snapshot manifest's extraction provenance, marked
 * provenance-inherited, never recomputed.
 *
 * cross-file: apps/bench-runner/src/longmemeval/snapshot.ts (produce/restore)
 * cross-file: apps/bench-runner/src/longmemeval/runner.ts (shared scoring +
 *   recall cycle the slow path also uses)
 */

export interface RecallEvalOptions {
  readonly snapshotDbPath: string;
  readonly variant: LongMemEvalVariant;
  readonly limit?: number;
  readonly offset?: number;
  readonly historyRoot: string;
  readonly policyShape?: BenchPolicyShape;
  readonly simulateReport?: BenchSimulateReportMode;
  readonly weightOverridesJson?: string;
  /**
   * Override the restore directory (tests). Production allocates an mkdtemp
   * working copy so the frozen snapshot is never mutated by appended
   * delivery / lens events.
   */
  readonly dataDirRoot?: string;
}

export interface RecallEvalResult {
  readonly slug: string;
  readonly kpiPath: string;
  readonly reportPath: string;
  readonly findingsPath: string;
  readonly payload: KpiPayload;
  readonly snapshotManifest: LongMemEvalSnapshotManifest;
}

interface RecallEvalQuestionResult {
  readonly questionId: string;
  readonly hitAt1: boolean;
  readonly hitAt5: boolean;
  readonly hitAt10: boolean;
  readonly firstTier: "hot" | "warm" | "cold";
  readonly latencyMs: number;
  readonly degradationReason: string | null;
  readonly diagnostics: LongMemEvalQuestionDiagnostic;
  readonly tokenMetrics: BenchTokenMetrics;
  readonly recallTokenEconomy: BenchRecallTokenEconomy | null;
  readonly edgeProposalKpiRows: readonly EdgeProposalKpiEventRow[];
}

const VARIANT_TO_SPLIT: Record<LongMemEvalVariant, BenchSplit> = {
  longmemeval_oracle: "longmemeval-oracle",
  longmemeval_s: "longmemeval-s",
  longmemeval_m: "longmemeval-m"
};

/**
 * Run the recall-only feedback loop against a seeded-DB snapshot. Restores a
 * working copy, asserts the snapshot's code/migration version matches the
 * running binary, then recalls + scores every persisted question and emits the
 * normal KPI artifact for the recall-derived fields.
 */
export async function runRecallEval(
  options: RecallEvalOptions
): Promise<RecallEvalResult> {
  const recallWeightOverrides = resolveBenchRecallWeightOverrides({
    cliJson: options.weightOverridesJson,
    envJson: process.env[ALAYA_RECALL_WEIGHT_OVERRIDES_ENV]
  });
  if (recallWeightOverrides !== undefined) {
    process.stdout.write(
      `[recall-eval weights] ${formatBenchRecallWeightOverrides(recallWeightOverrides)}\n`
    );
  }

  const manifest = readSnapshotManifest(options.snapshotDbPath);
  const sidecarFile = readSnapshotSidecar(options.snapshotDbPath);

  const dataDirRoot =
    options.dataDirRoot ?? (await mkdtemp(join(tmpdir(), "alaya-recall-eval-")));
  restoreSnapshotToDataDir({
    snapshotDbPath: options.snapshotDbPath,
    dataDirRoot
  });
  // Version binding: refuse a snapshot whose recall pipeline / schema migration
  // disagrees with this binary BEFORE recall reads stale materialized state.
  assertSnapshotVersionMatch(manifest, join(dataDirRoot, "alaya.db"));

  const offset = Math.max(0, options.offset ?? 0);
  const sliceEnd =
    options.limit !== undefined ? offset + options.limit : sidecarFile.questions.length;
  const window = sidecarFile.questions.slice(offset, sliceEnd);

  const policyShape = options.policyShape ?? "stress";
  const simulateReport = options.simulateReport ?? "none";
  const recallOptions: BenchRecallOptions = {
    maxResults: 10,
    conflictAwareness: policyShape === "stress"
  };

  const alayaVersion = resolveBenchRunnerVersion();
  const commitSha7 = resolveBenchCommitSha7();
  const runAt = new Date();

  const collected: RecallEvalQuestionResult[] = [];
  const daemon = await startBenchDaemon({
    dataDirRoot,
    embeddingMode: "disabled",
    recallWeightOverrides
  });
  try {
    for (let i = 0; i < window.length; i++) {
      const question = window[i];
      if (question === undefined) continue;
      const result = await recallEvalOneQuestion({
        daemon,
        question,
        turnIndex: i + 1,
        recallOptions,
        simulateReport
      });
      collected.push(result);
      process.stdout.write(
        `[recall-eval ${i + 1}/${window.length}] ${question.questionId.slice(0, 8)} ` +
          `R@5=${result.hitAt5 ? "✓" : "✗"} latency=${result.latencyMs}ms\n`
      );
    }
  } finally {
    await daemon.shutdown();
  }

  const payload = assembleRecallEvalKpi({
    collected,
    manifest,
    variant: options.variant,
    runAt,
    commitSha7,
    alayaVersion,
    policyShape,
    simulateReport,
    sampleSize: sidecarFile.questions.length,
    evaluatedCount: window.length,
    recallWeightOverrides
  });

  const layout: HistoryLayout = { historyRoot: options.historyRoot };
  const previous = await readLatest(layout, "public", {
    split: payload.split,
    policyShape,
    simulateReport,
    embeddingProvider: payload.embedding_provider,
    pointerKind: "passing"
  });
  const diff = diffKpis(payload, previous);
  payload.diff_vs_previous = buildDiffVsPrevious(
    payload,
    previous,
    previous?.run_at ?? ""
  );
  const slug = entrySlug(
    runAt,
    commitSha7,
    benchArchiveDiscriminator(policyShape, simulateReport)
  );
  const report = renderReport(payload, previous, diff);
  const findings = renderFindings(payload, diff);
  const entry = await writeEntry(layout, "public", slug, payload, report, findings);

  return {
    slug,
    kpiPath: entry.kpiPath,
    reportPath: entry.reportPath,
    findingsPath: entry.findingsPath,
    payload,
    snapshotManifest: manifest
  };
}

async function recallEvalOneQuestion(input: {
  readonly daemon: BenchDaemonHandle;
  readonly question: LongMemEvalSnapshotQuestion;
  readonly turnIndex: number;
  readonly recallOptions: BenchRecallOptions;
  readonly simulateReport: BenchSimulateReportMode;
}): Promise<RecallEvalQuestionResult> {
  const { question } = input;
  const workspace: BenchWorkspaceHandle = await input.daemon.attachWorkspace({
    workspaceId: question.workspaceId,
    runId: question.runId
  });
  try {
    // Rebuild the in-memory scoring sidecar from the persisted entries.
    const sidecar = new Map<string, LongMemEvalSidecarEntry>();
    for (const entry of question.sidecar) {
      sidecar.set(buildLongMemEvalSidecarKey(entry.objectKind, entry.objectId), {
        objectId: entry.objectId,
        objectKind: entry.objectKind,
        sessionId: entry.sessionId,
        hasAnswer: entry.hasAnswer
      });
    }
    const answerSessionSet = new Set(question.answerSessionIds);
    const goldMemoryIds = deriveLongMemEvalGoldMemoryIds(sidecar, answerSessionSet);

    const recallCycle = await runLongMemEvalRecallCycle({
      daemon: workspace,
      query: question.question,
      recallOptions: input.recallOptions,
      simulateReport: input.simulateReport,
      goldMemoryIds,
      turnIndex: input.turnIndex,
      questionText: question.question
    });
    const recallResult = recallCycle.scoredRecallResult;
    const latencyMs = recallCycle.scoredRecallLatencyMs;
    const results = recallResult.results;
    const activeConstraintResults = (recallResult.active_constraints ?? []).map(
      (constraint, index) => ({ object_id: constraint.object_id, rank: index + 1 })
    );
    const deliveredResults = results.slice(0, 10).map((pointer, index) => ({
      object_id: pointer.object_id,
      object_kind: pointer.object_kind,
      rank: index + 1,
      relevance_score: pointer.relevance_score,
      score_factors: pointer.score_factors ?? null
    }));

    const isAbstention = isAbstentionQuestionId(question.questionId);
    const scoredHits = resolveLongMemEvalHitVerdict({
      isAbstention,
      results,
      sidecar,
      answerSessionIds: answerSessionSet
    });
    const diagnostics = buildQuestionDiagnostic({
      questionId: question.questionId,
      goldMemoryIds,
      answerSessionIds: question.answerSessionIds,
      deliveredResults,
      activeConstraintResults,
      hitAt1: scoredHits.hitAt1,
      hitAt5: scoredHits.hitAt5,
      hitAt10: scoredHits.hitAt10,
      isAbstention,
      degradationReason: recallResult.degradation_reason ?? null,
      recallResult,
      embeddingMode: "disabled"
    });
    const tokenMetrics = await workspace.queryTokenMetrics();
    const recallTokenEconomy = extractRecallTokenEconomy(recallResult);
    const edgeProposalKpiRows = await workspace.queryEdgeProposalKpiRows();

    return {
      questionId: question.questionId,
      hitAt1: scoredHits.hitAt1,
      hitAt5: scoredHits.hitAt5,
      hitAt10: scoredHits.hitAt10,
      firstTier: scoredHits.firstTier,
      latencyMs,
      degradationReason: recallResult.degradation_reason ?? null,
      diagnostics,
      tokenMetrics,
      recallTokenEconomy,
      edgeProposalKpiRows
    };
  } finally {
    await workspace.detach();
  }
}

function assembleRecallEvalKpi(input: {
  readonly collected: readonly RecallEvalQuestionResult[];
  readonly manifest: LongMemEvalSnapshotManifest;
  readonly variant: LongMemEvalVariant;
  readonly runAt: Date;
  readonly commitSha7: string;
  readonly alayaVersion: string;
  readonly policyShape: BenchPolicyShape;
  readonly simulateReport: BenchSimulateReportMode;
  readonly sampleSize: number;
  readonly evaluatedCount: number;
  readonly recallWeightOverrides: BenchRecallWeightOverrides | undefined;
}): KpiPayload {
  const perScenario: PerScenarioRow[] = [];
  const latencies: number[] = [];
  const questionDiagnostics: LongMemEvalQuestionDiagnostic[] = [];
  const tokenMetricsPerQuestion: BenchTokenMetrics[] = [];
  const recallTokenEconomySamples: BenchRecallTokenEconomy[] = [];
  const edgeProposalRowsAcross: EdgeProposalKpiEventRow[] = [];
  const edgeProposalRowsPerQuestion: EdgeProposalKpiEventRow[][] = [];
  let tierHot = 0;
  let tierWarm = 0;
  let tierCold = 0;
  let degradeNone = 0;
  let degradeWarm = 0;
  let degradeCold = 0;
  let degradePartial = 0;
  let totalHitAt1 = 0;
  let totalHitAt10 = 0;

  for (const res of input.collected) {
    questionDiagnostics.push(res.diagnostics);
    latencies.push(res.latencyMs);
    if (res.hitAt1) totalHitAt1++;
    if (res.hitAt10) totalHitAt10++;
    if (res.firstTier === "hot") tierHot++;
    else if (res.firstTier === "warm") tierWarm++;
    else tierCold++;
    if (res.degradationReason === "warm_cascade_engaged") degradeWarm++;
    else if (res.degradationReason === "cold_cascade_engaged") degradeCold++;
    else if (res.degradationReason === "recall_explainability_partial") degradePartial++;
    else degradeNone++;
    tokenMetricsPerQuestion.push(res.tokenMetrics);
    if (res.recallTokenEconomy !== null) {
      recallTokenEconomySamples.push(res.recallTokenEconomy);
    }
    for (const row of res.edgeProposalKpiRows) {
      edgeProposalRowsAcross.push(row);
    }
    edgeProposalRowsPerQuestion.push([...res.edgeProposalKpiRows]);
    perScenario.push({
      id: res.questionId,
      version: 1,
      hit_at_5: res.hitAt5,
      tier: res.firstTier,
      latency_ms: res.latencyMs
    });
  }

  const n = perScenario.length;
  const rAt1 = n === 0 ? 0 : totalHitAt1 / n;
  const rAt5 = n === 0 ? 0 : perScenario.filter((r) => r.hit_at_5).length / n;
  const rAt10 = n === 0 ? 0 : totalHitAt10 / n;
  const latencyP50 = computePercentile(latencies, 50);
  const latencyP95 = computePercentile(latencies, 95);

  const tokenEconomyInput = aggregateBenchTokenMetrics(tokenMetricsPerQuestion);
  const tokenEconomy = buildTokenEconomy(tokenEconomyInput);
  const tokenSavedRatio = computeTokenSavedRatio(tokenEconomyInput);
  const recallTokenEconomy = aggregateRecallTokenEconomy(recallTokenEconomySamples);
  const edgeProposalRate = aggregateEdgeProposalRate(
    edgeProposalRowsAcross,
    edgeProposalRowsPerQuestion
  );
  const edgeProposalAutoAccept = aggregateEdgeProposalAutoAccept(edgeProposalRowsAcross);

  const provenance = input.manifest.extraction_provenance;

  return {
    bench_name: "public",
    split: VARIANT_TO_SPLIT[input.variant],
    run_at: input.runAt.toISOString(),
    alaya_commit: input.commitSha7,
    alaya_version: input.alayaVersion,
    recall_pipeline_version: RECALL_PIPELINE_VERSION,
    embedding_provider: "none",
    chat_provider: "none",
    policy_shape: input.policyShape,
    simulate_report: input.simulateReport,
    ...(input.recallWeightOverrides === undefined
      ? {}
      : { recall_weight_overrides: input.recallWeightOverrides.summary }),
    dataset: {
      name: input.variant,
      size: input.sampleSize,
      source: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned",
      // Provenance-inherited from the snapshot manifest's extraction provenance;
      // recall-eval never re-reads the dataset, so the checksum is carried, not
      // recomputed. "snapshot-inherited" marks a snapshot built without a
      // pinned extraction manifest.
      checksum_sha256: provenance?.dataset_revision ?? "snapshot-inherited",
      checksum_source: `recall-eval snapshot ${input.manifest.db_filename}`
    },
    sample_size: input.sampleSize,
    evaluated_count: input.evaluatedCount,
    harness_mode: "mcp_propose_review",
    kpi: {
      r_at_1: rAt1,
      r_at_5: rAt5,
      r_at_10: rAt10,
      latency_ms_p50: latencyP50,
      latency_ms_p95: latencyP95,
      latency_source: "exact",
      token_saved_ratio_vs_full_prompt: tokenSavedRatio,
      token_economy: tokenEconomy,
      ...(recallTokenEconomy === null
        ? {}
        : { recall_token_economy: recallTokenEconomy }),
      tier_distribution: { hot: tierHot, warm: tierWarm, cold: tierCold },
      degradation_reasons: {
        none: degradeNone,
        warm_cascade_engaged: degradeWarm,
        cold_cascade_engaged: degradeCold,
        recall_explainability_partial: degradePartial
      },
      // Provenance-inherited (gate-only): recall-eval never re-seeds, so seed
      // truncation cannot be measured this run. The snapshot's seed run is the
      // gate authority; the fast loop reports zeros so the recall KPI shape
      // stays valid without faking seed-time figures.
      seed_truncation: {
        seed_turns_truncated: 0,
        answer_turns_truncated: 0,
        seed_chars_clipped: 0
      },
      quality_metrics: buildLongMemEvalQualityMetrics(questionDiagnostics),
      ...(edgeProposalRate === undefined ? {} : { edge_proposal_rate: edgeProposalRate }),
      ...(edgeProposalAutoAccept === undefined
        ? {}
        : { edge_proposal_auto_accept: edgeProposalAutoAccept }),
      per_scenario: perScenario
    }
  };
}

function computePercentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}
