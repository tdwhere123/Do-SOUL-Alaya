import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  diffKpis,
  entrySlug,
  readLatest,
  renderFindings,
  writeEntry,
  type HistoryLayout,
  type KpiPayload
} from "@do-soul/alaya-eval";
import { RECALL_PIPELINE_VERSION, resolveBenchRunnerVersion } from "../shared/version.js";
import {
  buildLiveGatesSidecar,
  DEFAULT_SOURCE_PATH,
  LIVE_GATES_FILENAME,
  parseLiveCheckSource,
  parseRunDate,
  relativeToCwd,
  renderLiveReport,
  resolveCommitSha7,
  resolveProviderMode,
  sanitizeGate
} from "./source.js";
export { resolveGitDir } from "./source.js";

export interface LiveBenchOptions {
  readonly historyRoot: string;
  readonly sourcePath?: string;
}

export interface LiveBenchResult {
  readonly slug: string;
  readonly status: "pass" | "fail";
  readonly kpiPath: string;
  readonly reportPath: string;
  readonly findingsPath: string;
  readonly liveGatesPath: string;
  readonly payload: KpiPayload;
}

type LiveCheckSource = ReturnType<typeof parseLiveCheckSource>;
type LiveProviderMode = ReturnType<typeof resolveProviderMode>;

function buildLivePayload(input: {
  readonly source: LiveCheckSource;
  readonly providerMode: LiveProviderMode;
  readonly sourcePath: string;
  readonly runAt: Date;
  readonly commitSha7: string;
}): KpiPayload {
  const { source, providerMode } = input;
  const providerMetrics = providerMode.recall_metrics;
  return {
    bench_name: "live",
    split: "strict-real",
    run_at: input.runAt.toISOString(),
    alaya_commit: input.commitSha7,
    alaya_version: resolveBenchRunnerVersion(),
    recall_pipeline_version: RECALL_PIPELINE_VERSION,
    embedding_provider: source.metrics.provider_health.embedding.ok
      ? providerMode.mode
      : "unavailable",
    chat_provider: source.metrics.provider_health.garden.ok
      ? "garden-real-provider"
      : "unavailable",
    policy_shape: "stress",
    simulate_report: "none",
    dataset: {
      name: "alaya-live-strict-real",
      size: source.metrics.samples.requested,
      source: `${relativeToCwd(input.sourcePath)}#${source.latest_run_id}`
    },
    sample_size: source.metrics.samples.requested,
    evaluated_count: providerMetrics.total_queries,
    harness_mode: "live_strict_real",
    kpi: {
      r_at_1: providerMetrics.top1_rate,
      r_at_5: providerMetrics.top5_rate,
      r_at_10: providerMetrics.top5_rate,
      latency_ms_p50: providerMetrics.p50_ms,
      latency_ms_p95: providerMetrics.p95_ms,
      latency_source: "exact",
      token_saved_ratio_vs_full_prompt: 0,
      tier_distribution: {
        hot: 0,
        warm: providerMetrics.total_queries,
        cold: 0
      },
      degradation_reasons: {
        none: Math.max(0, providerMetrics.total_queries - providerMetrics.degraded_count),
        warm_cascade_engaged: 0,
        cold_cascade_engaged: 0,
        recall_explainability_partial: providerMetrics.degraded_count
      },
      seed_truncation: {
        seed_turns_truncated: 0,
        answer_turns_truncated: 0,
        seed_chars_clipped: 0
      },
      per_scenario: []
    }
  };
}

function buildLiveFindings(
  payload: KpiPayload,
  diff: ReturnType<typeof diffKpis>,
  source: LiveCheckSource
): string | null {
  const baseFindings = renderFindings(payload, diff);
  const failedSourceGates = source.gates.filter((gate) => !gate.pass);
  const findingsParts: string[] = [];
  if (baseFindings !== null) findingsParts.push(baseFindings);
  if (source.status === "fail" || failedSourceGates.length > 0) {
    if (baseFindings === null) {
      findingsParts.push(
        [
          `# Bench Findings - ${payload.bench_name} / ${payload.split}`,
          "",
          `Run ${payload.alaya_commit} on ${payload.run_at} failed the imported live strict-real source gates.`
        ].join("\n")
      );
    }
    const liveGateFindings = [
      "## Live strict-real source gate failures",
      "",
      `- Source status: ${source.status}`
    ];
    if (failedSourceGates.length === 0) {
      liveGateFindings.push(
        "- Failed gates: none listed by source; source status is fail."
      );
    } else {
      liveGateFindings.push("- Failed gates:");
      for (const gate of failedSourceGates) {
        liveGateFindings.push(`  - ${sanitizeGate(gate).id}`);
      }
    }
    findingsParts.push(liveGateFindings.join("\n"));
  }
  return findingsParts.length === 0 ? null : `${findingsParts.join("\n\n")}\n`;
}

export async function runLiveBench(
  opts: LiveBenchOptions
): Promise<LiveBenchResult> {
  const sourcePath = opts.sourcePath ?? DEFAULT_SOURCE_PATH;
  const sourceRaw = await readFile(sourcePath, "utf8");
  const source = parseLiveCheckSource(sourceRaw, sourcePath);
  const providerMode = resolveProviderMode(source.metrics.modes);
  const keywordMode = source.metrics.modes.find((mode) => mode.mode === "keyword-local") ?? null;
  const runAt = parseRunDate(source.generated_at);
  const commitSha7 = resolveCommitSha7();
  const payload = buildLivePayload({ source, providerMode, sourcePath, runAt, commitSha7 });

  const layout: HistoryLayout = { historyRoot: opts.historyRoot };
  const previous = await readLatest(layout, "live", {
    split: "strict-real",
    embeddingProvider: payload.embedding_provider,
    pointerKind: "passing"
  });
  const diff = diffKpis(payload, previous);
  const slug = entrySlug(runAt, commitSha7);
  const report = renderLiveReport(payload, previous, diff, source, providerMode, keywordMode);
  const findings = buildLiveFindings(payload, diff, source);
  const entry = await writeEntry(layout, "live", slug, payload, report, findings, {
    sidecars: [
      {
        filename: LIVE_GATES_FILENAME,
        contents:
          JSON.stringify(buildLiveGatesSidecar(source, providerMode, keywordMode, sourcePath), null, 2) + "\n"
      }
    ]
  });
  const liveGatesPath =
    entry.sidecarPaths[LIVE_GATES_FILENAME] ?? path.join(path.dirname(entry.kpiPath), LIVE_GATES_FILENAME);
  return {
    slug,
    status: source.status,
    kpiPath: entry.kpiPath,
    reportPath: entry.reportPath,
    findingsPath: entry.findingsPath,
    liveGatesPath,
    payload
  };
}
