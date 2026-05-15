import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
import { loadDataset, type FetchResult } from "./fetch.js";
import type { LongMemEvalVariant } from "./dataset.js";

const DEFAULT_BENCH_EMBEDDING_MODEL = "text-embedding-3-small";
const LONGMEMEVAL_DIAGNOSTICS_FILENAME = "longmemeval-diagnostics.json";

export interface LongMemEvalRunOptions {
  readonly variant: LongMemEvalVariant;
  readonly limit?: number;
  readonly historyRoot: string;
  readonly dataDir?: string;
  readonly fetchResult?: FetchResult;
  readonly embeddingMode?: BenchEmbeddingMode;
  // Override the pinned-checksum lookup root (test-only). Production
  // callers should leave this undefined so the canonical
  // docs/bench-history/datasets path is used.
  readonly pinnedMetaRoot?: string;
  // @anchor longmemeval-offset — skip the first N questions before
  // `limit`. Pairs with process-level sharding in
  // apps/bench-runner/scripts/run-full-public-bench.sh.
  readonly offset?: number;
}

export interface LongMemEvalRunResult {
  readonly slug: string;
  readonly kpiPath: string;
  readonly reportPath: string;
  readonly findingsPath: string;
  readonly diagnosticsPath: string | null;
  readonly payload: KpiPayload;
}

/**
 * @anchor longmemeval-runner — per-question workspace, seed-then-recall
 *
 * Scoring: object_id sidecar. Each seeded turn produces a durable memory
 * via the MCP propose+review chain (see harness/daemon.ts proposeMemory).
 * The returned memoryId is the durable object_id that soul.recall returns
 * in pointer.object_id, so scoring is by id equality — never by string
 * preview overlap.
 *
 * Hit rule: a recall result is a hit iff its object_id maps in the sidecar
 * to a seed whose hasAnswer === true AND whose sessionId is in
 * question.answer_session_ids.
 *
 * see also: apps/bench-runner/src/harness/daemon.ts — proposeMemory chain
 */
export async function runLongMemEval(
  opts: LongMemEvalRunOptions
): Promise<LongMemEvalRunResult> {
  const questions = await loadDataset(opts.variant, {
    dataDir: opts.dataDir,
    pinnedMetaRoot: opts.pinnedMetaRoot
  });
  const offset = Math.max(0, opts.offset ?? 0);
  const sliceEnd =
    opts.limit !== undefined ? offset + opts.limit : questions.length;
  const window = questions.slice(offset, sliceEnd);

  const alayaVersion = resolveAlayaVersion();
  const commitSha7 = resolveCommitSha7();
  const runAt = new Date();
  const embeddingProviderLabel = resolveBenchEmbeddingProviderLabel(
    opts.embeddingMode ?? "disabled"
  );

  // Sidecar maps durable memory object_id -> seed metadata. The harness
  // owns this map (the daemon doesn't need it). hasAnswer flags whether
  // the seed turn was tagged has_answer=true in the dataset.
  type SidecarEntry = { sessionId: string; hasAnswer: boolean };

  type WorkerResult = {
    questionId: string;
    hitAt1: boolean;
    hitAt5: boolean;
    hitAt10: boolean;
    firstTier: "hot" | "warm" | "cold";
    latencyMs: number;
    degradationReason: string | null;
    seedTurnsTruncated: number;
    answerTurnsTruncated: number;
    seedCharsClipped: number;
    diagnostics: LongMemEvalQuestionDiagnostic;
  };

  async function runOneQuestion(
    question: typeof window[number]
  ): Promise<WorkerResult> {
    const daemon = await startBenchDaemon({
      workspaceId: `lme-${question.question_id.slice(0, 8)}`,
      runId: `run-${question.question_id.slice(0, 8)}`,
      embeddingMode: opts.embeddingMode ?? "disabled"
    });
    try {
      const sidecar = new Map<string, SidecarEntry>();
      const answerSessionSet = new Set(question.answer_session_ids);
      let seedTurnsTruncated = 0;
      let answerTurnsTruncated = 0;
      let seedCharsClipped = 0;

      for (let si = 0; si < question.haystack_sessions.length; si++) {
        const session = question.haystack_sessions[si];
        const sessionId = question.haystack_session_ids[si] ?? `session-${si}`;
        if (session === undefined) continue;

        for (let ti = 0; ti < session.length; ti++) {
          const turn = session[ti];
          if (turn === undefined) continue;

          const evidenceRef = `${question.question_id}-s${si}-t${ti}`;
          const seed = await daemon.proposeMemory(turn.content, evidenceRef);
          if (seed.truncated) {
            seedTurnsTruncated++;
            seedCharsClipped += seed.charsClipped;
            if (turn.has_answer === true) answerTurnsTruncated++;
          }
          sidecar.set(seed.memoryId, {
            sessionId,
            hasAnswer: turn.has_answer === true
          });
        }
      }

      if (opts.embeddingMode === "env") {
        await daemon.runtime.runGardenBackgroundPass();
      }

      const recallStart = Date.now();
      const recallResult = await daemon.recall(question.question, { maxResults: 10 });
      const latencyMs = Date.now() - recallStart;

      const results = recallResult.results;
      const goldMemoryIds = [...sidecar.entries()]
        .filter(
          ([, meta]) =>
            meta.hasAnswer && answerSessionSet.has(meta.sessionId)
        )
        .map(([memoryId]) => memoryId);
      const deliveredResults = results.slice(0, 10).map((pointer, index) => ({
        object_id: pointer.object_id,
        rank: index + 1,
        relevance_score: pointer.relevance_score
      }));

      let hitAt1 = false;
      let hitAt5 = false;
      let hitAt10 = false;
      let firstTier: "hot" | "warm" | "cold" = "cold";

      for (let rank = 0; rank < results.length && rank < 10; rank++) {
        const pointer = results[rank];
        if (pointer === undefined) continue;
        if (rank === 0) {
          firstTier = inferTier(pointer.relevance_score);
        }
        const meta = sidecar.get(pointer.object_id);
        const isHit =
          meta !== undefined &&
          meta.hasAnswer &&
          answerSessionSet.has(meta.sessionId);
        if (isHit) {
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

      return {
        questionId: question.question_id,
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
      };
    } finally {
      await daemon.shutdown();
    }
  }

  // @anchor longmemeval-sequential — intra-process concurrency races
  // on the process.env mutated by startBenchDaemon (DATA_DIR /
  // ALAYA_CONFIG_DIR / HOME / ALAYA_REVIEWER_*).
  // see also: apps/bench-runner/scripts/run-full-public-bench.sh for
  // safe process-level sharding.
  const collected: WorkerResult[] = [];
  for (let i = 0; i < window.length; i++) {
    const q = window[i];
    if (q === undefined) continue;
    const res = await runOneQuestion(q);
    collected.push(res);
    process.stdout.write(
      `[${i + 1}/${window.length}] ${q.question_id.slice(0, 8)} ` +
        `R@5=${res.hitAt5 ? "✓" : "✗"} latency=${res.latencyMs}ms\n`
    );
  }

  const perScenario: PerScenarioRow[] = [];
  const latencies: number[] = [];
  let tierHot = 0;
  let tierWarm = 0;
  let tierCold = 0;
  let degradeNone = 0;
  let degradeWarm = 0;
  let degradeCold = 0;
  let degradePartial = 0;
  let totalHitAt1 = 0;
  let totalHitAt10 = 0;
  let truncSeedTotal = 0;
  let truncAnswerTotal = 0;
  let truncCharsTotal = 0;
  const questionDiagnostics: LongMemEvalQuestionDiagnostic[] = [];

  for (let i = 0; i < collected.length; i++) {
    const res = collected[i];
    if (res === null || res === undefined) continue;
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
    truncSeedTotal += res.seedTurnsTruncated;
    truncAnswerTotal += res.answerTurnsTruncated;
    truncCharsTotal += res.seedCharsClipped;
    perScenario.push({
      id: res.questionId,
      version: 1,
      hit_at_5: res.hitAt5,
      tier: res.firstTier
    });
  }

  const n = perScenario.length;
  const rAt1 = n === 0 ? 0 : totalHitAt1 / n;
  const rAt5 = n === 0 ? 0 : perScenario.filter((r) => r.hit_at_5).length / n;
  const rAt10 = n === 0 ? 0 : totalHitAt10 / n;
  const latencyP50 = computePercentile(latencies, 50);
  const latencyP95 = computePercentile(latencies, 95);
  const providerSummary = summarizeProviderStates(questionDiagnostics);
  const rAt5EmbeddingReturned = rAt5WithProviderReturned(questionDiagnostics);

  const datasetSize = opts.fetchResult?.questionCount ?? questions.length;

  // @anchor variant-to-split — exhaustive Record so a new
  // LongMemEvalVariant without a split mapping is a compile error.
  // see also: packages/eval/src/kpi-schema.ts BenchSplit enum.
  const VARIANT_TO_SPLIT: Record<typeof opts.variant, BenchSplit> = {
    longmemeval_oracle: "longmemeval-oracle",
    longmemeval_s: "longmemeval-s",
    longmemeval_m: "longmemeval-m"
  };
  const split = VARIANT_TO_SPLIT[opts.variant];

  const payload: KpiPayload = {
    bench_name: "public",
    split,
    run_at: runAt.toISOString(),
    alaya_commit: commitSha7,
    alaya_version: alayaVersion,
    embedding_provider: embeddingProviderLabel,
    chat_provider: "none",
    dataset: {
      name: opts.variant,
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
      // @anchor token_saved_ratio — set to 0 until a token-budget baseline exists
      token_saved_ratio_vs_full_prompt: 0,
      tier_distribution: { hot: tierHot, warm: tierWarm, cold: tierCold },
      degradation_reasons: {
        none: degradeNone,
        warm_cascade_engaged: degradeWarm,
        cold_cascade_engaged: degradeCold,
        recall_explainability_partial: degradePartial
      },
      seed_truncation: {
        seed_turns_truncated: truncSeedTotal,
        answer_turns_truncated: truncAnswerTotal,
        seed_chars_clipped: truncCharsTotal
      },
      per_scenario: perScenario
    }
  };

  const layout: HistoryLayout = { historyRoot: opts.historyRoot };
  // Diff against the latest entry of the SAME split — Oracle vs S are
  // not comparable retrieval evaluations (Oracle's session filter is
  // no-op, S's is meaningful). See packages/eval/src/history.ts
  // @anchor read-latest-split-aware.
  const previous = await readLatest(layout, "public", { split: payload.split });
  const diff = diffKpis(payload, previous);
  const slug = entrySlug(runAt, commitSha7);

  const report = renderReport(payload, previous, diff);
  const findings = renderFindings(payload, diff);

  const diagnosticsSidecar = renderDiagnosticsSidecar({
    schema_version: 1,
    bench_name: "public",
    split,
    run_at: payload.run_at,
    alaya_commit: payload.alaya_commit,
    embedding_provider: payload.embedding_provider,
    embedding_mode: opts.embeddingMode ?? "disabled",
    provider_state_summary: providerSummary,
    questions: questionDiagnostics
  });
  const entry = await writeEntry(layout, "public", slug, payload, report, findings, {
    sidecars: [
      {
        filename: LONGMEMEVAL_DIAGNOSTICS_FILENAME,
        contents: diagnosticsSidecar
      }
    ]
  });
  return {
    slug,
    kpiPath: entry.kpiPath,
    reportPath: entry.reportPath,
    findingsPath: entry.findingsPath,
    diagnosticsPath: entry.sidecarPaths[LONGMEMEVAL_DIAGNOSTICS_FILENAME] ?? null,
    payload
  };
}

export function resolveBenchEmbeddingProviderLabel(
  embeddingMode: BenchEmbeddingMode,
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  if (embeddingMode === "disabled") {
    return "none";
  }

  const model = env.OPENAI_EMBEDDING_MODEL?.trim() || DEFAULT_BENCH_EMBEDDING_MODEL;
  const providerUrl = env.OPENAI_EMBEDDING_PROVIDER_URL?.trim();
  if (providerUrl === undefined || providerUrl.length === 0) {
    return `openai:${model}`;
  }

  return `${labelEmbeddingProviderUrl(providerUrl)}:${model}`;
}

function labelEmbeddingProviderUrl(providerUrl: string): string {
  try {
    const hostname = new URL(providerUrl).hostname.toLowerCase();
    if (hostname.includes("yunwu")) {
      return "yunwu";
    }
  } catch {
    return "openai-compatible";
  }

  return "openai-compatible";
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

function resolveAlayaVersion(): string {
  try {
    const pkgPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../package.json"
    );
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
    return pkg.version;
  } catch {
    return "0.3.7";
  }
}

function resolveCommitSha7(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "0000000";
  }
}

export type { LongMemEvalVariant };
