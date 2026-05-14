import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
 * Scoring: object_id sidecar. Each setup utterance is seeded through the
 * MCP propose+review chain and recorded in the sidecar against its
 * expected_id (e.g. "syn-001-s0"). Distractors are seeded too — to grow
 * the recall search space and break the workspace-too-small trivial-hit
 * tautology the reviewer flagged in Phase 4 round 1 — but they are NOT
 * recorded in the sidecar, so a distractor recall does not score.
 *
 * Hit rule: a recall pointer is a hit iff its object_id maps in the
 * sidecar to an expected_id from scenario.expected_ids. No content prefix
 * overlap. No setup-line substring match.
 *
 * see also: apps/bench-runner/src/harness/daemon.ts — proposeMemory chain
 * see also: apps/bench-runner/src/self/scenarios.ts — setup + distractor pairs
 */
export async function runSelfBench(opts: SelfBenchRunOptions): Promise<SelfBenchRunResult> {
  const alayaVersion = resolveAlayaVersion();
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
  let totalHitAt1 = 0;
  let totalHitAt10 = 0;

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

      for (let i = 0; i < scenario.setup.length; i++) {
        const content = scenario.setup[i];
        if (content === undefined) continue;
        const expectedId = `${scenario.id}-s${i}`;
        const evidenceRef = `${scenario.id}-setup-${i}`;
        const seed = await daemon.proposeMemory(content, evidenceRef);
        sidecar.set(seed.memoryId, expectedId);
      }

      // Distractors expand the recall search space. Their memoryId is not
      // recorded — if the recall returns one, it occupies a top-K slot
      // but the scoring loop sees `sidecar.get` return undefined and
      // counts no hit.
      for (let i = 0; i < scenario.distractors.length; i++) {
        const content = scenario.distractors[i];
        if (content === undefined) continue;
        const evidenceRef = `${scenario.id}-distractor-${i}`;
        await daemon.proposeMemory(content, evidenceRef);
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
      // — that is real recall behavior, not a harness bug. See
      // README §"Bench harness — degradation diagnostics" for the
      // operator-facing diagnosis.
      const degradationReason = recallResult.degradation_reason ?? null;
      if (degradationReason === "warm_cascade_engaged") degradeWarm++;
      else if (degradationReason === "cold_cascade_engaged") degradeCold++;
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
    embedding_provider: "none",
    chat_provider: "none",
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
  const previous = await readLatest(layout, "self");
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

// @anchor self-bench-dedup — join-path for history output to avoid fs race
export function buildSelfHistoryPath(historyRoot: string, slug: string): string {
  return join(historyRoot, "self", slug);
}
