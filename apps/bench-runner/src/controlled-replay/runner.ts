import { entrySlug } from "@do-soul/alaya-eval";
import { RECALL_PIPELINE_VERSION, resolveBenchRunnerVersion } from "../shared/version.js";
import {
  BENCH_SEED_ROTATION,
  startBenchDaemon,
  type SeedObjectKind
} from "../harness/daemon.js";
import {
  assertArchiveSlotFree,
  hashJson,
  resolveCommitSha7,
  writeControlledReplayArchive
} from "./archive.js";
import {
  FIXTURE_QUESTIONS,
  FIXTURE_SEEDS,
  SCENARIO_LABELS,
  createControlledReplayDataDir,
  reportMixedUsage,
  scenarioConfigFor,
  seedFixture
} from "./fixtures.js";
import {
  aggregateScenarioMetrics,
  buildColdWarmDelta,
  buildContributionSuspects,
  buildNativeHealthGates,
  buildObservation,
  computeMetrics
} from "./metrics.js";
export { controlledReplayTestHooks } from "./metrics.js";
export type {
  ControlledReplayArchive,
  ControlledReplayRunOptions,
  ControlledReplayRunResult
} from "./types.js";
import type {
  ControlledReplayArchive,
  ControlledReplayRunOptions,
  ControlledReplayRunResult,
  RecallObservation,
  ScenarioArchive,
  ScenarioLabel,
  SeedSidecar
} from "./types.js";

const WARM_USAGE_REPLAY_COUNT = 3;

export async function runControlledReplay(
  opts: ControlledReplayRunOptions
): Promise<ControlledReplayRunResult> {
  const runAt = opts.runAt ?? new Date();
  const commitSha = opts.commitSha ?? resolveCommitSha7();
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
  const dataDirRoot = await createControlledReplayDataDir(label);
  const daemonOptions = {
    dataDirRoot,
    workspaceId: `controlled-${label}`,
    runId: `controlled-run-${label}`
  } as const;
  let daemon = await startBenchDaemon(daemonOptions);
  try {
    const seeds = await seedFixture(daemon, scenarioConfig.kindForSeed);
    const sidecar = new Map(seeds.map((seed) => [seed.memoryId, seed] as const));

    if (scenarioConfig.reportContextUsage === "mixed") {
      const preReportObservations = await runWarmUsageCycles({
        daemon,
        sidecar,
        maxEntries: scenarioConfig.maxEntries,
        conflictAwareness: scenarioConfig.conflictAwareness,
        reportDeliveryIds
      });
      await daemon.shutdown();
      daemon = await startBenchDaemon({
        ...daemonOptions,
        workspaceId: `${daemonOptions.workspaceId}-restart`,
        runId: `${daemonOptions.runId}-restart`
      });
      await daemon.attachWorkspace({
        workspaceId: daemonOptions.workspaceId,
        runId: daemonOptions.runId
      });
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

async function runWarmUsageCycles(input: Readonly<{
  daemon: Awaited<ReturnType<typeof startBenchDaemon>>;
  sidecar: ReadonlyMap<string, SeedSidecar>;
  maxEntries: number;
  conflictAwareness: boolean;
  reportDeliveryIds: string[];
}>): Promise<readonly RecallObservation[]> {
  const observations: RecallObservation[] = [];
  let turnIndex = 0;
  for (const question of FIXTURE_QUESTIONS) {
    for (let replay = 0; replay < WARM_USAGE_REPLAY_COUNT; replay++) {
      const recall = await input.daemon.recall(question.question, {
        maxResults: input.maxEntries,
        conflictAwareness: input.conflictAwareness
      });
      if (replay === 0) {
        observations.push(buildObservation(question, recall, input.sidecar));
      }
      turnIndex++;
      await reportMixedUsage(input.daemon, recall, question, turnIndex);
      input.reportDeliveryIds.push(recall.delivery_id);
    }
  }
  return observations;
}
