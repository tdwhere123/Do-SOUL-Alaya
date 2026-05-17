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
import { resolveBenchRunnerVersion } from "../version.js";
import { rotatingSeedObjectKind } from "../harness/seed-rotation.js";
import { startBenchDaemon, type BenchEmbeddingMode } from "../harness/daemon.js";
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
  readonly pinnedMetaRoot?: string;
  readonly offset?: number;
}

export interface LocomoRunResult {
  readonly slug: string;
  readonly kpiPath: string;
  readonly reportPath: string;
  readonly findingsPath: string;
  readonly payload: KpiPayload;
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
  const embeddingProvider = opts.embeddingMode === "env" ? "yunwu:text-embedding-3-small" : "none";

  const perScenario: PerScenarioRow[] = [];
  const latencies: number[] = [];
  let tierHot = 0;
  let tierWarm = 0;
  let tierCold = 0;
  let totalHitAt1 = 0;
  let totalHitAt5 = 0;
  let totalHitAt10 = 0;
  let totalQa = 0;

  for (let i = 0; i < window.length; i++) {
    const conversation = window[i];
    if (conversation === undefined) continue;
    const convResult = await runOneConversation(conversation, opts);
    totalQa += convResult.qaCount;
    totalHitAt1 += convResult.hitAt1;
    totalHitAt5 += convResult.hitAt5;
    totalHitAt10 += convResult.hitAt10;
    tierHot += convResult.tierHot;
    tierWarm += convResult.tierWarm;
    tierCold += convResult.tierCold;
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

  const payload: KpiPayload = {
    bench_name: "public-locomo",
    split: "locomo10",
    run_at: runAt.toISOString(),
    alaya_commit: commitSha7,
    alaya_version: alayaVersion,
    embedding_provider: embeddingProvider,
    chat_provider: "none",
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
      latency_ms_p50: computePercentile(latencies, 50),
      latency_ms_p95: computePercentile(latencies, 95),
      latency_source: "exact",
      token_saved_ratio_vs_full_prompt: 0,
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
      per_scenario: perScenario
    }
  };

  const layout: HistoryLayout = { historyRoot: opts.historyRoot };
  const previous = await readLatest(layout, "public-locomo", { split: "locomo10" });
  const diff = diffKpis(payload, previous);
  const slug = entrySlug(runAt, commitSha7);
  const report = renderReport(payload, previous, diff);
  const findings = renderFindings(payload, diff);
  const entry = await writeEntry(layout, "public-locomo", slug, payload, report, findings);

  return {
    slug,
    kpiPath: entry.kpiPath,
    reportPath: entry.reportPath,
    findingsPath: entry.findingsPath,
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
}

async function runOneConversation(
  conversation: LocomoSample,
  opts: LocomoRunOptions
): Promise<ConversationResult> {
  const daemon = await startBenchDaemon({
    workspaceId: `locomo-${conversation.sample_id}`,
    runId: `run-${conversation.sample_id}`,
    embeddingMode: opts.embeddingMode ?? "disabled"
  });
  try {
    const diaIdByMemoryId = new Map<string, string>();
    const sessions = extractSessions(conversation.conversation);
    // invariant: rotate the seeded object_kind across each turn so the
    // archive witnesses both MaterializationRouter branches (memory-
    // only + memory-and-claim-draft). Recall surface is unchanged
    // (memory_entry is persisted in both branches).
    // see also: apps/bench-runner/src/harness/seed-rotation.ts
    let seedIndex = 0;
    for (const session of sessions) {
      for (const turn of session.turns) {
        const seedContent = `${turn.speaker}: ${turn.text}`;
        const evidenceRef = `${conversation.sample_id}-${turn.dia_id}`;
        const seed = await daemon.proposeMemory(seedContent, evidenceRef, {
          objectKind: rotatingSeedObjectKind(seedIndex)
        });
        diaIdByMemoryId.set(seed.memoryId, turn.dia_id);
        seedIndex += 1;
      }
    }

    if (opts.embeddingMode === "env") {
      await daemon.runtime.runGardenBackgroundPass();
    }

    let hitAt1 = 0;
    let hitAt5 = 0;
    let hitAt10 = 0;
    let tierHot = 0;
    let tierWarm = 0;
    let tierCold = 0;
    let scoredCount = 0;
    const latencies: number[] = [];

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
      if (ranked[0] !== undefined && evidenceSet.has(ranked[0])) hitAt1 += 1;
      if (ranked.slice(0, 5).some((dia) => dia !== undefined && evidenceSet.has(dia))) hitAt5 += 1;
      if (ranked.some((dia) => dia !== undefined && evidenceSet.has(dia))) hitAt10 += 1;
      const firstScore = result.pointers[0]?.relevance_score ?? 0;
      if (firstScore >= 0.7) tierHot += 1;
      else if (firstScore >= 0.4) tierWarm += 1;
      else tierCold += 1;
    }

    return {
      qaCount: scoredCount,
      hitAt1,
      hitAt5,
      hitAt10,
      tierHot,
      tierWarm,
      tierCold,
      latencies
    };
  } finally {
    await daemon.shutdown();
  }
}

interface QaResult {
  readonly latencyMs: number;
  readonly pointers: ReadonlyArray<{ readonly object_id: string; readonly relevance_score: number }>;
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
  return { latencyMs, pointers };
}

function computePercentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

// see also: apps/bench-runner/src/version.ts resolveBenchRunnerVersion

function resolveCommitSha7(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "0000000";
  }
}

// invariant: sample_size counts the scoreable-QA upper bound across
// the full dataset (every QA carrying non-empty evidence), not the
// number of conversations. evaluated_count is the subset this run
// actually scored, so evaluated_count <= sample_size holds even when
// --limit slices the conversation window.
// see also: apps/bench-runner/src/locomo/dataset.ts — LoCoMo
// category-5 adversarial entries omit evidence by design and are
// excluded from the denominator.
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
