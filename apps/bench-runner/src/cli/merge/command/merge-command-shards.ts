import {
  buildTokenEconomy,
  computeTokenSavedRatio,
  KpiPayloadSchema,
  type KpiPayload,
  type PerScenarioRow
} from "@do-soul/alaya-eval";
import { aggregateBenchTokenMetrics } from "../../../harness/token/token-economy.js";
import type { BenchTokenMetrics } from "../../../harness/daemon.js";
import type { LongMemEvalQuestionDiagnostic } from "../../../diagnostics/diagnostics.js";
import { resolveBenchCommitSha7 } from "../../../shared/version.js";
import { buildMergedFullGoldCoverage, hasExactQuestionDiagnosticsSet } from "../merge-full-gold.js";
import { rAt5WithProviderReturned } from "../../../diagnostics/diagnostics-question.js";
import {
  mergeSeedExtractionPath,
  ratio,
  stableJson
} from "../../merge-shared.js";
import {
  assertMergeMeasurementContracts,
  mergeQualityMetrics
} from "../quality/merge-quality.js";
import type { LoadedMergeShards } from "../canonical-shard-plan.js";
export {
  loadCanonicalMergeShards as loadMergeShards,
  type LoadedMergeShards,
  type ShardArchiveRef
} from "../canonical-shard-plan.js";
import { buildMergedSelectionContract } from "../merged/merged-selection-contract.js";
import {
  selectionContractIdentity,
  type LongMemEvalSelectionContract
} from "../../../runs/selection/contract.js";
import { buildMergedRates, type MergedRates } from "../merged/merged-rates.js";
import { computeScorableHits } from "../../../runs/lifecycle/recall-eval/recall-eval-shards-merge-payload.js";
import { overallRecallAt5 } from "../../../runs/measurement/answerable-recall.js";
import { isAbstentionQuestionId } from "../../../diagnostics/abstention.js";

export interface MergedLongMemEvalBuild {
  readonly payload: KpiPayload;
  readonly selectionContract: LongMemEvalSelectionContract | null;
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
export function buildMergedLongMemEvalPayload(
  loaded: LoadedMergeShards
): MergedLongMemEvalBuild {
  assertCompatibleShardIdentities(loaded.payloads, loaded.first);
  assertNoDuplicateQuestions(loaded.payloads);
  assertMergeMeasurementContracts(loaded.payloads);
  const aggregate = aggregateMergeShards(loaded.payloads, loaded.questionDiagnostics);
  if (aggregate.evaluatedTotal > loaded.first.sample_size) {
    throw new Error(
      `merge refused: evaluated_total=${aggregate.evaluatedTotal} > sample_size=${loaded.first.sample_size} (shards collectively over-evaluated; check --offset/--limit ranges)`
    );
  }
  const selectionContract = buildMergedSelectionContract(loaded.archiveRefs);
  return buildMergedPayload(
    loaded.first,
    loaded.payloads,
    aggregate,
    loaded.questionDiagnostics,
    selectionContract
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

const PROVIDER_RATE_FIELDS = [
  "provider_returned_rate",
  "provider_pending_rate",
  "provider_failed_rate",
  "provider_not_requested_rate",
  "query_embedding_unusable_rate"
] as const satisfies readonly (keyof KpiPayload["kpi"])[];
type ProviderRateField = (typeof PROVIDER_RATE_FIELDS)[number];
type ProviderRateTotals = Record<ProviderRateField, number>;

interface MergeShardAggregate {
  readonly perScenario: PerScenarioRow[];
  readonly shardTokenEconomies: BenchTokenMetrics[];
  providerRateFields: readonly ProviderRateField[];
  providerRateTotals: ProviderRateTotals;
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
  returnedSubsetRAt5: number | undefined;
  evaluatedTotal: number;
  latencyP50Max: number;
  latencyP95Max: number;
}

function createMergeShardAggregate(
  payloads: readonly KpiPayload[]
): MergeShardAggregate {
  return {
    perScenario: [],
    shardTokenEconomies: [],
    // These KPI fields are optional in the persisted contract. A field is
    // reportable only when every shard declares it; an absent field is
    // unavailable, not a measured zero. The evaluated denominator stays whole.
    providerRateFields: PROVIDER_RATE_FIELDS.filter((field) =>
      payloads.every((payload) => payload.kpi[field] !== undefined)),
    providerRateTotals: {
      provider_returned_rate: 0,
      provider_pending_rate: 0,
      provider_failed_rate: 0,
      provider_not_requested_rate: 0,
      query_embedding_unusable_rate: 0
    },
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
    returnedSubsetRAt5: undefined,
    evaluatedTotal: 0,
    latencyP50Max: 0,
    latencyP95Max: 0
  };
}

function aggregateMergeShards(
  payloads: readonly KpiPayload[],
  questionDiagnostics: readonly LongMemEvalQuestionDiagnostic[]
): MergeShardAggregate {
  const aggregate = createMergeShardAggregate(payloads);
  for (const shard of payloads) {
    addShardTotals(aggregate, shard);
    addShardProviderTotals(aggregate, shard);
    aggregate.evaluatedTotal += shard.evaluated_count;
    aggregate.latencyP50Max = Math.max(aggregate.latencyP50Max, shard.kpi.latency_ms_p50);
    aggregate.latencyP95Max = Math.max(aggregate.latencyP95Max, shard.kpi.latency_ms_p95);
  }
  const hits = computeScorableHits(
    bindLegacyUnboundRows(aggregate.perScenario),
    indexCliHitDiagnostics(questionDiagnostics)
  );
  aggregate.totalHitAt1 = hits.hitsAt1;
  aggregate.totalHitAt5 = hits.hitsAt5;
  aggregate.totalHitAt10 = hits.hitsAt10;
  // Legacy archives may retain only some scenario detail; their omitted rows
  // remain in the declared denominator rather than becoming inferred successes.
  aggregate.answerableTotal = hits.answerableCount + payloads.reduce((count, shard) =>
    count + (shard.answerable_evaluated_count === undefined
      ? Math.max(0, shard.evaluated_count - shard.kpi.per_scenario.length) : 0), 0);
  // A subset rate cannot recover its denominator from all-returned availability.
  // Historical or partial diagnostics do not establish the current scored cohort.
  if (questionDiagnostics.length === aggregate.evaluatedTotal &&
      hasExactQuestionDiagnosticsSet(questionDiagnostics, aggregate.perScenario) &&
      questionDiagnostics.every((question) => question.cohort_ledger !== undefined &&
        question.cohort_ledger.measurement_evidence_mode !== "legacy_synthesized" &&
        question.provider_state !== undefined)) {
    aggregate.returnedSubsetRAt5 = rAt5WithProviderReturned(questionDiagnostics);
  }
  return aggregate;
}

function addShardTotals(aggregate: MergeShardAggregate, shard: KpiPayload): void {
  if (shard.kpi.token_economy !== undefined) {
    aggregate.shardTokenEconomies.push(shard.kpi.token_economy);
  }
  aggregate.perScenario.push(...shard.kpi.per_scenario);
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

function bindLegacyUnboundRows(
  rows: readonly PerScenarioRow[]
): readonly PerScenarioRow[] {
  return rows.map((row) => {
    if (row.scorable !== undefined && row.measurement_cohort !== undefined) return row;
    if (row.scorable !== undefined || row.measurement_cohort !== undefined) return row;
    return {
      ...row,
      scorable: !isAbstentionQuestionId(row.id),
      measurement_cohort: isAbstentionQuestionId(row.id)
        ? "dataset_declared_abstention" as const : "answerable" as const
    };
  });
}

function indexCliHitDiagnostics(
  questionDiagnostics: readonly LongMemEvalQuestionDiagnostic[]
): ReadonlyMap<string, Record<string, unknown>> {
  const byId = new Map<string, Record<string, unknown>>();
  for (const diagnostic of questionDiagnostics) {
    if (byId.has(diagnostic.question_id)) {
      throw new Error(
        `merge refused: duplicate diagnostic question_id '${diagnostic.question_id}'`
      );
    }
    byId.set(diagnostic.question_id, diagnostic as unknown as Record<string, unknown>);
  }
  return byId;
}

function addShardProviderTotals(
  aggregate: MergeShardAggregate,
  shard: KpiPayload
): void {
  for (const field of aggregate.providerRateFields) {
    // createMergeShardAggregate selects only fields present on every shard.
    const rate = shard.kpi[field]!;
    aggregate.providerRateTotals[field] += Math.round(rate * shard.evaluated_count);
  }
}

function buildMergedPayload(
  first: KpiPayload,
  payloads: readonly KpiPayload[],
  aggregate: MergeShardAggregate,
  questionDiagnostics: readonly LongMemEvalQuestionDiagnostic[],
  selectionContract: LongMemEvalSelectionContract | null
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
    selectionContract,
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
      ...(selectionContract === null
        ? {}
        : { selection_contract: selectionContractIdentity(selectionContract) }),
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
    ...(first.kpi.r_at_5_overall === undefined ? {} : {
      r_at_5_overall: overallRecallAt5(aggregate.perScenario, aggregate.evaluatedTotal) ?? undefined
    }),
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
): { readonly economy?: KpiPayload["kpi"]["token_economy"]; readonly savedRatio: number | null } {
  if (aggregate.shardTokenEconomies.length !== shardCount) {
    return { savedRatio: null };
  }
  const input = aggregateBenchTokenMetrics(aggregate.shardTokenEconomies);
  return { economy: buildTokenEconomy(input), savedRatio: computeTokenSavedRatio(input) };
}

function providerKpiFields(
  aggregate: MergeShardAggregate
): Partial<KpiPayload["kpi"]> {
  return {
    ...(aggregate.returnedSubsetRAt5 !== undefined
      ? {
          r_at_5_with_embedding_returned: aggregate.returnedSubsetRAt5
        }
      : {}),
    ...availableProviderRates(aggregate)
  };
}

function availableProviderRates(
  aggregate: MergeShardAggregate
): Partial<Record<ProviderRateField, number>> {
  const rates: Partial<Record<ProviderRateField, number>> = {};
  for (const field of aggregate.providerRateFields) {
    rates[field] = ratio(aggregate.providerRateTotals[field], aggregate.evaluatedTotal);
  }
  return rates;
}
