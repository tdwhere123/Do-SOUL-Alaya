import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { entrySlug } from "@do-soul/alaya-eval";
import { RECALL_PIPELINE_VERSION, resolveBenchRunnerVersion } from "../version.js";
import {
  BENCH_SEED_ROTATION,
  rotatingSeedObjectKind,
  startBenchDaemon,
  type BenchDaemonHandle,
  type SeedObjectKind
} from "../harness/daemon.js";
import type {
  MemorySearchResult,
  SoulActiveConstraint,
  SoulMemorySearchResponse
} from "@do-soul/alaya-protocol";

const CONTROLLED_REPLAY_HISTORY_SPLIT = "controlled-replay";

const SCENARIO_LABELS = [
  "uniform-fact",
  "rotated-kind",
  "stress-policy-max10-conflict-true",
  "chat-policy-max10-conflict-false",
  "cold-report-context-usage-none",
  "warm-report-context-usage-mixed"
] as const;

type ScenarioLabel = (typeof SCENARIO_LABELS)[number];

interface FixtureSeed {
  readonly id: string;
  readonly content: string;
  readonly distilledFact?: string;
}

interface FixtureQuestion {
  readonly id: string;
  readonly question: string;
  readonly expectedSeedIds: readonly string[];
}

interface SeedSidecar {
  readonly fixtureId: string;
  readonly objectKind: SeedObjectKind;
  readonly memoryId: string;
  readonly signalId: string;
  readonly proposalId: string;
}

interface CandidateDiagnostic {
  readonly object_id: string;
  readonly pre_budget_rank: number | null;
  readonly fused_rank: number | null;
  readonly final_rank: number | null;
  readonly dropped_reason: string | null;
  readonly lexical_rank: number | null;
  readonly fused_rank_contribution_per_stream: Readonly<Record<string, number>>;
  readonly admission_planes: readonly string[];
  readonly source_channels: readonly string[];
}

interface RecallObservation {
  readonly questionId: string;
  readonly deliveryId: string;
  readonly results: readonly MemorySearchResult[];
  readonly activeConstraints: readonly SoulActiveConstraint[];
  readonly diagnostics: readonly CandidateDiagnostic[];
  readonly expectedObjectIds: readonly string[];
  readonly expectedRank: number | null;
}

interface ScenarioMetrics {
  readonly rank_distribution: Record<string, number>;
  readonly expected_rank_by_question: Record<string, number | null>;
  readonly hit_at_5: {
    readonly count: number;
    readonly rate: number;
  };
  readonly average_expected_rank: number | null;
  readonly non_monotonic: { readonly count: number };
  readonly active_constraints: { readonly count: number };
  readonly budget_drop: { readonly max_entries: number };
  readonly high_lexical_demoted: { readonly count: number };
  readonly conflict_penalty: { readonly count: number };
  readonly evidence_stream_gold_delivery: {
    readonly count: number;
    readonly denominator: number;
    readonly rate: number;
  };
  readonly path_stream_top10: {
    readonly count: number;
    readonly denominator: number;
    readonly rate: number;
  };
  readonly delivery_count: number;
  readonly diagnostics_count: number;
}

interface ScenarioArchive {
  readonly label: ScenarioLabel;
  readonly seed_object_kinds: readonly SeedObjectKind[];
  readonly recall_policy: {
    readonly max_entries: number;
    readonly conflict_awareness: boolean;
  };
  readonly report_context_usage: "none" | "mixed";
  readonly pre_report_metrics?: ScenarioMetrics;
  readonly metrics: ScenarioMetrics;
}

interface NativeHealthGate {
  readonly id:
    | "trust_loop_activation_gain"
    | "evidence_stream_gold_delivery"
    | "path_stream_top10_contribution"
    | "plasticity_gradient_rank_gain";
  readonly label: string;
  readonly current: number | null;
  readonly target: number;
  readonly direction: "min";
  readonly passed: boolean;
  readonly missing: boolean;
}

export interface ControlledReplayArchive {
  readonly schema_version: 1;
  readonly bench_name: "controlled-replay";
  readonly run_at: string;
  readonly alaya_commit: string;
  readonly alaya_version: string;
  readonly recall_pipeline_version: string;
  readonly fixture: {
    readonly seed_count: number;
    readonly question_count: number;
    readonly seed_content_hash: string;
    readonly question_hash: string;
    readonly object_kind_rotation: readonly SeedObjectKind[];
  };
  readonly scenarios: readonly ScenarioArchive[];
  readonly metrics: ScenarioMetrics & {
    readonly cold_warm_delta: Record<string, number | null>;
  };
  readonly native_health_gates: {
    readonly verdict: "ok" | "fail";
    readonly gates: readonly NativeHealthGate[];
  };
  readonly contribution_suspects: readonly {
    readonly label: string;
    readonly score: number;
    readonly evidence: Record<string, number | null>;
  }[];
  readonly evidence: {
    readonly harness_mode: "mcp_propose_review";
    readonly recall_path: "production_recall_service";
    readonly archive_policy: {
      readonly writes_latest_baseline: false;
      readonly writes_kpi_json: false;
    };
    readonly mcp_propose_review: {
      readonly seed_count: number;
      readonly signal_count: number;
      readonly proposal_count: number;
    };
    readonly production_recall: {
      readonly delivery_count: number;
      readonly diagnostics_count: number;
    };
    readonly report_context_usage: {
      readonly mode: "mixed";
      readonly delivery_ids: readonly string[];
    };
  };
}

export interface ControlledReplayRunOptions {
  readonly historyRoot: string;
  readonly runAt?: Date;
}

export interface ControlledReplayRunResult {
  readonly slug: string;
  readonly archivePath: string;
  readonly archive: ControlledReplayArchive;
}

const FIXTURE_SEEDS: readonly FixtureSeed[] = Object.freeze([
  {
    id: "alpha-owner",
    content: "Controlled replay alpha owner: Atlas indexing remains owned by packages/core for M0 fixture comparison."
  },
  {
    id: "bravo-budget",
    content: "Controlled replay bravo budget: Kappa cap pressure should preserve max entries evidence."
  },
  {
    id: "charlie-preference",
    content: "Controlled replay charlie preference: operators prefer temp history roots for fixture archives."
  },
  {
    id: "delta-decision",
    content: "Controlled replay delta decision: replay archives must avoid latest baseline mutation."
  },
  {
    id: "echo-constraint",
    content: "Controlled replay echo constraint: controlled replay must not create kpi json output."
  },
  {
    id: "foxtrot-outcome",
    content: "Controlled replay foxtrot outcome: warm usage reporting uses the recall delivery id."
  },
  {
    id: "golf-lexical",
    content: "Controlled replay golf lexical: high lexical terms should still show demotion diagnostics when ranking changes."
  },
  {
    id: "hotel-conflict",
    content: "Controlled replay hotel conflict: claim-like memories expose conflict penalty under stress policy."
  },
  {
    id: "india-chat",
    content: "Controlled replay india chat: chat policy disables conflict awareness for comparison."
  },
  {
    id: "juliet-warm",
    content: "Controlled replay juliet warm: mixed report context usage should create trust evidence before a second recall."
  },
  {
    id: "kilo-rotation",
    content: "Controlled replay kilo rotation: fact preference decision constraint outcome kinds rotate over identical content."
  },
  {
    id: "lima-suspect",
    content: "Controlled replay lima suspect: top contribution suspects compare object kind, budget, conflict, and warm deltas."
  },
  {
    id: "mike-evidence-only",
    content: "Controlled replay mike evidence-only: raw source excerpt contains the talisman phrase nebula-quartz bridge.",
    distilledFact: "Controlled replay mike evidence-only: source evidence carries the retrieval-only phrase."
  },
  {
    id: "november-path-source",
    content: "Controlled replay november path source: repeated warm usage links this seed to a separate paired answer."
  },
  {
    id: "oscar-path-target",
    content: "Controlled replay oscar paired answer: orange-ridge answer is only taught through co-usage."
  }
]);

const FIXTURE_QUESTIONS: readonly FixtureQuestion[] = Object.freeze([
  {
    id: "q-owner",
    question: "Which controlled replay alpha owner memory names Atlas indexing and packages/core?",
    expectedSeedIds: ["alpha-owner"]
  },
  {
    id: "q-archive",
    question: "Which controlled replay archive memory says not to create kpi json or latest baseline output?",
    expectedSeedIds: ["delta-decision", "echo-constraint"]
  },
  {
    id: "q-warm",
    question: "Which controlled replay warm memory mentions using a delivery id for report context usage?",
    expectedSeedIds: ["foxtrot-outcome", "juliet-warm"]
  },
  {
    id: "q-evidence-only",
    question: "Which controlled replay source evidence contains the nebula-quartz phrase?",
    expectedSeedIds: ["mike-evidence-only"]
  },
  {
    id: "q-path-target",
    question: "Which controlled replay memory should november path source lead to after repeated use?",
    expectedSeedIds: ["oscar-path-target"]
  },
  {
    id: "q-path-pair-a",
    question: "Which controlled replay november path source and orange-ridge answer belong together?",
    expectedSeedIds: ["november-path-source", "oscar-path-target"]
  },
  {
    id: "q-path-pair-b",
    question: "Which controlled replay orange-ridge answer is paired with the november path source?",
    expectedSeedIds: ["november-path-source", "oscar-path-target"]
  },
  {
    id: "q-path-pair-c",
    question: "Which controlled replay november path source repeats with the orange-ridge paired answer?",
    expectedSeedIds: ["november-path-source", "oscar-path-target"]
  }
]);

export async function runControlledReplay(
  opts: ControlledReplayRunOptions
): Promise<ControlledReplayRunResult> {
  const runAt = opts.runAt ?? new Date();
  const commitSha = resolveCommitSha7();
  const slug = entrySlug(runAt, commitSha);
  await assertArchiveSlotFree(opts.historyRoot, slug);
  const aggregateSeeds: SeedSidecar[] = [];
  const aggregateReportDeliveryIds: string[] = [];
  const scenarios: ScenarioArchive[] = [];

  for (const label of SCENARIO_LABELS) {
    const scenario = await runScenario(label, aggregateReportDeliveryIds);
    scenarios.push(scenario.archive);
    aggregateSeeds.push(...scenario.seeds);
  }

  const aggregateMetrics = aggregateScenarioMetrics(scenarios);
  const nativeHealthGates = buildNativeHealthGates(scenarios, aggregateMetrics);
  const archive: ControlledReplayArchive = {
    schema_version: 1,
    bench_name: "controlled-replay",
    run_at: runAt.toISOString(),
    alaya_commit: commitSha,
    alaya_version: resolveBenchRunnerVersion(),
    recall_pipeline_version: RECALL_PIPELINE_VERSION,
    fixture: {
      seed_count: FIXTURE_SEEDS.length,
      question_count: FIXTURE_QUESTIONS.length,
      seed_content_hash: hashJson(FIXTURE_SEEDS),
      question_hash: hashJson(FIXTURE_QUESTIONS),
      object_kind_rotation: BENCH_SEED_ROTATION
    },
    scenarios,
    metrics: {
      ...aggregateMetrics,
      cold_warm_delta: buildColdWarmDelta(scenarios)
    },
    native_health_gates: {
      verdict: nativeHealthGates.every((gate) => gate.passed) ? "ok" : "fail",
      gates: nativeHealthGates
    },
    contribution_suspects: buildContributionSuspects(scenarios),
    evidence: {
      harness_mode: "mcp_propose_review",
      recall_path: "production_recall_service",
      archive_policy: {
        writes_latest_baseline: false,
        writes_kpi_json: false
      },
      mcp_propose_review: {
        seed_count: aggregateSeeds.length,
        signal_count: new Set(aggregateSeeds.map((seed) => seed.signalId)).size,
        proposal_count: new Set(aggregateSeeds.map((seed) => seed.proposalId)).size
      },
      production_recall: {
        delivery_count: scenarios.reduce(
          (sum, scenario) => sum + scenario.metrics.delivery_count,
          0
        ),
        diagnostics_count: scenarios.reduce(
          (sum, scenario) => sum + scenario.metrics.diagnostics_count,
          0
        )
      },
      report_context_usage: {
        mode: "mixed",
        delivery_ids: aggregateReportDeliveryIds
      }
    }
  };

  const archivePath = await writeControlledReplayArchive(opts.historyRoot, slug, archive);
  return { slug, archivePath, archive };
}

async function runScenario(
  label: ScenarioLabel,
  reportDeliveryIds: string[]
): Promise<{ readonly archive: ScenarioArchive; readonly seeds: readonly SeedSidecar[] }> {
  const scenarioConfig = scenarioConfigFor(label);
  const daemon = await startBenchDaemon({
    workspaceId: `controlled-${label}`,
    runId: `controlled-run-${label}`
  });
  try {
    const seeds = await seedFixture(daemon, scenarioConfig.kindForSeed);
    const sidecar = new Map(seeds.map((seed) => [seed.memoryId, seed] as const));

    if (scenarioConfig.reportContextUsage === "mixed") {
      const preReportObservations: RecallObservation[] = [];
      for (let index = 0; index < FIXTURE_QUESTIONS.length; index++) {
        const question = FIXTURE_QUESTIONS[index];
        if (question === undefined) continue;
        const recall = await daemon.recall(question.question, {
          maxResults: scenarioConfig.maxEntries,
          conflictAwareness: scenarioConfig.conflictAwareness
        });
        preReportObservations.push(buildObservation(question, recall, sidecar));
        await reportMixedUsage(daemon, recall, question, sidecar, index + 1);
        reportDeliveryIds.push(recall.delivery_id);
      }
      await daemon.runtime.runGardenBackgroundPass();
      const observations: RecallObservation[] = [];
      for (const question of FIXTURE_QUESTIONS) {
        const recall = await daemon.recall(question.question, {
          maxResults: scenarioConfig.maxEntries,
          conflictAwareness: scenarioConfig.conflictAwareness
        });
        observations.push(buildObservation(question, recall, sidecar));
      }
      return {
        seeds,
        archive: {
          label,
          seed_object_kinds: seeds.map((seed) => seed.objectKind),
          recall_policy: {
            max_entries: scenarioConfig.maxEntries,
            conflict_awareness: scenarioConfig.conflictAwareness
          },
          report_context_usage: scenarioConfig.reportContextUsage,
          pre_report_metrics: computeMetrics(preReportObservations),
          metrics: computeMetrics(observations)
        }
      };
    }

    const observations: RecallObservation[] = [];
    for (const question of FIXTURE_QUESTIONS) {
      const recall = await daemon.recall(question.question, {
        maxResults: scenarioConfig.maxEntries,
        conflictAwareness: scenarioConfig.conflictAwareness
      });
      observations.push(buildObservation(question, recall, sidecar));
    }

    return {
      seeds,
      archive: {
        label,
        seed_object_kinds: seeds.map((seed) => seed.objectKind),
        recall_policy: {
          max_entries: scenarioConfig.maxEntries,
          conflict_awareness: scenarioConfig.conflictAwareness
        },
        report_context_usage: scenarioConfig.reportContextUsage,
        metrics: computeMetrics(observations)
      }
    };
  } finally {
    await daemon.shutdown();
  }
}

function scenarioConfigFor(label: ScenarioLabel): {
  readonly maxEntries: number;
  readonly conflictAwareness: boolean;
  readonly reportContextUsage: "none" | "mixed";
  readonly kindForSeed: (index: number) => SeedObjectKind;
} {
  const rotated = (index: number) => rotatingSeedObjectKind(index);
  switch (label) {
    case "uniform-fact":
      return {
        maxEntries: 10,
        conflictAwareness: true,
        reportContextUsage: "none",
        kindForSeed: () => "fact"
      };
    case "chat-policy-max10-conflict-false":
      return {
        maxEntries: 10,
        conflictAwareness: false,
        reportContextUsage: "none",
        kindForSeed: rotated
      };
    case "warm-report-context-usage-mixed":
      return {
        maxEntries: 10,
        conflictAwareness: true,
        reportContextUsage: "mixed",
        kindForSeed: rotated
      };
    case "rotated-kind":
    case "stress-policy-max10-conflict-true":
    case "cold-report-context-usage-none":
      return {
        maxEntries: 10,
        conflictAwareness: true,
        reportContextUsage: "none",
        kindForSeed: rotated
      };
  }
}

async function seedFixture(
  daemon: BenchDaemonHandle,
  kindForSeed: (index: number) => SeedObjectKind
): Promise<readonly SeedSidecar[]> {
  const seeds: SeedSidecar[] = [];
  for (let index = 0; index < FIXTURE_SEEDS.length; index++) {
    const fixtureSeed = FIXTURE_SEEDS[index];
    if (fixtureSeed === undefined) continue;
    const objectKind = kindForSeed(index);
    const seed = await daemon.proposeMemory(
      fixtureSeed.content,
      `controlled-replay-${fixtureSeed.id}`,
      {
        objectKind,
        ...(fixtureSeed.distilledFact === undefined
          ? {}
          : { distilledFact: fixtureSeed.distilledFact })
      }
    );
    seeds.push({
      fixtureId: fixtureSeed.id,
      objectKind,
      memoryId: seed.memoryId,
      signalId: seed.signalId,
      proposalId: seed.proposalId
    });
  }
  return seeds;
}

async function reportMixedUsage(
  daemon: BenchDaemonHandle,
  recall: SoulMemorySearchResponse,
  question: FixtureQuestion,
  sidecar: ReadonlyMap<string, SeedSidecar>,
  turnIndex: number
): Promise<void> {
  const expected = new Set(question.expectedSeedIds);
  const usedObjectIds = recall.results
    .filter((result) => {
      const seed = sidecar.get(result.object_id);
      return seed !== undefined && expected.has(seed.fixtureId);
    })
    .map((result) => result.object_id);
  const fallbackUsed = usedObjectIds.length === 0 && recall.results[0] !== undefined
    ? [recall.results[0].object_id]
    : usedObjectIds;
  await daemon.reportContextUsage({
    deliveryId: recall.delivery_id,
    usageState: fallbackUsed.length > 0 ? "used" : "skipped",
    ...(fallbackUsed.length === 0 ? {} : { usedObjectIds: fallbackUsed }),
    deliveredObjects: recall.results.slice(0, 10).map((result) => ({
      objectId: result.object_id,
      usageStatus: fallbackUsed.includes(result.object_id) ? "used" : "skipped"
    })),
    turnIndex,
    turnDigest: {
      lastMessages: [
        {
          role: "user",
          contentExcerpt: question.question
        }
      ]
    },
    reason: "controlled replay warm mixed usage fixture"
  });
}

function buildObservation(
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

function computeMetrics(observations: readonly RecallObservation[]): ScenarioMetrics {
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

function aggregateScenarioMetrics(scenarios: readonly ScenarioArchive[]): ScenarioMetrics {
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

function buildColdWarmDelta(
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

function buildNativeHealthGates(
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

function buildContributionSuspects(
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

export const controlledReplayTestHooks = Object.freeze({
  computeMetrics
});

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function resolveCommitSha7(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "0000000";
  }
}

async function assertArchiveSlotFree(historyRoot: string, slug: string): Promise<void> {
  const entryDir = join(historyRoot, CONTROLLED_REPLAY_HISTORY_SPLIT, slug);
  try {
    await access(entryDir);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return;
    throw error;
  }
  throw archiveCollisionError(slug, entryDir);
}

async function writeControlledReplayArchive(
  historyRoot: string,
  slug: string,
  archive: ControlledReplayArchive
): Promise<string> {
  const benchRoot = join(historyRoot, CONTROLLED_REPLAY_HISTORY_SPLIT);
  const entryDir = join(benchRoot, slug);
  await mkdir(benchRoot, { recursive: true });
  try {
    await mkdir(entryDir);
  } catch (error) {
    if (isNodeErrorCode(error, "EEXIST")) {
      throw archiveCollisionError(slug, entryDir);
    }
    throw error;
  }
  const archivePath = join(entryDir, "controlled-replay.json");
  try {
    await writeFile(archivePath, JSON.stringify(archive, null, 2) + "\n", {
      encoding: "utf8",
      flag: "wx"
    });
  } catch (error) {
    if (isNodeErrorCode(error, "EEXIST")) {
      throw archiveCollisionError(slug, archivePath);
    }
    throw error;
  }
  return archivePath;
}

function archiveCollisionError(slug: string, path: string): Error {
  return new Error(
    `controlled-replay archive slug '${slug}' already exists at ${path}; refusing to overwrite`
  );
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return round(numerator / denominator);
}
