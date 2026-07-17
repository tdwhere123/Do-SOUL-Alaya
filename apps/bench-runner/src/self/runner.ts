import { execSync } from "node:child_process";
import { join } from "node:path";
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
import { RECALL_PIPELINE_VERSION, resolveBenchRunnerVersion } from "../shared/version.js";
import { monotonicElapsedMs, monotonicNowNs } from "../shared/monotonic.js";
import { rotatingSeedObjectKind } from "../harness/seeding/seed-rotation.js";
import { SYNTHETIC_SCENARIOS, type SyntheticScenario } from "./scenarios.js";

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

interface SelfScenarioState {
  readonly sidecar: Map<string, string>;
  readonly expectedIdSet: Set<string>;
  seedIndex: number;
  seedTurnsTruncated: number;
  answerTurnsTruncated: number;
  seedCharsClipped: number;
}

interface SelfScenarioResult {
  readonly row: PerScenarioRow;
  readonly hitAt1: boolean;
  readonly hitAt10: boolean;
  readonly firstTier: "hot" | "warm" | "cold";
  readonly latencyMs: number;
  readonly degradationReason: string | null;
  readonly seedTurnsTruncated: number;
  readonly answerTurnsTruncated: number;
  readonly seedCharsClipped: number;
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
  const runAt = new Date();
  const payload = buildSelfBenchPayload({
    runAt,
    alayaVersion: resolveBenchRunnerVersion(),
    commitSha7: resolveCommitSha7(),
    results: await runSelfBenchScenarios()
  });
  return writeSelfBenchRun(opts, runAt, payload);
}

async function runSelfBenchScenarios(): Promise<readonly SelfScenarioResult[]> {
  const results: SelfScenarioResult[] = [];
  for (const scenario of SYNTHETIC_SCENARIOS) {
    results.push(await runSelfScenario(scenario));
  }
  return results;
}

async function runSelfScenario(
  scenario: SyntheticScenario
): Promise<SelfScenarioResult> {
  const daemon = await startBenchDaemon({
    workspaceId: `self-${scenario.id}`,
    runId: `run-${scenario.id}`
  });
  try {
    const state = createSelfScenarioState(scenario);
    await seedSelfScenarioSetups(daemon, scenario, state);
    await seedSelfScenarioDistractors(daemon, scenario, state);
    return await recallSelfScenario(daemon, scenario, state);
  } finally {
    await daemon.shutdown();
  }
}

function createSelfScenarioState(scenario: SyntheticScenario): SelfScenarioState {
  return {
    sidecar: new Map(),
    expectedIdSet: new Set(scenario.expected_ids),
    seedIndex: 0,
    seedTurnsTruncated: 0,
    answerTurnsTruncated: 0,
    seedCharsClipped: 0
  };
}

async function seedSelfScenarioSetups(
  daemon: Awaited<ReturnType<typeof startBenchDaemon>>,
  scenario: SyntheticScenario,
  state: SelfScenarioState
): Promise<void> {
  for (let i = 0; i < scenario.setup.length; i += 1) {
    const content = scenario.setup[i];
    if (content === undefined) continue;
    await seedSelfScenarioEntry(daemon, state, {
      content,
      evidenceRef: `${scenario.id}-setup-${i}`,
      expectedId: `${scenario.id}-s${i}`,
      trackExpectedId: true
    });
  }
}

async function seedSelfScenarioDistractors(
  daemon: Awaited<ReturnType<typeof startBenchDaemon>>,
  scenario: SyntheticScenario,
  state: SelfScenarioState
): Promise<void> {
  for (let i = 0; i < scenario.distractors.length; i += 1) {
    const content = scenario.distractors[i];
    if (content === undefined) continue;
    await seedSelfScenarioEntry(daemon, state, {
      content,
      evidenceRef: `${scenario.id}-distractor-${i}`,
      trackExpectedId: false
    });
  }
}

async function seedSelfScenarioEntry(
  daemon: Awaited<ReturnType<typeof startBenchDaemon>>,
  state: SelfScenarioState,
  input: {
    readonly content: string;
    readonly evidenceRef: string;
    readonly trackExpectedId: boolean;
    readonly expectedId?: string;
  }
): Promise<void> {
  const seed = await daemon.proposeMemory(input.content, input.evidenceRef, {
    objectKind: rotatingSeedObjectKind(state.seedIndex)
  });
  state.seedIndex += 1;
  recordSelfScenarioTruncation(state, seed, input.trackExpectedId);
  if (input.trackExpectedId && input.expectedId !== undefined) {
    state.sidecar.set(seed.memoryId, input.expectedId);
  }
}

function recordSelfScenarioTruncation(
  state: SelfScenarioState,
  seed: Awaited<
    ReturnType<Awaited<ReturnType<typeof startBenchDaemon>>["proposeMemory"]>
  >,
  trackAnswerTurn: boolean
): void {
  if (!seed.truncated) return;
  state.seedTurnsTruncated += 1;
  state.seedCharsClipped += seed.charsClipped;
  if (trackAnswerTurn) {
    state.answerTurnsTruncated += 1;
  }
}

async function recallSelfScenario(
  daemon: Awaited<ReturnType<typeof startBenchDaemon>>,
  scenario: SyntheticScenario,
  state: SelfScenarioState
): Promise<SelfScenarioResult> {
  const recallStart = monotonicNowNs();
  const recallResult = await daemon.recall(scenario.probe, { maxResults: 10 });
  const verdict = scoreSelfScenarioRecall(
    recallResult.results,
    state.sidecar,
    state.expectedIdSet
  );
  return {
    row: { id: scenario.id, version: 1, hit_at_5: verdict.hitAt5, tier: verdict.firstTier },
    hitAt1: verdict.hitAt1,
    hitAt10: verdict.hitAt10,
    firstTier: verdict.firstTier,
    latencyMs: monotonicElapsedMs(recallStart),
    degradationReason: recallResult.degradation_reason ?? null,
    seedTurnsTruncated: state.seedTurnsTruncated,
    answerTurnsTruncated: state.answerTurnsTruncated,
    seedCharsClipped: state.seedCharsClipped
  };
}

function scoreSelfScenarioRecall(
  results: readonly { readonly object_id: string; readonly relevance_score: number }[],
  sidecar: ReadonlyMap<string, string>,
  expectedIdSet: ReadonlySet<string>
): {
  readonly hitAt1: boolean;
  readonly hitAt5: boolean;
  readonly hitAt10: boolean;
  readonly firstTier: "hot" | "warm" | "cold";
} {
  let hitAt1 = false;
  let hitAt5 = false;
  let hitAt10 = false;
  let firstTier: "hot" | "warm" | "cold" = "cold";

  for (let rank = 0; rank < results.length && rank < 10; rank += 1) {
    const pointer = results[rank];
    if (pointer === undefined) continue;
    if (rank === 0) {
      firstTier = inferTier(pointer.relevance_score);
    }
    const expectedId = sidecar.get(pointer.object_id);
    const isHit = expectedId !== undefined && expectedIdSet.has(expectedId);
    if (!isHit) continue;
    if (rank === 0) hitAt1 = true;
    if (rank < 5) hitAt5 = true;
    hitAt10 = true;
  }

  return { hitAt1, hitAt5, hitAt10, firstTier };
}

function buildSelfBenchPayload(input: {
  readonly runAt: Date;
  readonly alayaVersion: string;
  readonly commitSha7: string;
  readonly results: readonly SelfScenarioResult[];
}): KpiPayload {
  return {
    bench_name: "self",
    split: "synthetic",
    run_at: input.runAt.toISOString(),
    alaya_commit: input.commitSha7,
    alaya_version: input.alayaVersion,
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
    kpi: buildSelfBenchKpi(input.results)
  };
}

function buildSelfBenchKpi(
  results: readonly SelfScenarioResult[]
): KpiPayload["kpi"] {
  const total = results.length;
  return {
    r_at_1: ratio(results.filter((result) => result.hitAt1).length, total),
    r_at_5: ratio(results.filter((result) => result.row.hit_at_5).length, total),
    r_at_10: ratio(results.filter((result) => result.hitAt10).length, total),
    latency_ms_p50: computePercentile(results.map((result) => result.latencyMs), 50),
    latency_ms_p95: computePercentile(results.map((result) => result.latencyMs), 95),
    latency_source: "exact",
    token_saved_ratio_vs_full_prompt: 0,
    tier_distribution: buildSelfTierDistribution(results),
    degradation_reasons: buildSelfDegradationReasons(results),
    seed_truncation: buildSelfTruncation(results),
    per_scenario: results.map((result) => result.row)
  };
}

function buildSelfTierDistribution(results: readonly SelfScenarioResult[]) {
  let hot = 0;
  let warm = 0;
  let cold = 0;
  for (const result of results) {
    if (result.firstTier === "hot") hot += 1;
    else if (result.firstTier === "warm") warm += 1;
    else cold += 1;
  }
  return { hot, warm, cold };
}

function buildSelfDegradationReasons(results: readonly SelfScenarioResult[]) {
  let none = 0;
  let warm = 0;
  let cold = 0;
  let partial = 0;
  for (const result of results) {
    if (result.degradationReason === "warm_cascade_engaged") warm += 1;
    else if (result.degradationReason === "cold_cascade_engaged") cold += 1;
    else if (result.degradationReason === "recall_explainability_partial") partial += 1;
    else none += 1;
  }
  return {
    none,
    warm_cascade_engaged: warm,
    cold_cascade_engaged: cold,
    recall_explainability_partial: partial
  };
}

function buildSelfTruncation(results: readonly SelfScenarioResult[]) {
  return {
    seed_turns_truncated: results.reduce(
      (sum, result) => sum + result.seedTurnsTruncated,
      0
    ),
    answer_turns_truncated: results.reduce(
      (sum, result) => sum + result.answerTurnsTruncated,
      0
    ),
    seed_chars_clipped: results.reduce(
      (sum, result) => sum + result.seedCharsClipped,
      0
    )
  };
}

async function writeSelfBenchRun(
  opts: SelfBenchRunOptions,
  runAt: Date,
  payload: KpiPayload
): Promise<SelfBenchRunResult> {
  const layout: HistoryLayout = { historyRoot: opts.historyRoot };
  const previous = await readLatest(layout, "self", { split: payload.split });
  const diff = diffKpis(payload, previous);
  const slug = entrySlug(runAt, payload.alaya_commit);
  const entry = await writeEntry(
    layout,
    "self",
    slug,
    payload,
    renderReport(payload, previous, diff),
    renderFindings(payload, diff)
  );
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

function ratio(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}

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
