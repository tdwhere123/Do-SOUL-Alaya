import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RECALL_PIPELINE_VERSION, resolveBenchRunnerVersion } from "../version.js";
import { rotatingSeedObjectKind } from "../harness/seed-rotation.js";
import {
  diffKpis,
  entrySlug,
  readLatest,
  renderFindings,
  renderReport,
  writeEntry,
  type BenchSplit,
  type HistoryLayout,
  type KpiPayload,
  type PerScenarioRow
} from "@do-soul/alaya-eval";
import { startBenchDaemon, type BenchEmbeddingMode } from "../harness/daemon.js";
import {
  buildQuestionDiagnostic,
  rAt5WithProviderReturned,
  renderDiagnosticsSidecar,
  summarizeProviderStates,
  type LongMemEvalQuestionDiagnostic
} from "./diagnostics.js";
import type { LongMemEvalVariant } from "./dataset.js";
import { loadDataset, type FetchResult } from "./fetch.js";
import { resolveBenchEmbeddingProviderLabel } from "./runner.js";

const LONGMEMEVAL_DIAGNOSTICS_FILENAME = "longmemeval-diagnostics.json";

export interface LongMemEvalCrossQuestionRunOptions {
  readonly variant: LongMemEvalVariant;
  readonly limit?: number;
  readonly historyRoot: string;
  readonly dataDir?: string;
  readonly fetchResult?: FetchResult;
  readonly embeddingMode?: BenchEmbeddingMode;
  readonly pinnedMetaRoot?: string;
  readonly offset?: number;
}

export interface LongMemEvalCrossQuestionRunResult {
  readonly slug: string;
  readonly kpiPath: string;
  readonly reportPath: string;
  readonly findingsPath: string;
  readonly diagnosticsPath: string | null;
  readonly payload: KpiPayload;
}

// Each seeded memory carries its source question + session so per-question
// hit judgement can ignore gold memories that belong to other questions.
// The whole point of cross-question harness is a shared workspace, so
// memories from question A coexist with question B's haystack in one pool.
interface SidecarEntry {
  readonly questionId: string;
  readonly sessionId: string;
  readonly hasAnswer: boolean;
}

interface QuestionResult {
  readonly questionId: string;
  readonly questionIndex: number;
  readonly hitAt1: boolean;
  readonly hitAt5: boolean;
  readonly hitAt10: boolean;
  readonly firstTier: "hot" | "warm" | "cold";
  readonly latencyMs: number;
  readonly degradationReason: string | null;
  readonly seedTurnsTruncated: number;
  readonly answerTurnsTruncated: number;
  readonly seedCharsClipped: number;
  readonly diagnostics: LongMemEvalQuestionDiagnostic;
}

export async function runLongMemEvalCrossQuestion(
  opts: LongMemEvalCrossQuestionRunOptions
): Promise<LongMemEvalCrossQuestionRunResult> {
  const questions = await loadDataset(opts.variant, {
    dataDir: opts.dataDir,
    pinnedMetaRoot: opts.pinnedMetaRoot
  });
  const offset = Math.max(0, opts.offset ?? 0);
  const sliceEnd =
    opts.limit !== undefined ? offset + opts.limit : questions.length;
  const window = questions.slice(offset, sliceEnd);

  const alayaVersion = resolveBenchRunnerVersion();
  const commitSha7 = resolveCommitSha7();
  const runAt = new Date();
  const embeddingProviderLabel = resolveBenchEmbeddingProviderLabel(
    opts.embeddingMode ?? "disabled"
  );

  // One daemon, one workspace, one run for the full question sequence.
  // RECALLS edges and path plasticity accumulate across questions.
  const daemon = await startBenchDaemon({
    workspaceId: `lme-cq-shared-${commitSha7}`,
    runId: `run-cq-${commitSha7}-${runAt.getTime()}`,
    embeddingMode: opts.embeddingMode ?? "disabled"
  });

  const sidecar = new Map<string, SidecarEntry>();
  const collected: QuestionResult[] = [];

  try {
    for (let qi = 0; qi < window.length; qi++) {
      const question = window[qi];
      if (question === undefined) continue;

      // Seed this question's haystack into the shared workspace. Other
      // questions' seeds remain present; this is the design.
      let seedTurnsTruncated = 0;
      let answerTurnsTruncated = 0;
      let seedCharsClipped = 0;
      // see also: apps/bench-runner/src/harness/seed-rotation.ts
      let seedIndex = 0;
      for (let si = 0; si < question.haystack_sessions.length; si++) {
        const session = question.haystack_sessions[si];
        const sessionId = question.haystack_session_ids[si] ?? `${question.question_id}-session-${si}`;
        if (session === undefined) continue;
        for (let ti = 0; ti < session.length; ti++) {
          const turn = session[ti];
          if (turn === undefined) continue;
          const evidenceRef = `${question.question_id}-cq-s${si}-t${ti}`;
          const seed = await daemon.proposeMemory(turn.content, evidenceRef, {
            objectKind: rotatingSeedObjectKind(seedIndex)
          });
          seedIndex += 1;
          if (seed.truncated) {
            seedTurnsTruncated++;
            seedCharsClipped += seed.charsClipped;
            if (turn.has_answer === true) answerTurnsTruncated++;
          }
          sidecar.set(seed.memoryId, {
            questionId: question.question_id,
            sessionId,
            hasAnswer: turn.has_answer === true
          });
        }
      }

      if (opts.embeddingMode === "env") {
        await daemon.runtime.runGardenBackgroundPass();
      }

      const answerSessionSet = new Set(question.answer_session_ids);
      const goldMemoryIds = [...sidecar.entries()]
        .filter(
          ([, meta]) =>
            meta.questionId === question.question_id &&
            meta.hasAnswer &&
            answerSessionSet.has(meta.sessionId)
        )
        .map(([memoryId]) => memoryId);

      const recallStart = Date.now();
      const recallResult = await daemon.recall(question.question, {
        maxResults: 10
      });
      const latencyMs = Date.now() - recallStart;
      const results = recallResult.results;
      const deliveredResults = results.slice(0, 10).map((pointer, index) => ({
        object_id: pointer.object_id,
        rank: index + 1,
        relevance_score: pointer.relevance_score,
        score_factors: pointer.score_factors ?? null
      }));

      let hitAt1 = false;
      let hitAt5 = false;
      let hitAt10 = false;
      let firstTier: "hot" | "warm" | "cold" = "cold";
      const usedGoldObjectIds: string[] = [];

      for (let rank = 0; rank < results.length && rank < 10; rank++) {
        const pointer = results[rank];
        if (pointer === undefined) continue;
        if (rank === 0) {
          firstTier = inferTier(pointer.relevance_score);
        }
        const meta = sidecar.get(pointer.object_id);
        // hit only if the recalled memory belongs to THIS question AND its
        // turn was an answer turn AND its session is one of the answer
        // sessions. Cross-question gold leakage would inflate the score.
        const isHit =
          meta !== undefined &&
          meta.questionId === question.question_id &&
          meta.hasAnswer &&
          answerSessionSet.has(meta.sessionId);
        if (isHit) {
          usedGoldObjectIds.push(pointer.object_id);
          if (rank === 0) hitAt1 = true;
          if (rank < 5) hitAt5 = true;
          hitAt10 = true;
        }
      }

      const diagnostics = buildQuestionDiagnostic({
        questionId: question.question_id,
        goldMemoryIds,
        answerSessionIds: question.answer_session_ids,
        deliveredResults,
        hitAt1,
        hitAt5,
        hitAt10,
        degradationReason: recallResult.degradation_reason ?? null,
        recallResult,
        embeddingMode: opts.embeddingMode ?? "disabled"
      });

      await daemon.reportContextUsage({
        deliveryId: recallResult.delivery_id,
        usageState: usedGoldObjectIds.length > 0 ? "used" : "skipped",
        ...(usedGoldObjectIds.length === 0
          ? {}
          : { usedObjectIds: usedGoldObjectIds }),
        deliveredObjects: results.slice(0, 10).map((pointer) => ({
          objectId: pointer.object_id,
          usageStatus: usedGoldObjectIds.includes(pointer.object_id)
            ? "used"
            : "skipped"
        })),
        turnIndex: qi + 1,
        turnDigest: {
          lastMessages: [
            {
              role: "user",
              contentExcerpt: truncateExcerpt(question.question)
            }
          ]
        },
        reason:
          usedGoldObjectIds.length > 0
            ? `LongMemEval cross-question #${qi + 1}: gold pointer delivered.`
            : `LongMemEval cross-question #${qi + 1}: gold pointer not delivered.`
      });

      collected.push({
        questionId: question.question_id,
        questionIndex: qi + 1,
        hitAt1,
        hitAt5,
        hitAt10,
        firstTier,
        latencyMs,
        degradationReason: recallResult.degradation_reason ?? null,
        seedTurnsTruncated,
        answerTurnsTruncated,
        seedCharsClipped,
        diagnostics
      });

      process.stdout.write(
        `[${qi + 1}/${window.length}] ${question.question_id.slice(0, 8)} ` +
          `R@5=${hitAt5 ? "✓" : "✗"} pool=${sidecar.size}\n`
      );
    }
  } finally {
    await daemon.shutdown();
  }

  const perScenario: PerScenarioRow[] = collected.map((result) => ({
    id: result.questionId,
    version: 1,
    hit_at_5: result.hitAt5,
    tier: result.firstTier
  }));
  const allDiagnostics = collected.map((result) => result.diagnostics);
  const providerSummary = summarizeProviderStates(allDiagnostics);
  const rAt5EmbeddingReturned = rAt5WithProviderReturned(allDiagnostics);

  const n = collected.length;
  const rAt1 = ratio(collected.filter((r) => r.hitAt1).length, n);
  const rAt5 = ratio(collected.filter((r) => r.hitAt5).length, n);
  const rAt10 = ratio(collected.filter((r) => r.hitAt10).length, n);
  // First-half vs last-half R@5 is the headline cross-question signal.
  // If shared-workspace accumulation does anything, last_half > first_half.
  const half = Math.floor(n / 2);
  const firstHalf = collected.slice(0, half);
  const lastHalf = collected.slice(n - half);
  const rAt5FirstHalf =
    half > 0
      ? ratio(firstHalf.filter((r) => r.hitAt5).length, firstHalf.length)
      : undefined;
  const rAt5LastHalf =
    half > 0
      ? ratio(lastHalf.filter((r) => r.hitAt5).length, lastHalf.length)
      : undefined;
  const latencyP50 = computePercentile(collected.map((r) => r.latencyMs), 50);
  const latencyP95 = computePercentile(collected.map((r) => r.latencyMs), 95);
  const tierDistribution = countTiers(collected);
  const degradationReasons = countDegradationReasons(collected);
  const truncation = {
    seed_turns_truncated: collected.reduce(
      (acc, r) => acc + r.seedTurnsTruncated,
      0
    ),
    answer_turns_truncated: collected.reduce(
      (acc, r) => acc + r.answerTurnsTruncated,
      0
    ),
    seed_chars_clipped: collected.reduce(
      (acc, r) => acc + r.seedCharsClipped,
      0
    )
  };

  const datasetSize = opts.fetchResult?.questionCount ?? questions.length;
  const split = variantToSplit(opts.variant);
  const payload: KpiPayload = {
    bench_name: "public-crossquestion",
    split,
    run_at: runAt.toISOString(),
    alaya_commit: commitSha7,
    alaya_version: alayaVersion,
    recall_pipeline_version: RECALL_PIPELINE_VERSION,
    embedding_provider: embeddingProviderLabel,
    chat_provider: "none",
    policy_shape: "stress",
    simulate_report: "none",
    dataset: {
      name: `${opts.variant}:crossquestion`,
      size: datasetSize,
      source: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned"
    },
    sample_size: datasetSize,
    evaluated_count: window.length,
    harness_mode: "mcp_propose_review",
    kpi: {
      r_at_1: rAt1,
      r_at_5: rAt5,
      r_at_10: rAt10,
      ...(rAt5FirstHalf === undefined ? {} : { r_at_5_first_half: rAt5FirstHalf }),
      ...(rAt5LastHalf === undefined ? {} : { r_at_5_last_half: rAt5LastHalf }),
      crossquestion_questions: n,
      ...(opts.embeddingMode === "env"
        ? {
            r_at_5_overall: rAt5,
            ...(rAt5EmbeddingReturned === undefined
              ? {}
              : { r_at_5_with_embedding_returned: rAt5EmbeddingReturned }),
            provider_returned_rate: providerSummary.provider_returned_rate,
            provider_pending_rate: providerSummary.provider_pending_rate,
            provider_failed_rate: providerSummary.provider_failed_rate
          }
        : {}),
      latency_ms_p50: latencyP50,
      latency_ms_p95: latencyP95,
      latency_source: "exact",
      token_saved_ratio_vs_full_prompt: 0,
      tier_distribution: tierDistribution,
      degradation_reasons: degradationReasons,
      seed_truncation: truncation,
      per_scenario: perScenario
    }
  };

  const layout: HistoryLayout = { historyRoot: opts.historyRoot };
  const previous = await readLatest(layout, "public-crossquestion", {
    split: payload.split,
    embeddingProvider: payload.embedding_provider
  });
  const diff = diffKpis(payload, previous);
  const slug = entrySlug(runAt, commitSha7);
  const report = renderReport(payload, previous, diff);
  const findings = renderFindings(payload, diff);
  const diagnosticsSidecar = renderDiagnosticsSidecar({
    schema_version: 1,
    bench_name: "public-crossquestion",
    split,
    run_at: payload.run_at,
    alaya_commit: payload.alaya_commit,
    recall_pipeline_version: payload.recall_pipeline_version,
    embedding_provider: payload.embedding_provider,
    embedding_mode: opts.embeddingMode ?? "disabled",
    provider_state_summary: providerSummary,
    questions: allDiagnostics
  });

  const entry = await writeEntry(
    layout,
    "public-crossquestion",
    slug,
    payload,
    report,
    findings,
    {
      sidecars: [
        {
          filename: LONGMEMEVAL_DIAGNOSTICS_FILENAME,
          contents: diagnosticsSidecar
        }
      ]
    }
  );
  return {
    slug,
    kpiPath: entry.kpiPath,
    reportPath: entry.reportPath,
    findingsPath: entry.findingsPath,
    diagnosticsPath: entry.sidecarPaths[LONGMEMEVAL_DIAGNOSTICS_FILENAME] ?? null,
    payload
  };
}

function variantToSplit(variant: LongMemEvalVariant): BenchSplit {
  const map: Record<LongMemEvalVariant, BenchSplit> = {
    longmemeval_oracle: "longmemeval-oracle",
    longmemeval_s: "longmemeval-s",
    longmemeval_m: "longmemeval-m"
  };
  return map[variant];
}

function countTiers(rows: readonly QuestionResult[]): {
  readonly hot: number;
  readonly warm: number;
  readonly cold: number;
} {
  let hot = 0;
  let warm = 0;
  let cold = 0;
  for (const row of rows) {
    if (row.firstTier === "hot") hot++;
    else if (row.firstTier === "warm") warm++;
    else cold++;
  }
  return { hot, warm, cold };
}

function countDegradationReasons(rows: readonly QuestionResult[]): {
  readonly none: number;
  readonly warm_cascade_engaged: number;
  readonly cold_cascade_engaged: number;
  readonly recall_explainability_partial: number;
} {
  let none = 0;
  let warm = 0;
  let cold = 0;
  let partial = 0;
  for (const row of rows) {
    if (row.degradationReason === "warm_cascade_engaged") warm++;
    else if (row.degradationReason === "cold_cascade_engaged") cold++;
    else if (row.degradationReason === "recall_explainability_partial") partial++;
    else none++;
  }
  return {
    none,
    warm_cascade_engaged: warm,
    cold_cascade_engaged: cold,
    recall_explainability_partial: partial
  };
}

function inferTier(relevanceScore: number): "hot" | "warm" | "cold" {
  if (relevanceScore >= 0.7) return "hot";
  if (relevanceScore >= 0.4) return "warm";
  return "cold";
}

function computePercentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

function ratio(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}

function truncateExcerpt(value: string): string {
  return value.length <= 500 ? value : `${value.slice(0, 497)}...`;
}

// see also: apps/bench-runner/src/version.ts

function resolveCommitSha7(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "0000000";
  }
}
