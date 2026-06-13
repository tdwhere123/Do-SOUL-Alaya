import { access, readFile } from "node:fs/promises";
import path from "node:path";
import {
  benchArchiveDiscriminator,
  buildDiffVsPrevious,
  buildTokenEconomy,
  computeTokenSavedRatio,
  diffKpis,
  entrySlug,
  KpiPayloadSchema,
  readLatest,
  releaseHardGateVerdict,
  renderFindings,
  renderReport,
  writeEntry,
  type HistoryLayout,
  type KpiPayload,
  type PerScenarioRow
} from "@do-soul/alaya-eval";
import {
  aggregateLongMemEvalArchiveEvidence,
  archiveEvidenceFromDiagnostics,
  buildLongMemEvalColdWarmComparisonSidecar,
  LONGMEMEVAL_COLD_WARM_COMPARISON_FILENAME,
  LONGMEMEVAL_DIAGNOSTICS_FILENAME,
  readLatestLongMemEvalOppositeArchive,
  readLongMemEvalDiagnosticsSidecar,
  renderLongMemEvalColdWarmComparisonSidecar,
  type LongMemEvalArchiveEvidenceSummary
} from "../longmemeval/archive-evidence.js";
import {
  renderCompactDiagnosticsSidecar,
  renderDiagnosticsSidecar,
  summarizeProviderStates,
  type LongMemEvalDiagnosticsSidecar,
  type LongMemEvalEmbeddingVectorCacheSummary,
  type LongMemEvalQueryEmbeddingCacheSummary,
  type LongMemEvalReportUsageSummary
} from "../longmemeval/diagnostics.js";
import { writeExternalDiagnosticsArtifact } from "../longmemeval/diagnostics-artifacts.js";
import {
  appendSeedExtractionReleaseBlockerToFindings,
  appendSeedExtractionReleaseBlockerToReport,
  seedExtractionReleaseBlockerExitCode
} from "../longmemeval/seed-extraction-release-blocker.js";
import { mergeQualityMetrics } from "./merge-quality.js";
import { aggregateBenchTokenMetrics } from "../harness/token-economy.js";
import type { BenchTokenMetrics } from "../harness/daemon.js";
import { resolveBenchCommitSha7 } from "../shared/version.js";

export interface MergeLongMemEvalCommandOptions {
  readonly historyRoot: string;
  readonly shards?: readonly string[];
}

/**
 * Pick the worst verdict across all gated KPIs. A previous version of this
 * mapping only inspected verdict_per_kpi["r_at_5"], which masked latency /
 * tier / token-budget failures. Worst-across-all keeps the exit-code contract
 * consistent with the report.md `Worst verdict: ...` line and with
 * diff.worst_verdict in @do-soul/alaya-eval.
 *
 * fail -> exit 1; warn -> exit 0 (advisory); ok / missing -> exit 0.
 */
function exitCodeForVerdicts(
  verdictPerKpi: Record<string, string> | undefined
): number {
  if (verdictPerKpi === undefined) return 0;
  const values = Object.values(verdictPerKpi);
  if (values.includes("fail")) return 1;
  return 0;
}

function exitCodeForBenchmarkResult(payload: KpiPayload): number {
  const seedExtractionExitCode = seedExtractionReleaseBlockerExitCode(payload);
  if (seedExtractionExitCode !== 0) return seedExtractionExitCode;
  if (releaseHardGateVerdict(payload) === "fail") return 1;
  return exitCodeForVerdicts(payload.diff_vs_previous?.verdict_per_kpi);
}

function exitCodeForMergedLongMemEvalResult(payload: KpiPayload): number {
  return exitCodeForBenchmarkResult(payload);
}

function pct(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function ratio(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}

type SeedExtractionPathKpi = NonNullable<
  KpiPayload["kpi"]["seed_extraction_path"]
>;

function mergeSeedExtractionPath(
  shards: readonly KpiPayload[]
): SeedExtractionPathKpi | undefined {
  const present = shards
    .map((shard) => shard.kpi.seed_extraction_path)
    .filter((path): path is SeedExtractionPathKpi => path !== undefined);
  if (present.length === 0) {
    return undefined;
  }
  if (present.length !== shards.length) {
    throw new Error(
      "merge refused: seed_extraction_path is present on only some shards"
    );
  }

  return {
    path: present.some((path) => path.path === "no_credentials_fallback")
      ? "no_credentials_fallback"
      : "official_api_compile",
    cache_hits: present.reduce((sum, path) => sum + path.cache_hits, 0),
    llm_calls: present.reduce((sum, path) => sum + path.llm_calls, 0),
    offline_fallbacks: present.reduce(
      (sum, path) => sum + path.offline_fallbacks,
      0
    ),
    live_extraction_failures: present.reduce(
      (sum, path) => sum + path.live_extraction_failures,
      0
    ),
    cached_extraction_failures: present.reduce(
      (sum, path) => sum + path.cached_extraction_failures,
      0
    ),
    facts_produced: present.reduce((sum, path) => sum + path.facts_produced, 0),
    signals_dropped: present.reduce(
      (sum, path) => sum + path.signals_dropped,
      0
    ),
    parse_dropped: present.reduce((sum, path) => sum + path.parse_dropped, 0),
    compile_overflow_dropped: present.reduce(
      (sum, path) => sum + path.compile_overflow_dropped,
      0
    ),
    signals_dropped_by_reason: {
      candidate_absent: present.reduce(
        (sum, path) => sum + path.signals_dropped_by_reason.candidate_absent,
        0
      ),
      materialization_error: present.reduce(
        (sum, path) =>
          sum + path.signals_dropped_by_reason.materialization_error,
        0
      )
    }
  };
}

function computePercentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`
    );
  return `{${entries.join(",")}}`;
}

const SHARD_POINTER_FILENAMES = [
  "latest-passing.json",
  "latest-run.json",
  "latest-baseline.json"
] as const;

async function resolveShardPointerPath(shardRoot: string): Promise<string> {
  const pointerRoot = path.join(shardRoot, "public");
  for (const filename of SHARD_POINTER_FILENAMES) {
    const pointerPath = path.join(pointerRoot, filename);
    try {
      await access(pointerPath);
      return pointerPath;
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }
  }
  throw new Error(
    `shard ${shardRoot} no usable shard pointer; checked ${SHARD_POINTER_FILENAMES.join(", ")}`
  );
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

function buildMergedLongMemEvalDiagnosticsSidecar(
  payload: KpiPayload,
  shardDiagnostics: readonly (LongMemEvalDiagnosticsSidecar | null)[],
  evidence: LongMemEvalArchiveEvidenceSummary
): MergedLongMemEvalDiagnosticsPayload {
  const questions = shardDiagnostics.flatMap(
    (diagnostics) => diagnostics?.questions ?? []
  );
  const questionCount = shardDiagnostics.reduce(
    (sum, diagnostics) => sum + diagnosticQuestionCount(diagnostics),
    0
  );
  const reportSideEffectSnapshotCount = aggregateReportSideEffectSnapshotCount(
    shardDiagnostics
  );
  const embeddingMode =
    shardDiagnostics.find(
      (diagnostics): diagnostics is LongMemEvalDiagnosticsSidecar =>
        diagnostics !== null
    )?.embedding_mode ??
    (payload.embedding_provider === "none" ? "disabled" : "env");
  const reportUsage = aggregateReportUsage(
    shardDiagnostics
      .map((diagnostics) => diagnostics?.report_usage)
      .filter(
        (usage): usage is LongMemEvalReportUsageSummary => usage !== undefined
      )
  );
  const embeddingVectorCache = aggregateEmbeddingVectorCache(
    shardDiagnostics
      .map((diagnostics) => diagnostics?.embedding_vector_cache)
      .filter(
        (summary): summary is LongMemEvalEmbeddingVectorCacheSummary =>
          summary !== undefined
      )
  );
  const queryEmbeddingCache = aggregateQueryEmbeddingCache(
    shardDiagnostics
      .map((diagnostics) => diagnostics?.query_embedding_cache)
      .filter(
        (summary): summary is LongMemEvalQueryEmbeddingCacheSummary =>
          summary !== undefined
      )
  );

  const sidecar: LongMemEvalDiagnosticsSidecar = {
    schema_version: 1,
    bench_name: "public",
    split: payload.split,
    run_at: payload.run_at,
    alaya_commit: payload.alaya_commit,
    recall_pipeline_version: payload.recall_pipeline_version,
    embedding_provider: payload.embedding_provider,
    embedding_mode: embeddingMode,
    policy_shape: payload.policy_shape,
    simulate_report: payload.simulate_report,
    ...(reportUsage === null ? {} : { report_usage: reportUsage }),
    ...(evidence.report_side_effects === null
      ? {}
      : { report_side_effects: evidence.report_side_effects }),
    ...(evidence.scored_recall_evidence === null
      ? {}
      : { scored_recall_evidence: evidence.scored_recall_evidence }),
    ...(embeddingVectorCache === null
      ? {}
      : { embedding_vector_cache: embeddingVectorCache }),
    ...(queryEmbeddingCache === null
      ? {}
      : { query_embedding_cache: queryEmbeddingCache }),
    provider_state_summary: summarizeProviderStates(questions),
    questions
  };
  return {
    sidecar,
    question_count: questionCount,
    report_side_effects_snapshot_count: reportSideEffectSnapshotCount
  };
}

interface MergedLongMemEvalDiagnosticsPayload {
  readonly sidecar: LongMemEvalDiagnosticsSidecar;
  readonly question_count: number;
  readonly report_side_effects_snapshot_count: number | null;
}

function diagnosticQuestionCount(
  diagnostics: LongMemEvalDiagnosticsSidecar | null
): number {
  if (diagnostics === null) {
    return 0;
  }
  if (Array.isArray(diagnostics.questions)) {
    return diagnostics.questions.length;
  }
  const compactQuestionCount = (
    diagnostics as { readonly question_count?: unknown }
  ).question_count;
  return requiredCompactNonNegativeInteger(
    compactQuestionCount,
    "question_count"
  );
}

function aggregateReportSideEffectSnapshotCount(
  shardDiagnostics: readonly (LongMemEvalDiagnosticsSidecar | null)[]
): number | null {
  let total = 0;
  let observed = false;
  for (const diagnostics of shardDiagnostics) {
    const reportSideEffects = diagnostics?.report_side_effects;
    if (reportSideEffects === undefined) continue;
    observed = true;
    if (Array.isArray(reportSideEffects.snapshots)) {
      total += reportSideEffects.snapshots.length;
      continue;
    }
    const compactSnapshotCount = (
      reportSideEffects as { readonly snapshot_count?: unknown }
    ).snapshot_count;
    total += requiredCompactNonNegativeInteger(
      compactSnapshotCount,
      "report_side_effects.snapshot_count"
    );
  }
  return observed ? total : null;
}

function requiredCompactNonNegativeInteger(
  value: unknown,
  fieldName: string
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new Error(
      `invalid compact diagnostics ${fieldName}: expected non-negative integer`
    );
  }
  return value;
}

function renderMergedLongMemEvalCompactDiagnosticsSidecar(
  payload: MergedLongMemEvalDiagnosticsPayload,
  fullDiagnosticsArtifactPath: string
): string {
  const compact = JSON.parse(
    renderCompactDiagnosticsSidecar(payload.sidecar, fullDiagnosticsArtifactPath)
  ) as {
    question_count?: unknown;
    report_side_effects?: { snapshot_count?: unknown };
  };
  compact.question_count = payload.question_count;
  if (
    compact.report_side_effects !== undefined &&
    payload.report_side_effects_snapshot_count !== null
  ) {
    compact.report_side_effects.snapshot_count =
      payload.report_side_effects_snapshot_count;
  }
  return JSON.stringify(compact, null, 2) + "\n";
}

function aggregateReportUsage(
  usages: readonly LongMemEvalReportUsageSummary[]
): LongMemEvalReportUsageSummary | null {
  if (usages.length === 0) {
    return null;
  }
  return {
    mode: usages[0]?.mode ?? "none",
    reports_attempted: usages.reduce(
      (sum, usage) => sum + usage.reports_attempted,
      0
    ),
    reports_used: usages.reduce((sum, usage) => sum + usage.reports_used, 0),
    reports_skipped: usages.reduce(
      (sum, usage) => sum + usage.reports_skipped,
      0
    ),
    used_object_count: usages.reduce(
      (sum, usage) => sum + usage.used_object_count,
      0
    )
  };
}

function aggregateEmbeddingVectorCache(
  summaries: readonly LongMemEvalEmbeddingVectorCacheSummary[]
): LongMemEvalEmbeddingVectorCacheSummary | null {
  if (summaries.length === 0) {
    return null;
  }
  const expectedCount = summaries.reduce(
    (sum, summary) => sum + summary.expected_count,
    0
  );
  const readyCount = summaries.reduce(
    (sum, summary) => sum + summary.ready_count,
    0
  );
  const maxPassCount = summaries.reduce(
    (max, summary) => Math.max(max, summary.max_pass_count),
    0
  );
  return {
    expected_count: expectedCount,
    ready_count: readyCount,
    not_ready_count: Math.max(0, expectedCount - readyCount),
    ready_rate: ratio(readyCount, expectedCount),
    max_pass_count: maxPassCount
  };
}

function aggregateQueryEmbeddingCache(
  summaries: readonly LongMemEvalQueryEmbeddingCacheSummary[]
): LongMemEvalQueryEmbeddingCacheSummary | null {
  if (summaries.length === 0) {
    return null;
  }
  const requestedCount = summaries.reduce(
    (sum, summary) => sum + summary.requested_count,
    0
  );
  const readyCount = summaries.reduce(
    (sum, summary) => sum + summary.ready_count,
    0
  );
  const cacheHitCount = summaries.reduce(
    (sum, summary) => sum + summary.cache_hit_count,
    0
  );
  const providerRequestedCount = summaries.reduce(
    (sum, summary) => sum + summary.provider_requested_count,
    0
  );
  const lastError = [...summaries].reverse().find(
    (summary) => summary.last_error !== undefined
  )?.last_error;
  return {
    requested_count: requestedCount,
    ready_count: readyCount,
    not_ready_count: Math.max(0, requestedCount - readyCount),
    ready_rate: ratio(readyCount, requestedCount),
    cache_hit_count: cacheHitCount,
    provider_requested_count: providerRequestedCount,
    ...(lastError === undefined ? {} : { last_error: lastError })
  };
}

/**
 * @anchor merge-longmemeval — combine N shard kpi.jsons into one final entry
 */
export async function runMergeLongMemEvalCommand(
  opts: MergeLongMemEvalCommandOptions
): Promise<number> {
  try {
    const shards = opts.shards ?? [];
    if (shards.length === 0) {
      process.stderr.write(
        "alaya-bench-runner merge-longmemeval: --shards <dir1> <dir2> ... required\n"
      );
      return 2;
    }

    process.stdout.write(`Merging ${shards.length} shard(s)...\n`);

    const shardPayloads: KpiPayload[] = [];
    const shardArchiveRefs: Array<{ readonly root: string; readonly slug: string }> =
      [];
    for (const shardRoot of shards) {
      const pointerPath = await resolveShardPointerPath(shardRoot);
      const pointer = JSON.parse(await readFile(pointerPath, "utf8")) as {
        slug?: string;
        kpi_path?: string;
      };
      if (typeof pointer.slug !== "string") {
        throw new Error(
          `shard ${shardRoot} ${path.basename(pointerPath)} missing slug`
        );
      }
      const kpiPath = path.join(shardRoot, "public", pointer.slug, "kpi.json");
      const raw = await readFile(kpiPath, "utf8");
      const payload = KpiPayloadSchema.parse(JSON.parse(raw));
      shardPayloads.push(payload);
      shardArchiveRefs.push({ root: shardRoot, slug: pointer.slug });
      process.stdout.write(
        `  shard ${shardRoot}: ${payload.evaluated_count} questions, ` +
          `R@5=${pct(payload.kpi.r_at_5)}\n`
      );
    }

    const first = shardPayloads[0];
    if (first === undefined) {
      throw new Error("no shards loaded");
    }

    type ScalarIdentityField =
      | "split"
      | "sample_size"
      | "harness_mode"
      | "embedding_provider"
      | "chat_provider"
      | "policy_shape"
      | "simulate_report"
      | "bench_name"
      | "alaya_version"
      | "alaya_commit"
      | "recall_pipeline_version";
    const SCALAR_IDENTITY_FIELDS: ReadonlyArray<ScalarIdentityField> = [
      "split",
      "sample_size",
      "harness_mode",
      "embedding_provider",
      "chat_provider",
      "policy_shape",
      "simulate_report",
      "bench_name",
      "alaya_version",
      "alaya_commit",
      "recall_pipeline_version"
    ];
    for (let i = 1; i < shardPayloads.length; i++) {
      const shard = shardPayloads[i];
      if (shard === undefined) continue;
      for (const field of SCALAR_IDENTITY_FIELDS) {
        if (shard[field] !== first[field]) {
          throw new Error(
            `merge refused: shard[${i}] ${field}=${String(shard[field])} != shard[0] ${field}=${String(first[field])}`
          );
        }
      }
      if (
        shard.dataset.name !== first.dataset.name ||
        shard.dataset.size !== first.dataset.size ||
        shard.dataset.source !== first.dataset.source ||
        shard.dataset.checksum_sha256 !== first.dataset.checksum_sha256 ||
        shard.dataset.checksum_source !== first.dataset.checksum_source
      ) {
        throw new Error(
          `merge refused: shard[${i}] dataset identity (${shard.dataset.name}/${shard.dataset.size}/${shard.dataset.source}) != shard[0] (${first.dataset.name}/${first.dataset.size}/${first.dataset.source})`
        );
      }
      if (
        JSON.stringify(shard.seed_policy ?? null) !==
        JSON.stringify(first.seed_policy ?? null)
      ) {
        throw new Error(
          `merge refused: shard[${i}] seed_policy differs from shard[0]`
        );
      }
      if (
        stableJson(shard.recall_weight_overrides ?? null) !==
        stableJson(first.recall_weight_overrides ?? null)
      ) {
        throw new Error(
          `merge refused: shard[${i}] recall_weight_overrides != shard[0] recall_weight_overrides`
        );
      }
    }
    const seenIds = new Set<string>();
    for (const shard of shardPayloads) {
      for (const row of shard.kpi.per_scenario) {
        if (seenIds.has(row.id)) {
          throw new Error(
            `merge refused: duplicate question_id '${row.id}' across shards (overlapping --offset/--limit ranges?)`
          );
        }
        seenIds.add(row.id);
      }
    }

    const perScenario: PerScenarioRow[] = [];
    let tierHot = 0;
    let tierWarm = 0;
    let tierCold = 0;
    let degradeNone = 0;
    let degradeWarm = 0;
    let degradeCold = 0;
    let degradePartial = 0;
    let truncSeedTotal = 0;
    let truncAnswerTotal = 0;
    let truncCharsTotal = 0;
    let totalHitAt1 = 0;
    let totalHitAt10 = 0;
    let providerReturnedTotal = 0;
    let providerPendingTotal = 0;
    let providerFailedTotal = 0;
    let providerNotRequestedTotal = 0;
    let providerReturnedHitAt5 = 0;
    let hasProviderRates = false;
    let hasReturnedSubsetRAt5 = false;
    let evaluatedTotal = 0;
    let latencyP50Max = 0;
    let latencyP95Max = 0;
    const shardTokenEconomies: BenchTokenMetrics[] = [];

    for (const shard of shardPayloads) {
      if (shard.kpi.token_economy !== undefined) {
        shardTokenEconomies.push(shard.kpi.token_economy);
      }
      for (const row of shard.kpi.per_scenario) {
        perScenario.push(row);
      }
      totalHitAt1 += Math.round(shard.kpi.r_at_1 * shard.evaluated_count);
      totalHitAt10 += Math.round(shard.kpi.r_at_10 * shard.evaluated_count);
      tierHot += shard.kpi.tier_distribution.hot;
      tierWarm += shard.kpi.tier_distribution.warm;
      tierCold += shard.kpi.tier_distribution.cold;
      degradeNone += shard.kpi.degradation_reasons.none;
      degradeWarm += shard.kpi.degradation_reasons.warm_cascade_engaged;
      degradeCold += shard.kpi.degradation_reasons.cold_cascade_engaged;
      degradePartial +=
        shard.kpi.degradation_reasons.recall_explainability_partial;
      truncSeedTotal += shard.kpi.seed_truncation.seed_turns_truncated;
      truncAnswerTotal += shard.kpi.seed_truncation.answer_turns_truncated;
      truncCharsTotal += shard.kpi.seed_truncation.seed_chars_clipped;
      if (
        shard.kpi.provider_returned_rate !== undefined ||
        shard.kpi.provider_pending_rate !== undefined ||
        shard.kpi.provider_failed_rate !== undefined ||
        shard.kpi.provider_not_requested_rate !== undefined
      ) {
        hasProviderRates = true;
        const returned = Math.round(
          (shard.kpi.provider_returned_rate ?? 0) * shard.evaluated_count
        );
        providerReturnedTotal += returned;
        providerPendingTotal += Math.round(
          (shard.kpi.provider_pending_rate ?? 0) * shard.evaluated_count
        );
        providerFailedTotal += Math.round(
          (shard.kpi.provider_failed_rate ?? 0) * shard.evaluated_count
        );
        providerNotRequestedTotal += Math.round(
          (shard.kpi.provider_not_requested_rate ?? 0) * shard.evaluated_count
        );
        if (shard.kpi.r_at_5_with_embedding_returned !== undefined) {
          hasReturnedSubsetRAt5 = true;
          providerReturnedHitAt5 += Math.round(
            shard.kpi.r_at_5_with_embedding_returned * returned
          );
        }
      }
      evaluatedTotal += shard.evaluated_count;
      latencyP50Max = Math.max(latencyP50Max, shard.kpi.latency_ms_p50);
      latencyP95Max = Math.max(latencyP95Max, shard.kpi.latency_ms_p95);
    }

    if (evaluatedTotal > first.sample_size) {
      throw new Error(
        `merge refused: evaluated_total=${evaluatedTotal} > sample_size=${first.sample_size} (shards collectively over-evaluated; check --offset/--limit ranges)`
      );
    }
    const policyShape = first.policy_shape ?? "stress";
    const simulateReport = first.simulate_report ?? "none";

    const n = evaluatedTotal;
    const rAt1 = n === 0 ? 0 : totalHitAt1 / n;
    const rAt5 =
      n === 0 ? 0 : perScenario.filter((r) => r.hit_at_5).length / n;
    const rAt10 = n === 0 ? 0 : totalHitAt10 / n;
    const qualityMetrics = mergeQualityMetrics(shardPayloads);
    const seedExtractionPath = mergeSeedExtractionPath(shardPayloads);

    const allShardsHaveTokenEconomy =
      shardTokenEconomies.length === shardPayloads.length;
    const mergedTokenEconomyInput = allShardsHaveTokenEconomy
      ? aggregateBenchTokenMetrics(shardTokenEconomies)
      : null;
    const mergedTokenEconomy =
      mergedTokenEconomyInput === null
        ? undefined
        : buildTokenEconomy(mergedTokenEconomyInput);
    const mergedTokenSavedRatio =
      mergedTokenEconomyInput === null
        ? 0
        : computeTokenSavedRatio(mergedTokenEconomyInput);

    const mergedLatencies = perScenario
      .map((row) => row.latency_ms)
      .filter((latency): latency is number => latency !== undefined);
    const hasExactMergedLatency =
      evaluatedTotal > 0 && mergedLatencies.length === evaluatedTotal;
    const latencyP50 = hasExactMergedLatency
      ? computePercentile(mergedLatencies, 50)
      : latencyP50Max;
    const latencyP95 = hasExactMergedLatency
      ? computePercentile(mergedLatencies, 95)
      : latencyP95Max;

    const runAt = new Date();
    const commitSha7 = resolveBenchCommitSha7();

    let merged: KpiPayload = {
      bench_name: first.bench_name,
      split: first.split,
      run_at: runAt.toISOString(),
      alaya_commit: commitSha7,
      alaya_version: first.alaya_version,
      recall_pipeline_version: first.recall_pipeline_version,
      embedding_provider: first.embedding_provider,
      chat_provider: first.chat_provider,
      policy_shape: policyShape,
      simulate_report: simulateReport,
      ...(first.recall_weight_overrides === undefined
        ? {}
        : { recall_weight_overrides: first.recall_weight_overrides }),
      ...(first.seed_policy === undefined
        ? {}
        : { seed_policy: first.seed_policy }),
      dataset: first.dataset,
      sample_size: first.sample_size,
      evaluated_count: evaluatedTotal,
      harness_mode: first.harness_mode,
      kpi: {
        r_at_1: rAt1,
        r_at_5: rAt5,
        r_at_10: rAt10,
        ...(first.kpi.r_at_5_overall === undefined
          ? {}
          : { r_at_5_overall: rAt5 }),
        ...(hasReturnedSubsetRAt5 && providerReturnedTotal > 0
          ? {
              r_at_5_with_embedding_returned:
                providerReturnedHitAt5 / providerReturnedTotal
            }
          : {}),
        ...(hasProviderRates
          ? {
              provider_returned_rate: ratio(providerReturnedTotal, evaluatedTotal),
              provider_pending_rate: ratio(providerPendingTotal, evaluatedTotal),
              provider_failed_rate: ratio(providerFailedTotal, evaluatedTotal),
              provider_not_requested_rate: ratio(
                providerNotRequestedTotal,
                evaluatedTotal
              )
            }
          : {}),
        latency_ms_p50: latencyP50,
        latency_ms_p95: latencyP95,
        latency_source: hasExactMergedLatency
          ? "exact"
          : "worst_shard_bound",
        token_saved_ratio_vs_full_prompt: mergedTokenSavedRatio,
        ...(mergedTokenEconomy === undefined
          ? {}
          : { token_economy: mergedTokenEconomy }),
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
        ...(seedExtractionPath === undefined
          ? {}
          : { seed_extraction_path: seedExtractionPath }),
        ...(qualityMetrics === undefined
          ? {}
          : { quality_metrics: qualityMetrics }),
        per_scenario: perScenario
      }
    };

    const shardDiagnostics = await Promise.all(
      shardArchiveRefs.map(async (shard) =>
        readLongMemEvalDiagnosticsSidecar(
          { historyRoot: shard.root },
          "public",
          shard.slug
        )
      )
    );
    const mergedEmbeddingVectorCache = aggregateEmbeddingVectorCache(
      shardDiagnostics
        .map((diagnostics) => diagnostics?.embedding_vector_cache)
        .filter(
          (summary): summary is LongMemEvalEmbeddingVectorCacheSummary =>
            summary !== undefined
        )
    );
    const mergedQueryEmbeddingCache = aggregateQueryEmbeddingCache(
      shardDiagnostics
        .map((diagnostics) => diagnostics?.query_embedding_cache)
        .filter(
          (summary): summary is LongMemEvalQueryEmbeddingCacheSummary =>
            summary !== undefined
        )
    );
    merged = {
      ...merged,
      kpi: {
        ...merged.kpi,
        ...(mergedEmbeddingVectorCache === null
          ? {}
          : {
              embedding_vector_cache_ready_rate:
                mergedEmbeddingVectorCache.ready_rate
            }),
        ...(mergedQueryEmbeddingCache === null
          ? {}
          : {
              query_embedding_cache_ready_rate:
                mergedQueryEmbeddingCache.ready_rate
            })
      }
    };

    const layout: HistoryLayout = { historyRoot: opts.historyRoot };
    const previous = await readLatest(layout, "public", {
      split: first.split,
      policyShape,
      simulateReport,
      embeddingProvider: merged.embedding_provider,
      pointerKind: "passing"
    });
    const diff = diffKpis(merged, previous);
    merged.diff_vs_previous = buildDiffVsPrevious(
      merged,
      previous,
      previous?.run_at ?? ""
    );
    const slug = entrySlug(
      runAt,
      commitSha7,
      benchArchiveDiscriminator(policyShape, simulateReport)
    );
    const report = appendSeedExtractionReleaseBlockerToReport(
      renderReport(merged, previous, diff),
      merged
    );
    const findings = appendSeedExtractionReleaseBlockerToFindings(
      renderFindings(merged, diff),
      merged
    );
    const shardEvidence = shardDiagnostics.map((diagnostics) =>
      archiveEvidenceFromDiagnostics(diagnostics)
    );
    const currentEvidence = aggregateLongMemEvalArchiveEvidence(shardEvidence);
    const diagnosticsPayload = buildMergedLongMemEvalDiagnosticsSidecar(
      merged,
      shardDiagnostics,
      currentEvidence
    );
    const fullDiagnosticsSidecar = renderDiagnosticsSidecar(
      diagnosticsPayload.sidecar
    );
    const fullDiagnosticsArtifactPath = await writeExternalDiagnosticsArtifact({
      historyRoot: opts.historyRoot,
      benchName: "public",
      slug,
      filename: LONGMEMEVAL_DIAGNOSTICS_FILENAME,
      contents: fullDiagnosticsSidecar
    });
    const diagnosticsSidecar = renderMergedLongMemEvalCompactDiagnosticsSidecar(
      diagnosticsPayload,
      fullDiagnosticsArtifactPath
    );
    const opposite = await readLatestLongMemEvalOppositeArchive({
      layout,
      current: merged
    });
    const comparisonSidecar = renderLongMemEvalColdWarmComparisonSidecar(
      buildLongMemEvalColdWarmComparisonSidecar({
        currentSlug: slug,
        current: merged,
        currentEvidence,
        opposite
      })
    );
    const entry = await writeEntry(layout, "public", slug, merged, report, findings, {
      sidecars: [
        {
          filename: LONGMEMEVAL_DIAGNOSTICS_FILENAME,
          contents: diagnosticsSidecar
        },
        {
          filename: LONGMEMEVAL_COLD_WARM_COMPARISON_FILENAME,
          contents: comparisonSidecar
        }
      ]
    });

    process.stdout.write(
      `Merged ${shards.length} shards -> slug ${slug}\n` +
        `  evaluated=${evaluatedTotal} R@1=${pct(rAt1)} R@5=${pct(rAt5)} R@10=${pct(rAt10)}\n` +
        (hasExactMergedLatency
          ? `  latency p50=${latencyP50}ms p95=${latencyP95}ms\n`
          : `  latency p50<=${latencyP50}ms p95<=${latencyP95}ms (worst-shard upper bound)\n`) +
        `  KPI: ${entry.kpiPath}\n`
    );
    return exitCodeForMergedLongMemEvalResult(merged);
  } catch (err) {
    process.stderr.write(
      `alaya-bench-runner merge-longmemeval: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 2;
  }
}
