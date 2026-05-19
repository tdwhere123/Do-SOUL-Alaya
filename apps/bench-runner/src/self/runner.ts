import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
  type HistoryLayout,
  type KpiPayload,
  type PerScenarioRow
} from "@do-soul/alaya-eval";
import { startBenchDaemon } from "../harness/daemon.js";
import { SYNTHETIC_SCENARIOS } from "./scenarios.js";

export interface SelfBenchRunOptions {
  readonly historyRoot: string;
}

export interface SelfBenchRunResult {
  readonly slug: string;
  readonly kpiPath: string;
  readonly reportPath: string;
  readonly findingsPath: string;
  readonly payload: KpiPayload;
}

/**
 * @anchor self-bench-runner — in-process daemon, 8 synthetic scenarios + distractors
 *
 * @invariant Hits are scored by object_id set membership against a
 *   sidecar populated only from setup seeds — never by substring overlap
 *   on recall preview text. Distractors are seeded so the recall search
 *   space is not trivially small, but their object_id is intentionally
 *   not entered in the sidecar, so a distractor recall occupies a top-K
 *   slot without scoring.
 *
 * Hit rule: a recall pointer is a hit iff its object_id maps in the
 * sidecar to an expected_id from scenario.expected_ids.
 *
 * see also: apps/bench-runner/src/harness/daemon.ts — proposeMemory chain
 * see also: apps/bench-runner/src/self/scenarios.ts — setup + distractor pairs
 */
export async function runSelfBench(opts: SelfBenchRunOptions): Promise<SelfBenchRunResult> {
  const alayaVersion = resolveBenchRunnerVersion();
  const commitSha7 = resolveCommitSha7();
  const runAt = new Date();

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

  for (const scenario of SYNTHETIC_SCENARIOS) {
    const daemon = await startBenchDaemon({
      workspaceId: `self-${scenario.id}`,
      runId: `run-${scenario.id}`
    });

    try {
      // Sidecar maps durable memory object_id -> the scenario's expected_id
      // (e.g. "syn-001-s0"). Only setup seeds populate the sidecar.
      const sidecar = new Map<string, string>();
      const expectedIdSet = new Set(scenario.expected_ids);
      // see also: apps/bench-runner/src/harness/seed-rotation.ts
      let seedIndex = 0;

      for (let i = 0; i < scenario.setup.length; i++) {
        const content = scenario.setup[i];
        if (content === undefined) continue;
        const expectedId = `${scenario.id}-s${i}`;
        const evidenceRef = `${scenario.id}-setup-${i}`;
        const seed = await daemon.proposeMemory(content, evidenceRef, {
          objectKind: rotatingSeedObjectKind(seedIndex)
        });
        seedIndex += 1;
        if (seed.truncated) {
          truncSeedTotal++;
          truncAnswerTotal++;
          truncCharsTotal += seed.charsClipped;
        }
        sidecar.set(seed.memoryId, expectedId);
      }

      // Distractors expand the recall search space. Their memoryId is not
      // recorded. If the recall returns one, it occupies a top-K slot
      // but the scoring loop sees `sidecar.get` return undefined and
      // counts no hit.
      for (let i = 0; i < scenario.distractors.length; i++) {
        const content = scenario.distractors[i];
        if (content === undefined) continue;
        const evidenceRef = `${scenario.id}-distractor-${i}`;
        const seed = await daemon.proposeMemory(content, evidenceRef, {
          objectKind: rotatingSeedObjectKind(seedIndex)
        });
        seedIndex += 1;
        if (seed.truncated) {
          truncSeedTotal++;
          truncCharsTotal += seed.charsClipped;
        }
      }

      const recallStart = Date.now();
      const recallResult = await daemon.recall(scenario.probe, { maxResults: 10 });
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
        // sidecar-mapped expected_id appears in scenario.expected_ids.
        const expectedId = sidecar.get(pointer.object_id);
        const isHit = expectedId !== undefined && expectedIdSet.has(expectedId);

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

      // degradation_reason is read directly off the daemon's recall response.
      // For self-bench scenarios the workspace is small (2 setups +
      // 3-5 distractors), so the warm/cold cascade fires for many probes
      // That is real recall behavior, not a harness bug. See
      // README "Bench harness - degradation diagnostics" for the
      // operator-facing diagnosis.
      const degradationReason = recallResult.degradation_reason ?? null;
      if (degradationReason === "warm_cascade_engaged") degradeWarm++;
      else if (degradationReason === "cold_cascade_engaged") degradeCold++;
      else if (degradationReason === "recall_explainability_partial") degradePartial++;
      else degradeNone++;

      perScenario.push({
        id: scenario.id,
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

  const payload: KpiPayload = {
    bench_name: "self",
    split: "synthetic",
    run_at: runAt.toISOString(),
    alaya_commit: commitSha7,
    alaya_version: alayaVersion,
    recall_pipeline_version: RECALL_PIPELINE_VERSION,
    embedding_provider: "none",
    chat_provider: "none",
    policy_shape: "stress",
    simulate_report: "none",
    dataset: {
      name: "alaya-synthetic-v1",
      size: SYNTHETIC_SCENARIOS.length,
      source: "inline"
    },
    sample_size: SYNTHETIC_SCENARIOS.length,
    evaluated_count: SYNTHETIC_SCENARIOS.length,
    harness_mode: "mcp_propose_review",
    kpi: {
      r_at_1: rAt1,
      r_at_5: rAt5,
      r_at_10: rAt10,
      latency_ms_p50: latencyP50,
      latency_ms_p95: latencyP95,
      latency_source: "exact",
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
  // Diff against the latest entry of the SAME split. Self currently only
  // has the "synthetic" split, but the API is split-aware so adding a
  // "golden" split later does not silently cross-compare.
  const previous = await readLatest(layout, "self", { split: payload.split });
  const diff = diffKpis(payload, previous);
  const slug = entrySlug(runAt, commitSha7);

  const report = renderReport(payload, previous, diff);
  const findings = renderFindings(payload, diff);

  const entry = await writeEntry(layout, "self", slug, payload, report, findings);
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

// see also: apps/bench-runner/src/version.ts

function resolveCommitSha7(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "0000000";
  }
}

// @anchor self-bench-dedup: join-path for history output to avoid fs race
export function buildSelfHistoryPath(historyRoot: string, slug: string): string {
  return join(historyRoot, "self", slug);
}
