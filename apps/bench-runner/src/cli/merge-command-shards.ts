import {
  buildTokenEconomy,
  computeTokenSavedRatio,
  KpiPayloadSchema,
  type KpiPayload,
  type PerScenarioRow
} from "@do-soul/alaya-eval";
import { aggregateBenchTokenMetrics } from "../harness/token-economy.js";
import type { BenchTokenMetrics } from "../harness/daemon.js";
import type {
  LongMemEvalDiagnosticsSidecar,
  LongMemEvalQuestionDiagnostic
} from "../longmemeval/diagnostics.js";
import { resolveBenchCommitSha7 } from "../shared/version.js";
import { buildMergedFullGoldCoverage } from "./merge-full-gold.js";
import { pct } from "./result-format.js";
import {
  mergeSeedExtractionPath,
  ratio,
  stableJson
} from "./merge-shared.js";
import {
  assertMergeMeasurementContracts,
  mergeQualityMetrics
} from "./merge-quality.js";
import type { LongMemEvalDiagnosticsSpool } from "../longmemeval/diagnostics/spool.js";
import {
  isCurrentStreamedDiagnostics,
  readShardPayload
} from "./merge/shard-diagnostics-reader.js";
import { buildMergedRates, type MergedRates } from "./merge/merged-rates.js";

export interface ShardArchiveRef {
  readonly root: string;
  readonly slug: string;
  readonly payload: KpiPayload;
  readonly diagnostics: LongMemEvalDiagnosticsSidecar;
}
export interface LoadedMergeShards {
  readonly payloads: readonly KpiPayload[];
  readonly archiveRefs: readonly ShardArchiveRef[];
  readonly questionDiagnostics: readonly LongMemEvalQuestionDiagnostic[];
  readonly first: KpiPayload;
}
export interface MergedLongMemEvalBuild {
  readonly payload: KpiPayload;
  readonly runAt: Date;
  readonly commitSha7: string;
  readonly policyShape: NonNullable<KpiPayload["policy_shape"]>;
  readonly simulateReport: NonNullable<KpiPayload["simulate_report"]>;
  readonly rAt1: number;
  readonly rAt5: number;
  readonly rAt10: number;
  readonly latencyP50: number;
  readonly latencyP95: number;
  readonly hasExactMergedLatency: boolean;
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
export async function loadMergeShards(
  shards: readonly string[],
  diagnosticsSpool: LongMemEvalDiagnosticsSpool
): Promise<LoadedMergeShards> {
  const payloads: KpiPayload[] = [];
  const archiveRefs: ShardArchiveRef[] = [];
  const questionDiagnostics: LongMemEvalQuestionDiagnostic[] = [];
  for (const shardRoot of shards) {
    const {
      payload,
      slug,
      diagnostics,
      questionDiagnostics: shardQuestionDiagnostics
    } = await readShardPayload(shardRoot, diagnosticsSpool);
    payloads.push(payload);
    archiveRefs.push({ root: shardRoot, slug, payload, diagnostics });
    questionDiagnostics.push(...shardQuestionDiagnostics);
    process.stdout.write(
      `  shard ${shardRoot}: ${payload.evaluated_count} questions, ` +
        `R@5=${pct(payload.kpi.r_at_5)}\n`
    );
  }
  const first = payloads[0];
  if (first === undefined) {
    throw new Error("no shards loaded");
  }
  assertCurrentDiagnosticsSpoolCount(payloads, archiveRefs, diagnosticsSpool);
  return { payloads, archiveRefs, questionDiagnostics, first };
}

function assertCurrentDiagnosticsSpoolCount(
  payloads: readonly KpiPayload[],
  archiveRefs: readonly ShardArchiveRef[],
  diagnosticsSpool: LongMemEvalDiagnosticsSpool
): void {
  if (!archiveRefs.every((shard) => isCurrentStreamedDiagnostics(shard.diagnostics))) {
    return;
  }
  const evaluatedCount = payloads.reduce(
    (total, payload) => total + payload.evaluated_count,
    0
  );
  if (diagnosticsSpool.questionCount !== evaluatedCount) {
    throw new Error(
      `merged evaluated_count=${evaluatedCount} does not match diagnostics spool question count=${diagnosticsSpool.questionCount}`
    );
  }
}

export function buildMergedLongMemEvalPayload(
  loaded: LoadedMergeShards
): MergedLongMemEvalBuild {
  assertCompatibleShardIdentities(loaded.payloads, loaded.first);
  assertNoDuplicateQuestions(loaded.payloads);
  assertMergeMeasurementContracts(loaded.payloads);
  const aggregate = aggregateMergeShards(loaded.payloads);
  if (aggregate.evaluatedTotal > loaded.first.sample_size) {
    throw new Error(
      `merge refused: evaluated_total=${aggregate.evaluatedTotal} > sample_size=${loaded.first.sample_size} (shards collectively over-evaluated; check --offset/--limit ranges)`
    );
  }
  return buildMergedPayload(
    loaded.first,
    loaded.payloads,
    aggregate,
    loaded.questionDiagnostics
  );
}

function assertCompatibleShardIdentities(
  payloads: readonly KpiPayload[],
  first: KpiPayload
): void {
  for (let i = 1; i < payloads.length; i++) {
    const shard = payloads[i];
    if (shard === undefined) continue;
    assertScalarIdentity(first, shard, i);
    assertDatasetIdentity(first, shard, i);
    if (JSON.stringify(shard.seed_policy ?? null) !== JSON.stringify(first.seed_policy ?? null)) {
      throw new Error(`merge refused: shard[${i}] seed_policy differs from shard[0]`);
    }
    if (stableJson(shard.recall_weight_overrides ?? null) !== stableJson(first.recall_weight_overrides ?? null)) {
      throw new Error(
        `merge refused: shard[${i}] recall_weight_overrides != shard[0] recall_weight_overrides`
      );
    }
  }
}

function assertScalarIdentity(
  first: KpiPayload,
  shard: KpiPayload,
  index: number
): void {
  for (const field of SCALAR_IDENTITY_FIELDS) {
    if (shard[field] !== first[field]) {
      throw new Error(
        `merge refused: shard[${index}] ${field}=${String(shard[field])} != shard[0] ${field}=${String(first[field])}`
      );
    }
  }
}

function assertDatasetIdentity(
  first: KpiPayload,
  shard: KpiPayload,
  index: number
): void {
  if (
    shard.dataset.name === first.dataset.name &&
    shard.dataset.size === first.dataset.size &&
    shard.dataset.source === first.dataset.source &&
    shard.dataset.checksum_sha256 === first.dataset.checksum_sha256 &&
    shard.dataset.checksum_source === first.dataset.checksum_source
  ) {
    return;
  }
  throw new Error(
    `merge refused: shard[${index}] dataset identity (${shard.dataset.name}/${shard.dataset.size}/${shard.dataset.source}) != shard[0] (${first.dataset.name}/${first.dataset.size}/${first.dataset.source})`
  );
}

function assertNoDuplicateQuestions(payloads: readonly KpiPayload[]): void {
  const seenIds = new Set<string>();
  for (const shard of payloads) {
    for (const row of shard.kpi.per_scenario) {
      if (seenIds.has(row.id)) {
        throw new Error(
          `merge refused: duplicate question_id '${row.id}' across shards (overlapping --offset/--limit ranges?)`
        );
      }
      seenIds.add(row.id);
    }
  }
}

interface MergeShardAggregate {
  readonly perScenario: PerScenarioRow[];
  readonly shardTokenEconomies: BenchTokenMetrics[];
  tierHot: number;
  tierWarm: number;
  tierCold: number;
  degradeNone: number;
  degradeWarm: number;
  degradeCold: number;
  degradePartial: number;
  truncSeedTotal: number;
  truncAnswerTotal: number;
  truncCharsTotal: number;
  totalHitAt1: number;
  totalHitAt5: number;
  totalHitAt10: number;
  answerableTotal: number;
  providerReturnedTotal: number;
  providerPendingTotal: number;
  providerFailedTotal: number;
  providerNotRequestedTotal: number;
  providerReturnedHitAt5: number;
  hasProviderRates: boolean;
  hasReturnedSubsetRAt5: boolean;
  evaluatedTotal: number;
  latencyP50Max: number;
  latencyP95Max: number;
}

function createMergeShardAggregate(): MergeShardAggregate {
  return {
    perScenario: [],
    shardTokenEconomies: [],
    tierHot: 0,
    tierWarm: 0,
    tierCold: 0,
    degradeNone: 0,
    degradeWarm: 0,
    degradeCold: 0,
    degradePartial: 0,
    truncSeedTotal: 0,
    truncAnswerTotal: 0,
    truncCharsTotal: 0,
    totalHitAt1: 0,
    totalHitAt5: 0,
    totalHitAt10: 0,
    answerableTotal: 0,
    providerReturnedTotal: 0,
    providerPendingTotal: 0,
    providerFailedTotal: 0,
    providerNotRequestedTotal: 0,
    providerReturnedHitAt5: 0,
    hasProviderRates: false,
    hasReturnedSubsetRAt5: false,
    evaluatedTotal: 0,
    latencyP50Max: 0,
    latencyP95Max: 0
  };
}

function aggregateMergeShards(payloads: readonly KpiPayload[]): MergeShardAggregate {
  const aggregate = createMergeShardAggregate();
  for (const shard of payloads) {
    addShardTotals(aggregate, shard);
    addShardProviderTotals(aggregate, shard);
    aggregate.evaluatedTotal += shard.evaluated_count;
    aggregate.latencyP50Max = Math.max(aggregate.latencyP50Max, shard.kpi.latency_ms_p50);
    aggregate.latencyP95Max = Math.max(aggregate.latencyP95Max, shard.kpi.latency_ms_p95);
  }
  return aggregate;
}

function addShardTotals(aggregate: MergeShardAggregate, shard: KpiPayload): void {
  if (shard.kpi.token_economy !== undefined) {
    aggregate.shardTokenEconomies.push(shard.kpi.token_economy);
  }
  aggregate.perScenario.push(...shard.kpi.per_scenario);
  const denominator = shard.answerable_evaluated_count ?? shard.evaluated_count;
  aggregate.answerableTotal += denominator;
  aggregate.totalHitAt1 += Math.round(shard.kpi.r_at_1 * denominator);
  aggregate.totalHitAt5 += shard.kpi.per_scenario.filter(
    (row) => row.scorable !== false && row.hit_at_5
  ).length;
  aggregate.totalHitAt10 += Math.round(shard.kpi.r_at_10 * denominator);
  aggregate.tierHot += shard.kpi.tier_distribution.hot;
  aggregate.tierWarm += shard.kpi.tier_distribution.warm;
  aggregate.tierCold += shard.kpi.tier_distribution.cold;
  aggregate.degradeNone += shard.kpi.degradation_reasons.none;
  aggregate.degradeWarm += shard.kpi.degradation_reasons.warm_cascade_engaged;
  aggregate.degradeCold += shard.kpi.degradation_reasons.cold_cascade_engaged;
  aggregate.degradePartial += shard.kpi.degradation_reasons.recall_explainability_partial;
  aggregate.truncSeedTotal += shard.kpi.seed_truncation.seed_turns_truncated;
  aggregate.truncAnswerTotal += shard.kpi.seed_truncation.answer_turns_truncated;
  aggregate.truncCharsTotal += shard.kpi.seed_truncation.seed_chars_clipped;
}

function addShardProviderTotals(
  aggregate: MergeShardAggregate,
  shard: KpiPayload
): void {
  if (!hasProviderRateFields(shard)) return;
  aggregate.hasProviderRates = true;
  const returned = Math.round(
    (shard.kpi.provider_returned_rate ?? 0) * shard.evaluated_count
  );
  aggregate.providerReturnedTotal += returned;
  aggregate.providerPendingTotal += Math.round(
    (shard.kpi.provider_pending_rate ?? 0) * shard.evaluated_count
  );
  aggregate.providerFailedTotal += Math.round(
    (shard.kpi.provider_failed_rate ?? 0) * shard.evaluated_count
  );
  aggregate.providerNotRequestedTotal += Math.round(
    (shard.kpi.provider_not_requested_rate ?? 0) * shard.evaluated_count
  );
  if (shard.kpi.r_at_5_with_embedding_returned !== undefined) {
    aggregate.hasReturnedSubsetRAt5 = true;
    aggregate.providerReturnedHitAt5 += Math.round(
      shard.kpi.r_at_5_with_embedding_returned * returned
    );
  }
}

function hasProviderRateFields(shard: KpiPayload): boolean {
  return (
    shard.kpi.provider_returned_rate !== undefined ||
    shard.kpi.provider_pending_rate !== undefined ||
    shard.kpi.provider_failed_rate !== undefined ||
    shard.kpi.provider_not_requested_rate !== undefined
  );
}

function buildMergedPayload(
  first: KpiPayload,
  payloads: readonly KpiPayload[],
  aggregate: MergeShardAggregate,
  questionDiagnostics: readonly LongMemEvalQuestionDiagnostic[]
): MergedLongMemEvalBuild {
  const runAt = new Date();
  const commitSha7 = resolveBenchCommitSha7();
  const policyShape = first.policy_shape ?? "stress";
  const simulateReport = first.simulate_report ?? "none";
  const rates = buildMergedRates(aggregate);
  const build = {
    ...rates,
    runAt,
    commitSha7,
    policyShape,
    simulateReport,
    payload: {
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
      ...(first.seed_policy === undefined ? {} : { seed_policy: first.seed_policy }),
      dataset: first.dataset,
      sample_size: first.sample_size,
      evaluated_count: aggregate.evaluatedTotal,
      ...(payloads.every((payload) => payload.answerable_evaluated_count !== undefined)
        ? { answerable_evaluated_count: aggregate.answerableTotal }
        : {}),
      harness_mode: first.harness_mode,
      kpi: buildMergedKpi(first, payloads, aggregate, rates, questionDiagnostics)
    }
  };
  return { ...build, payload: KpiPayloadSchema.parse(build.payload) };
}

function buildMergedKpi(
  first: KpiPayload,
  payloads: readonly KpiPayload[],
  aggregate: MergeShardAggregate,
  rates: MergedRates,
  questionDiagnostics: readonly LongMemEvalQuestionDiagnostic[]
): KpiPayload["kpi"] {
  const token = buildMergedTokenEconomy(aggregate, payloads.length);
  const qualityMetrics = mergeQualityMetrics(payloads);
  const seedExtractionPath = mergeSeedExtractionPath(payloads);
  const fullGoldCoverage = buildMergedFullGoldCoverage(
    questionDiagnostics,
    aggregate.perScenario
  );
  return {
    r_at_1: rates.rAt1,
    r_at_5: rates.rAt5,
    r_at_10: rates.rAt10,
    ...(first.kpi.r_at_5_overall === undefined ? {} : { r_at_5_overall: rates.rAt5 }),
    ...providerKpiFields(aggregate),
    latency_ms_p50: rates.latencyP50,
    latency_ms_p95: rates.latencyP95,
    latency_source: rates.hasExactMergedLatency ? "exact" : "worst_shard_bound",
    token_saved_ratio_vs_full_prompt: token.savedRatio,
    ...(token.economy === undefined ? {} : { token_economy: token.economy }),
    tier_distribution: { hot: aggregate.tierHot, warm: aggregate.tierWarm, cold: aggregate.tierCold },
    degradation_reasons: {
      none: aggregate.degradeNone,
      warm_cascade_engaged: aggregate.degradeWarm,
      cold_cascade_engaged: aggregate.degradeCold,
      recall_explainability_partial: aggregate.degradePartial
    },
    seed_truncation: {
      seed_turns_truncated: aggregate.truncSeedTotal,
      answer_turns_truncated: aggregate.truncAnswerTotal,
      seed_chars_clipped: aggregate.truncCharsTotal
    },
    ...(seedExtractionPath === undefined ? {} : { seed_extraction_path: seedExtractionPath }),
    ...(qualityMetrics === undefined ? {} : { quality_metrics: qualityMetrics }),
    ...(fullGoldCoverage === undefined ? {} : { full_gold_coverage: fullGoldCoverage }),
    per_scenario: aggregate.perScenario
  };
}

function buildMergedTokenEconomy(
  aggregate: MergeShardAggregate,
  shardCount: number
): { readonly economy?: KpiPayload["kpi"]["token_economy"]; readonly savedRatio: number } {
  if (aggregate.shardTokenEconomies.length !== shardCount) {
    return { savedRatio: 0 };
  }
  const input = aggregateBenchTokenMetrics(aggregate.shardTokenEconomies);
  return { economy: buildTokenEconomy(input), savedRatio: computeTokenSavedRatio(input) };
}

function providerKpiFields(
  aggregate: MergeShardAggregate
): Partial<KpiPayload["kpi"]> {
  return {
    ...(aggregate.hasReturnedSubsetRAt5 && aggregate.providerReturnedTotal > 0
      ? {
          r_at_5_with_embedding_returned:
            aggregate.providerReturnedHitAt5 / aggregate.providerReturnedTotal
        }
      : {}),
    ...(aggregate.hasProviderRates
      ? {
          provider_returned_rate: ratio(aggregate.providerReturnedTotal, aggregate.evaluatedTotal),
          provider_pending_rate: ratio(aggregate.providerPendingTotal, aggregate.evaluatedTotal),
          provider_failed_rate: ratio(aggregate.providerFailedTotal, aggregate.evaluatedTotal),
          provider_not_requested_rate: ratio(
            aggregate.providerNotRequestedTotal,
            aggregate.evaluatedTotal
          )
        }
      : {})
  };
}
