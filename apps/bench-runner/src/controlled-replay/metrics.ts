import type { SoulMemorySearchResponse } from "@do-soul/alaya-protocol";
import type {
  ControlledReplayArchive,
  FixtureQuestion,
  NativeHealthGate,
  RecallObservation,
  ScenarioArchive,
  ScenarioMetrics,
  SeedSidecar
} from "./types.js";
import {
  absDelta,
  computeQuestionRankGain,
  emptyRankDistribution,
  hasEvidenceStreamContribution,
  hasPathStreamContribution,
  metricsFor,
  minNativeHealthGate,
  rankBucket,
  ratio,
  readCandidateDiagnostics,
  round
} from "./metrics-helpers.js";
export const controlledReplayTestHooks = Object.freeze({ computeMetrics });

export function buildObservation(
  question: FixtureQuestion,
  recall: SoulMemorySearchResponse & { readonly diagnostics?: unknown },
  sidecar: ReadonlyMap<string, SeedSidecar>
): RecallObservation {
  const expected = new Set(question.expectedSeedIds);
  let expectedRank: number | null = null;
  for (let index = 0; index < recall.results.length; index++) {
    const result = recall.results[index];
    if (result === undefined) continue;
    const seed = sidecar.get(result.object_id);
    if (seed !== undefined && expected.has(seed.fixtureId)) {
      expectedRank = index + 1;
      break;
    }
  }
  return {
    questionId: question.id,
    deliveryId: recall.delivery_id,
    results: recall.results,
    activeConstraints: recall.active_constraints ?? [],
    diagnostics: readCandidateDiagnostics(recall.diagnostics),
    expectedObjectIds: [...sidecar.entries()]
      .filter(([, seed]) => expected.has(seed.fixtureId))
      .map(([objectId]) => objectId),
    expectedRank
  };
}

interface ObservationMetricAccumulator {
  readonly rankDistribution: Record<string, number>;
  readonly expectedRankByQuestion: Record<string, number | null>;
  rankTotal: number;
  rankedCount: number;
  hitAt5: number;
  nonMonotonic: number;
  activeConstraints: number;
  budgetDropMaxEntries: number;
  highLexicalDemoted: number;
  conflictPenalty: number;
  evidenceStreamGoldDeliveryCount: number;
  evidenceStreamGoldDeliveryDenominator: number;
  pathStreamTop10Count: number;
  pathStreamTop10Denominator: number;
  diagnosticsCount: number;
}

function accumulateObservationMetrics(
  observations: readonly RecallObservation[]
): ObservationMetricAccumulator {
  const acc: ObservationMetricAccumulator = {
    rankDistribution: emptyRankDistribution(),
    expectedRankByQuestion: {},
    rankTotal: 0,
    rankedCount: 0,
    hitAt5: 0,
    nonMonotonic: 0,
    activeConstraints: 0,
    budgetDropMaxEntries: 0,
    highLexicalDemoted: 0,
    conflictPenalty: 0,
    evidenceStreamGoldDeliveryCount: 0,
    evidenceStreamGoldDeliveryDenominator: 0,
    pathStreamTop10Count: 0,
    pathStreamTop10Denominator: 0,
    diagnosticsCount: 0
  };
  for (const observation of observations) {
    const expectedObjectIds = new Set(observation.expectedObjectIds);
    acc.expectedRankByQuestion[observation.questionId] = observation.expectedRank;
    const bucket = rankBucket(observation.expectedRank);
    acc.rankDistribution[bucket] = (acc.rankDistribution[bucket] ?? 0) + 1;
    if (observation.expectedRank !== null) {
      acc.rankTotal += observation.expectedRank;
      acc.rankedCount++;
      if (observation.expectedRank <= 5) {
        acc.hitAt5++;
      }
    }
    acc.activeConstraints += observation.activeConstraints.length;
    for (const diagnostic of observation.diagnostics) {
      accumulateDiagnostic(acc, diagnostic, expectedObjectIds);
    }
    for (const result of observation.results) {
      if ((result.score_factors.conflict_penalty ?? 0) > 0) {
        acc.conflictPenalty++;
      }
    }
  }
  return acc;
}

function accumulateDiagnostic(
  acc: ObservationMetricAccumulator,
  diagnostic: RecallObservation["diagnostics"][number],
  expectedObjectIds: ReadonlySet<string>
): void {
  acc.diagnosticsCount++;
  if (diagnostic.final_rank !== null && diagnostic.final_rank <= 10) {
    acc.pathStreamTop10Denominator++;
    if (hasPathStreamContribution(diagnostic)) {
      acc.pathStreamTop10Count++;
    }
  }
  if (expectedObjectIds.has(diagnostic.object_id)) {
    acc.evidenceStreamGoldDeliveryDenominator++;
    if (
      diagnostic.final_rank !== null &&
      diagnostic.final_rank <= 10 &&
      hasEvidenceStreamContribution(diagnostic)
    ) {
      acc.evidenceStreamGoldDeliveryCount++;
    }
  }
  if (
    diagnostic.final_rank !== null &&
    diagnostic.pre_budget_rank !== null &&
    diagnostic.final_rank !== diagnostic.pre_budget_rank
  ) {
    acc.nonMonotonic++;
  }
  if (diagnostic.dropped_reason === "max_entries") {
    acc.budgetDropMaxEntries++;
  }
  if (
    diagnostic.lexical_rank !== null &&
    diagnostic.lexical_rank >= 0.75 &&
    (diagnostic.final_rank === null || diagnostic.final_rank > 5)
  ) {
    acc.highLexicalDemoted++;
  }
}

export function computeMetrics(
  observations: readonly RecallObservation[]
): ScenarioMetrics {
  const acc = accumulateObservationMetrics(observations);
  return {
    rank_distribution: acc.rankDistribution,
    expected_rank_by_question: acc.expectedRankByQuestion,
    hit_at_5: {
      count: acc.hitAt5,
      rate: ratio(acc.hitAt5, observations.length)
    },
    average_expected_rank: acc.rankedCount === 0 ? null : round(acc.rankTotal / acc.rankedCount),
    non_monotonic: { count: acc.nonMonotonic },
    active_constraints: { count: acc.activeConstraints },
    budget_drop: { max_entries: acc.budgetDropMaxEntries },
    high_lexical_demoted: { count: acc.highLexicalDemoted },
    conflict_penalty: { count: acc.conflictPenalty },
    evidence_stream_gold_delivery: {
      count: acc.evidenceStreamGoldDeliveryCount,
      denominator: acc.evidenceStreamGoldDeliveryDenominator,
      rate: ratio(
        acc.evidenceStreamGoldDeliveryCount,
        acc.evidenceStreamGoldDeliveryDenominator
      )
    },
    path_stream_top10: {
      count: acc.pathStreamTop10Count,
      denominator: acc.pathStreamTop10Denominator,
      rate: ratio(acc.pathStreamTop10Count, acc.pathStreamTop10Denominator)
    },
    delivery_count: observations.length,
    diagnostics_count: acc.diagnosticsCount
  };
}

export function aggregateScenarioMetrics(
  scenarios: readonly ScenarioArchive[]
): ScenarioMetrics {
  const rankDistribution = emptyRankDistribution();
  const expectedRankByQuestion: Record<string, number | null> = {};
  let rankTotal = 0;
  let rankedScenarioCount = 0;
  let hitAt5Count = 0;
  let hitAt5Denominator = 0;
  let nonMonotonic = 0;
  let activeConstraints = 0;
  let budgetDropMaxEntries = 0;
  let highLexicalDemoted = 0;
  let conflictPenalty = 0;
  let evidenceStreamGoldDeliveryCount = 0;
  let evidenceStreamGoldDeliveryDenominator = 0;
  let pathStreamTop10Count = 0;
  let pathStreamTop10Denominator = 0;
  let deliveryCount = 0;
  let diagnosticsCount = 0;

  for (const scenario of scenarios) {
    for (const [questionId, rank] of Object.entries(scenario.metrics.expected_rank_by_question)) {
      expectedRankByQuestion[`${scenario.label}/${questionId}`] = rank;
    }
    for (const [bucket, count] of Object.entries(scenario.metrics.rank_distribution)) {
      rankDistribution[bucket] = (rankDistribution[bucket] ?? 0) + count;
    }
    if (scenario.metrics.average_expected_rank !== null) {
      rankTotal += scenario.metrics.average_expected_rank;
      rankedScenarioCount++;
    }
    hitAt5Count += scenario.metrics.hit_at_5.count;
    hitAt5Denominator += scenario.metrics.delivery_count;
    nonMonotonic += scenario.metrics.non_monotonic.count;
    activeConstraints += scenario.metrics.active_constraints.count;
    budgetDropMaxEntries += scenario.metrics.budget_drop.max_entries;
    highLexicalDemoted += scenario.metrics.high_lexical_demoted.count;
    conflictPenalty += scenario.metrics.conflict_penalty.count;
    evidenceStreamGoldDeliveryCount +=
      scenario.metrics.evidence_stream_gold_delivery.count;
    evidenceStreamGoldDeliveryDenominator +=
      scenario.metrics.evidence_stream_gold_delivery.denominator;
    pathStreamTop10Count += scenario.metrics.path_stream_top10.count;
    pathStreamTop10Denominator += scenario.metrics.path_stream_top10.denominator;
    deliveryCount += scenario.metrics.delivery_count;
    diagnosticsCount += scenario.metrics.diagnostics_count;
  }

  return {
    rank_distribution: rankDistribution,
    expected_rank_by_question: expectedRankByQuestion,
    hit_at_5: {
      count: hitAt5Count,
      rate: ratio(hitAt5Count, hitAt5Denominator)
    },
    average_expected_rank:
      rankedScenarioCount === 0 ? null : round(rankTotal / rankedScenarioCount),
    non_monotonic: { count: nonMonotonic },
    active_constraints: { count: activeConstraints },
    budget_drop: { max_entries: budgetDropMaxEntries },
    high_lexical_demoted: { count: highLexicalDemoted },
    conflict_penalty: { count: conflictPenalty },
    evidence_stream_gold_delivery: {
      count: evidenceStreamGoldDeliveryCount,
      denominator: evidenceStreamGoldDeliveryDenominator,
      rate: ratio(
        evidenceStreamGoldDeliveryCount,
        evidenceStreamGoldDeliveryDenominator
      )
    },
    path_stream_top10: {
      count: pathStreamTop10Count,
      denominator: pathStreamTop10Denominator,
      rate: ratio(pathStreamTop10Count, pathStreamTop10Denominator)
    },
    delivery_count: deliveryCount,
    diagnostics_count: diagnosticsCount
  };
}

export function buildColdWarmDelta(
  scenarios: readonly ScenarioArchive[]
): Record<string, number | null> {
  const cold = scenarios.find((scenario) => scenario.label === "cold-report-context-usage-none");
  const warm = scenarios.find((scenario) => scenario.label === "warm-report-context-usage-mixed");
  if (cold === undefined || warm === undefined) {
    return {
      average_expected_rank_delta: null,
      conflict_penalty_delta: null,
      active_constraints_delta: null,
      budget_drop_max_entries_delta: null
    };
  }
  return {
    average_expected_rank_delta:
      cold.metrics.average_expected_rank === null || warm.metrics.average_expected_rank === null
        ? null
        : round(warm.metrics.average_expected_rank - cold.metrics.average_expected_rank),
    conflict_penalty_delta:
      warm.metrics.conflict_penalty.count - cold.metrics.conflict_penalty.count,
    active_constraints_delta:
      warm.metrics.active_constraints.count - cold.metrics.active_constraints.count,
    budget_drop_max_entries_delta:
      warm.metrics.budget_drop.max_entries - cold.metrics.budget_drop.max_entries
  };
}

export function buildNativeHealthGates(
  scenarios: readonly ScenarioArchive[],
  aggregateMetrics: ScenarioMetrics
): readonly NativeHealthGate[] {
  const warm = scenarios.find((scenario) => scenario.label === "warm-report-context-usage-mixed");
  const cold = scenarios.find((scenario) => scenario.label === "cold-report-context-usage-none");
  const trustLoopGain =
    warm?.pre_report_metrics === undefined
      ? null
      : round(warm.metrics.hit_at_5.rate - warm.pre_report_metrics.hit_at_5.rate);
  const plasticityRankGain = computeQuestionRankGain(
    cold?.metrics.expected_rank_by_question ?? null,
    warm?.metrics.expected_rank_by_question ?? null,
    "q-path-target"
  );
  const evidenceStreamGoldDelivery =
    aggregateMetrics.evidence_stream_gold_delivery.rate;
  const pathStreamTop10Contribution = warm?.metrics.path_stream_top10.rate ?? null;

  return Object.freeze([
    minNativeHealthGate(
      "trust_loop_activation_gain",
      "trust loop activation gain",
      trustLoopGain,
      0.05
    ),
    minNativeHealthGate(
      "evidence_stream_gold_delivery",
      "evidence stream gold delivery",
      evidenceStreamGoldDelivery,
      0.15
    ),
    minNativeHealthGate(
      "path_stream_top10_contribution",
      "path stream top-10 contribution",
      pathStreamTop10Contribution,
      0.1
    ),
    minNativeHealthGate(
      "plasticity_gradient_rank_gain",
      "plasticity canary rank gain",
      plasticityRankGain,
      2
    )
  ]);
}

export function buildContributionSuspects(
  scenarios: readonly ScenarioArchive[]
): ControlledReplayArchive["contribution_suspects"] {
  const uniform = metricsFor(scenarios, "uniform-fact");
  const rotated = metricsFor(scenarios, "rotated-kind");
  const stress = metricsFor(scenarios, "stress-policy-max10-conflict-true");
  const chat = metricsFor(scenarios, "chat-policy-max10-conflict-false");
  const cold = metricsFor(scenarios, "cold-report-context-usage-none");
  const warm = metricsFor(scenarios, "warm-report-context-usage-mixed");

  const suspects: Array<{
    readonly label: string;
    readonly score: number;
    readonly evidence: Record<string, number | null>;
  }> = [
    {
      label: "object_kind_rotation",
      score: absDelta(rotated?.average_expected_rank, uniform?.average_expected_rank) +
        (rotated?.active_constraints.count ?? 0),
      evidence: {
        uniform_avg_rank: uniform?.average_expected_rank ?? null,
        rotated_avg_rank: rotated?.average_expected_rank ?? null,
        rotated_active_constraints: rotated?.active_constraints.count ?? null
      }
    },
    {
      label: "conflict_awareness",
      score: Math.abs(
        (stress?.conflict_penalty.count ?? 0) - (chat?.conflict_penalty.count ?? 0)
      ),
      evidence: {
        stress_conflict_penalty: stress?.conflict_penalty.count ?? null,
        chat_conflict_penalty: chat?.conflict_penalty.count ?? null
      }
    },
    {
      label: "delivery_budget",
      score: stress?.budget_drop.max_entries ?? 0,
      evidence: {
        stress_budget_drop_max_entries: stress?.budget_drop.max_entries ?? null
      }
    },
    {
      label: "cold_warm_usage",
      score: absDelta(warm?.average_expected_rank, cold?.average_expected_rank),
      evidence: {
        cold_avg_rank: cold?.average_expected_rank ?? null,
        warm_avg_rank: warm?.average_expected_rank ?? null
      }
    },
    {
      label: "lexical_structural_blend",
      score: stress?.high_lexical_demoted.count ?? 0,
      evidence: {
        high_lexical_demoted: stress?.high_lexical_demoted.count ?? null
      }
    }
  ];

  return suspects
    .map((suspect) => ({ ...suspect, score: round(suspect.score) }))
    .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label))
    .slice(0, 3);
}
