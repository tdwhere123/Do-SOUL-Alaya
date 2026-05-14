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
import { previewContainsExpectedPrefix } from "../scoring.js";
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
 * @anchor self-bench-runner — in-process daemon, 8 synthetic scenarios, split=synthetic
 *
 * Hit rule: a recall result is a hit when its content_preview contains a
 * 40-char prefix of one of the seeded setup strings for that scenario.
 * R@1, R@5, R@10 are all computed and written to the KPI entry.
 * see also: harness/daemon.ts — proposeMemory / acceptProposal helpers
 * see also: self/scenarios.ts — 8 synthetic scenario definitions
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
      // Build the expected content set for scoring: all setup strings
      const expectedContents: string[] = scenario.setup.map((s) => s.trim());

      // Seed each setup utterance as a proposed+accepted memory
      for (const content of scenario.setup) {
        const evidenceRef = `${scenario.id}-setup-${scenario.setup.indexOf(content)}`;
        const proposalId = await daemon.proposeMemory(content, evidenceRef);
        await daemon.acceptProposal(proposalId);
      }

      // Recall using the probe
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

        // A result is a hit when its content_preview matches any expected setup string prefix.
        const isHit = previewContainsExpectedPrefix(
          pointer.content_preview,
          expectedContents
        );

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
    // see also: apps/bench-runner/src/harness/daemon.ts — proposeMemory writes
    // directly via SqliteMemoryEntryRepo, so this run skipped the propose/review
    // governance loop. Flip to mcp_propose_review once the harness drives the
    // real MCP soul.propose_memory_update + soul.review_memory_proposal tools.
    harness_mode: "direct_db_seed",
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
