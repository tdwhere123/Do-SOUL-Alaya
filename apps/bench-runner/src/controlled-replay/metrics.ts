import type { SoulMemorySearchResponse } from "@do-soul/alaya-protocol";
import type {
  CandidateDiagnostic,
  ControlledReplayArchive,
  FixtureQuestion,
  NativeHealthGate,
  RecallObservation,
  ScenarioArchive,
  ScenarioLabel,
  ScenarioMetrics,
  SeedSidecar
} from "./types.js";

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

export function computeMetrics(
  observations: readonly RecallObservation[]
): ScenarioMetrics {
  const rankDistribution = emptyRankDistribution();
  const expectedRankByQuestion: Record<string, number | null> = {};
  let rankTotal = 0;
  let rankedCount = 0;
  let hitAt5 = 0;
  let nonMonotonic = 0;
  let activeConstraints = 0;
  let budgetDropMaxEntries = 0;
  let highLexicalDemoted = 0;
  let conflictPenalty = 0;
  let evidenceStreamGoldDeliveryCount = 0;
  let evidenceStreamGoldDeliveryDenominator = 0;
  let pathStreamTop10Count = 0;
  let pathStreamTop10Denominator = 0;
  let diagnosticsCount = 0;

  for (const observation of observations) {
    const expectedObjectIds = new Set(observation.expectedObjectIds);
    expectedRankByQuestion[observation.questionId] = observation.expectedRank;
    const bucket = rankBucket(observation.expectedRank);
    rankDistribution[bucket] = (rankDistribution[bucket] ?? 0) + 1;
    if (observation.expectedRank !== null) {
      rankTotal += observation.expectedRank;
      rankedCount++;
      if (observation.expectedRank <= 5) {
        hitAt5++;
      }
    }
    activeConstraints += observation.activeConstraints.length;
    for (const diagnostic of observation.diagnostics) {
      diagnosticsCount++;
      if (diagnostic.final_rank !== null && diagnostic.final_rank <= 10) {
        pathStreamTop10Denominator++;
        if (hasPathStreamContribution(diagnostic)) {
          pathStreamTop10Count++;
        }
      }
      if (expectedObjectIds.has(diagnostic.object_id)) {
        evidenceStreamGoldDeliveryDenominator++;
        if (
          diagnostic.final_rank !== null &&
          diagnostic.final_rank <= 10 &&
          hasEvidenceStreamContribution(diagnostic)
        ) {
          evidenceStreamGoldDeliveryCount++;
        }
      }
      if (
        diagnostic.final_rank !== null &&
        diagnostic.pre_budget_rank !== null &&
        diagnostic.final_rank !== diagnostic.pre_budget_rank
      ) {
        nonMonotonic++;
      }
      if (diagnostic.dropped_reason === "max_entries") {
        budgetDropMaxEntries++;
      }
      if (
        diagnostic.lexical_rank !== null &&
        diagnostic.lexical_rank >= 0.75 &&
        (diagnostic.final_rank === null || diagnostic.final_rank > 5)
      ) {
        highLexicalDemoted++;
      }
    }
    for (const result of observation.results) {
      if ((result.score_factors.conflict_penalty ?? 0) > 0) {
        conflictPenalty++;
      }
    }
  }

  return {
    rank_distribution: rankDistribution,
    expected_rank_by_question: expectedRankByQuestion,
    hit_at_5: {
      count: hitAt5,
      rate: ratio(hitAt5, observations.length)
    },
    average_expected_rank: rankedCount === 0 ? null : round(rankTotal / rankedCount),
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
    delivery_count: observations.length,
    diagnostics_count: diagnosticsCount
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

export const controlledReplayTestHooks = Object.freeze({
  computeMetrics
});

function minNativeHealthGate(
  id: NativeHealthGate["id"],
  label: string,
  current: number | null,
  target: number
): NativeHealthGate {
  return {
    id,
    label,
    current,
    target,
    direction: "min",
    passed: current !== null && current >= target,
    missing: current === null
  };
}

function computeQuestionRankGain(
  coldRanks: Readonly<Record<string, number | null>> | null,
  warmRanks: Readonly<Record<string, number | null>> | null,
  questionId: string
): number | null {
  if (
    coldRanks === null ||
    warmRanks === null ||
    !(questionId in coldRanks) ||
    !(questionId in warmRanks)
  ) {
    return null;
  }
  return round(rankOrMissPenalty(coldRanks[questionId]) - rankOrMissPenalty(warmRanks[questionId]));
}

function rankOrMissPenalty(rank: number | null | undefined): number {
  return rank === null || rank === undefined ? 11 : rank;
}

function metricsFor(
  scenarios: readonly ScenarioArchive[],
  label: ScenarioLabel
): ScenarioMetrics | undefined {
  return scenarios.find((scenario) => scenario.label === label)?.metrics;
}

function readCandidateDiagnostics(raw: unknown): readonly CandidateDiagnostic[] {
  if (raw === null || typeof raw !== "object") return [];
  const source = (raw as { readonly candidates?: unknown }).candidates;
  if (!Array.isArray(source)) return [];
  return source.flatMap((item): CandidateDiagnostic[] => {
    if (item === null || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const objectId = readString(record.object_id);
    if (objectId === null) return [];
    return [{
      object_id: objectId,
      pre_budget_rank: readNumber(record.pre_budget_rank),
      fused_rank: readNumber(record.fused_rank),
      final_rank: readNumber(record.final_rank),
      dropped_reason: readString(record.dropped_reason),
      lexical_rank: readNumber(record.lexical_rank),
      fused_rank_contribution_per_stream:
        readNumberRecord(record.fused_rank_contribution_per_stream),
      admission_planes: readStringArray(record.admission_planes),
      source_channels: readStringArray(record.source_channels)
    }];
  });
}

function emptyRankDistribution(): Record<string, number> {
  return { "1": 0, "2": 0, "3": 0, "4-5": 0, "6-10": 0, miss: 0 };
}

function rankBucket(rank: number | null): string {
  if (rank === 1) return "1";
  if (rank === 2) return "2";
  if (rank === 3) return "3";
  if (rank !== null && rank >= 4 && rank <= 5) return "4-5";
  if (rank !== null && rank >= 6 && rank <= 10) return "6-10";
  return "miss";
}

function hasEvidenceStreamContribution(diagnostic: CandidateDiagnostic): boolean {
  return (
    diagnostic.admission_planes.includes("evidence_anchor") ||
    diagnostic.admission_planes.includes("evidence_fts") ||
    diagnostic.source_channels.includes("evidence_anchor") ||
    diagnostic.source_channels.includes("evidence_fts") ||
    diagnostic.source_channels.includes("plane:evidence_anchor") ||
    diagnostic.source_channels.includes("plane:evidence_fts") ||
    (diagnostic.fused_rank_contribution_per_stream.evidence_fts ?? 0) > 0 ||
    (diagnostic.fused_rank_contribution_per_stream.evidence_structural_agreement ?? 0) > 0 ||
    (diagnostic.fused_rank_contribution_per_stream.source_evidence_agreement ?? 0) > 0
  );
}

function hasPathStreamContribution(diagnostic: CandidateDiagnostic): boolean {
  return (
    diagnostic.admission_planes.includes("path_expansion") ||
    diagnostic.source_channels.includes("path_expansion") ||
    diagnostic.source_channels.includes("plane:path_expansion") ||
    (diagnostic.fused_rank_contribution_per_stream.path_expansion ?? 0) > 0
  );
}

function absDelta(left: number | null | undefined, right: number | null | undefined): number {
  if (left === null || left === undefined || right === null || right === undefined) {
    return 0;
  }
  return Math.abs(left - right);
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readNumberRecord(value: unknown): Readonly<Record<string, number>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return Object.freeze({});
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value as Record<string, unknown>).flatMap(([key, entryValue]) => {
        const numberValue = readNumber(entryValue);
        return numberValue === null ? [] : [[key, numberValue] as const];
      })
    )
  );
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return round(numerator / denominator);
}
