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
  type HistoryLayout,
  type KpiPayload,
  type PerScenarioRow
} from "@do-soul/alaya-eval";
import { startBenchDaemon } from "../harness/daemon.js";
import { loadDataset, type FetchResult } from "./fetch.js";
import type { LongMemEvalVariant } from "./dataset.js";

export interface LongMemEvalRunOptions {
  readonly variant: LongMemEvalVariant;
  readonly limit?: number;
  readonly historyRoot: string;
  readonly dataDir?: string;
  readonly fetchResult?: FetchResult;
}

export interface LongMemEvalRunResult {
  readonly slug: string;
  readonly kpiPath: string;
  readonly reportPath: string;
  readonly findingsPath: string;
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
  const questions = await loadDataset(opts.variant, { dataDir: opts.dataDir });
  const window = opts.limit !== undefined ? questions.slice(0, opts.limit) : questions;

  const alayaVersion = resolveAlayaVersion();
  const commitSha7 = resolveCommitSha7();
  const runAt = new Date();

  // Sidecar maps durable memory object_id -> seed metadata. The harness
  // owns this map (the daemon doesn't need it). hasAnswer flags whether
  // the seed turn was tagged has_answer=true in the dataset.
  type SidecarEntry = { sessionId: string; hasAnswer: boolean };

  const perScenario: PerScenarioRow[] = [];
  const latencies: number[] = [];
  let tierHot = 0;
  let tierWarm = 0;
  let tierCold = 0;
  let degradeNone = 0;
  let degradeWarm = 0;
  let degradeCold = 0;
  let totalHitAt1 = 0;
  let totalHitAt10 = 0;

  for (const question of window) {
    const daemon = await startBenchDaemon({
      workspaceId: `lme-${question.question_id.slice(0, 8)}`,
      runId: `run-${question.question_id.slice(0, 8)}`
    });

    try {
      const sidecar = new Map<string, SidecarEntry>();
      const answerSessionSet = new Set(question.answer_session_ids);

      for (let si = 0; si < question.haystack_sessions.length; si++) {
        const session = question.haystack_sessions[si];
        const sessionId = question.haystack_session_ids[si] ?? `session-${si}`;
        if (session === undefined) continue;

        for (let ti = 0; ti < session.length; ti++) {
          const turn = session[ti];
          if (turn === undefined) continue;

          const evidenceRef = `${question.question_id}-s${si}-t${ti}`;
          const seed = await daemon.proposeMemory(turn.content, evidenceRef);
          sidecar.set(seed.memoryId, {
            sessionId,
            hasAnswer: turn.has_answer === true
          });
        }
      }

      const recallStart = Date.now();
      const recallResult = await daemon.recall(question.question, { maxResults: 10 });
      const latencyMs = Date.now() - recallStart;
      latencies.push(latencyMs);

      const results = recallResult.results;

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

        // object_id equality scoring: a hit is a recall pointer whose
        // object_id maps to a seed flagged has_answer=true on an answer
        // session. No content-preview overlap. No prefix string match.
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

      if (hitAt1) totalHitAt1++;
      if (hitAt10) totalHitAt10++;

      if (firstTier === "hot") tierHot++;
      else if (firstTier === "warm") tierWarm++;
      else tierCold++;

      // degradation_reason is read directly off the daemon's recall response
      // — never echoed from seed counts. null = no cascade engaged.
      const degradationReason = recallResult.degradation_reason ?? null;
      if (degradationReason === "warm_cascade_engaged") degradeWarm++;
      else if (degradationReason === "cold_cascade_engaged") degradeCold++;
      else degradeNone++;

      perScenario.push({
        id: question.question_id,
        version: 1,
        hit_at_5: hitAt5,
        tier: firstTier
      });
    } finally {
      await daemon.shutdown();
    }
  }

  const n = perScenario.length;
  const rAt1 = n === 0 ? 0 : totalHitAt1 / n;
  const rAt5 = n === 0 ? 0 : perScenario.filter((r) => r.hit_at_5).length / n;
  const rAt10 = n === 0 ? 0 : totalHitAt10 / n;
  const latencyP50 = computePercentile(latencies, 50);
  const latencyP95 = computePercentile(latencies, 95);

  const datasetSize = opts.fetchResult?.questionCount ?? questions.length;

  const payload: KpiPayload = {
    bench_name: "public",
    split: "longmemeval-s",
    run_at: runAt.toISOString(),
    alaya_commit: commitSha7,
    alaya_version: alayaVersion,
    embedding_provider: "none",
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
      latency_ms_p50: latencyP50,
      latency_ms_p95: latencyP95,
      // @anchor token_saved_ratio — set to 0 until a token-budget baseline exists
      token_saved_ratio_vs_full_prompt: 0,
      tier_distribution: { hot: tierHot, warm: tierWarm, cold: tierCold },
      degradation_reasons: {
        none: degradeNone,
        warm_cascade_engaged: degradeWarm,
        cold_cascade_engaged: degradeCold
      },
      per_scenario: perScenario
    }
  };

  const layout: HistoryLayout = { historyRoot: opts.historyRoot };
  const previous = await readLatest(layout, "public");
  const diff = diffKpis(payload, previous);
  const slug = entrySlug(runAt, commitSha7);

  const report = renderReport(payload, previous, diff);
  const findings = renderFindings(payload, diff);

  const entry = await writeEntry(layout, "public", slug, payload, report, findings);
  return {
    slug,
    kpiPath: entry.kpiPath,
    reportPath: entry.reportPath,
    findingsPath: entry.findingsPath,
    payload
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

function resolveAlayaVersion(): string {
  try {
    const pkgPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../package.json"
    );
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
    return pkg.version;
  } catch {
    return "0.3.6";
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
