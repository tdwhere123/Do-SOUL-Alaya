import { access, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  buildTokenEconomy,
  computeTokenSavedRatio,
  buildDiffVsPrevious,
  diffKpis,
  entrySlug,
  KpiPayloadSchema,
  benchArchiveDiscriminator,
  readLatest,
  renderFindings,
  renderReport,
  releaseHardGateVerdict,
  writeEntry,
  type BenchPolicyShape,
  type BenchSimulateReportMode,
  type HistoryLayout,
  type KpiPayload,
  type PerScenarioRow,
  type QualityMetrics
} from "@do-soul/alaya-eval";
import { fetchLongMemEval } from "./longmemeval/fetch.js";
import { runLongMemEvalMultiturn } from "./longmemeval/multiturn.js";
import { runLongMemEvalCrossQuestion } from "./longmemeval/crossquestion.js";
import {
  aggregateLongMemEvalArchiveEvidence,
  archiveEvidenceFromDiagnostics,
  buildLongMemEvalColdWarmComparisonSidecar,
  LONGMEMEVAL_COLD_WARM_COMPARISON_FILENAME,
  LONGMEMEVAL_DIAGNOSTICS_FILENAME,
  readLatestLongMemEvalOppositeArchive,
  readLongMemEvalDiagnosticsSidecar,
  type LongMemEvalArchiveEvidenceSummary,
  renderLongMemEvalColdWarmComparisonSidecar
} from "./longmemeval/archive-evidence.js";
import {
  buildPerPlaneRecallCoverage,
  renderCompactDiagnosticsSidecar,
  renderDiagnosticsSidecar,
  summarizeProviderStates,
  type LongMemEvalDiagnosticsSidecar,
  type LongMemEvalEmbeddingVectorCacheSummary,
  type LongMemEvalQueryEmbeddingCacheSummary,
  type LongMemEvalReportUsageSummary
} from "./longmemeval/diagnostics.js";
import { writeExternalDiagnosticsArtifact } from "./longmemeval/diagnostics-artifacts.js";
import { runLiveBench } from "./live/runner.js";
import { runLongMemEval } from "./longmemeval/runner.js";
import {
  createGardenChatFn,
  resolveQaChatConfig
} from "./longmemeval/qa-chat.js";
import { runExtractionFill } from "./longmemeval/extraction-fill.js";
import { runRecallEval } from "./longmemeval/recall-eval.js";
import {
  appendSeedExtractionReleaseBlockerToFindings,
  appendSeedExtractionReleaseBlockerToReport,
  seedExtractionReleaseBlockerExitCode
} from "./longmemeval/seed-extraction-release-blocker.js";
import { runSelfBench } from "./self/runner.js";
import { fetchLocomo } from "./locomo/fetch.js";
import { runLocomo } from "./locomo/runner.js";
import { runControlledReplay } from "./controlled-replay/runner.js";
import { resolveBenchCommitSha7 } from "./version.js";
import type {
  BenchEmbeddingMode,
  BenchEmbeddingProviderKind,
  BenchTokenMetrics
} from "./harness/daemon.js";
import { aggregateBenchTokenMetrics } from "./harness/token-economy.js";
import type { LongMemEvalVariant } from "./longmemeval/dataset.js";

const DEFAULT_HISTORY_ROOT = path.resolve(process.cwd(), "docs/bench-history");

const HELP_TEXT = `alaya-bench-runner — daemon-attached benchmark harness

Usage:
  alaya-bench-runner fetch-longmemeval [--variant oracle|s|m] [--data-dir <path>] [--force]
  alaya-bench-runner longmemeval [--variant oracle|s|m] [--limit N] [--offset N] [--embedding disabled|env] [--embedding-provider openai|local_onnx] [--policy-shape stress|chat] [--simulate-report none|always-used|gold-only|mixed] [--weights '<json>'] [--qa] [--data-dir <path>] [--snapshot-out <db>] [--data-dir-root <path>] [--pinned-meta-root <path>] [--history-root <path>]
    --qa  end-to-end QA accuracy (answer-LLM + LLM-judge over delivered recall). OFF by default. ON => 2 garden chat calls/question (costs money). Needs OFFICIAL_API_GARDEN_PROVIDER_URL / ALAYA_OFFICIAL_GARDEN_API_KEY / OFFICIAL_API_GARDEN_MODEL.
  alaya-bench-runner longmemeval-multiturn [--variant oracle|s|m] [--limit N] [--offset N] [--rounds N] [--embedding disabled|env] [--embedding-provider openai|local_onnx] [--data-dir <path>] [--history-root <path>]
  alaya-bench-runner longmemeval-crossquestion [--variant oracle|s|m] [--limit N] [--offset N] [--embedding disabled|env] [--embedding-provider openai|local_onnx] [--data-dir <path>] [--history-root <path>]
  alaya-bench-runner fetch-locomo [--data-dir <path>] [--force]
  alaya-bench-runner locomo [--limit N] [--offset N] [--embedding disabled|env] [--embedding-provider openai|local_onnx] [--data-dir <path>] [--history-root <path>]
  alaya-bench-runner self [--history-root <path>]
  alaya-bench-runner live [--source <main-check.json|main-check-run.json>] [--history-root <path>]
  alaya-bench-runner controlled-replay [--history-root <path>]
  alaya-bench-runner merge-longmemeval --shards <dir1> <dir2> ... --variant <v> --history-root <path>
  alaya-bench-runner extraction-fill [--variant oracle|s|m] [--limit N] [--offset N] [--concurrency N] [--data-dir <path>]
  alaya-bench-runner recall-eval --snapshot <db> [--variant oracle|s|m] [--limit N] [--offset N] [--policy-shape stress|chat] [--weights '<json>'] [--history-root <path>]
  alaya-bench-runner --help

Variants:
  oracle  longmemeval_oracle (default)
  s       longmemeval_s
  m       longmemeval_m

Exit codes:
  0  success (verdict ok or warn)
  1  verdict = fail (regression) or live strict-real status = fail
  2  argument / IO error
`;

/**
 * CLI entry point for the bench-runner binary.
 * see also: bin/alaya-bench-runner.mjs — calls runCli(process.argv.slice(2))
 * see also: longmemeval/runner.ts — runLongMemEval implementation
 * see also: self/runner.ts — runSelfBench implementation
 */
export async function runCli(argv: ReadonlyArray<string>): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  const [command, ...rest] = argv;
  let opts: ParsedFlags;
  try {
    opts = parseFlags(rest);
  } catch (err) {
    process.stderr.write(
      `alaya-bench-runner: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 2;
  }

  switch (command) {
    case "fetch-longmemeval":
      return runFetchLongMemEval(opts);
    case "longmemeval":
      return runLongMemEvalCommand(opts);
    case "longmemeval-multiturn":
      return runLongMemEvalMultiturnCommand(opts);
    case "longmemeval-crossquestion":
      return runLongMemEvalCrossQuestionCommand(opts);
    case "fetch-locomo":
      return runFetchLocomoCommand(opts);
    case "locomo":
      return runLocomoCommand(opts);
    case "self":
      return runSelfCommand(opts);
    case "live":
      return runLiveCommand(opts);
    case "controlled-replay":
      return runControlledReplayCommand(opts);
    case "merge-longmemeval":
      return runMergeLongMemEvalCommand(opts);
    case "extraction-fill":
      return runExtractionFillCommand(opts);
    case "recall-eval":
      return runRecallEvalCommand(opts);
    default:
      process.stderr.write(
        `alaya-bench-runner: unknown command '${command ?? ""}'\n${HELP_TEXT}`
      );
      return 2;
  }
}

interface ParsedFlags {
  readonly variant: LongMemEvalVariant;
  readonly limit?: number;
  readonly offset?: number;
  readonly historyRoot: string;
  readonly dataDir?: string;
  readonly shards?: ReadonlyArray<string>;
  readonly source?: string;
  readonly embeddingMode: BenchEmbeddingMode;
  readonly embeddingProviderKind: BenchEmbeddingProviderKind;
  readonly policyShape: BenchPolicyShape;
  readonly simulateReport: BenchSimulateReportMode;
  readonly weightOverridesJson?: string;
  readonly rounds?: number;
  readonly force: boolean;
  readonly snapshot?: string;
  readonly snapshotOut?: string;
  readonly dataDirRoot?: string;
  readonly pinnedMetaRoot?: string;
  readonly extractionCacheRoot?: string;
  readonly concurrency?: number;
  // --qa: gate the end-to-end QA harness (answer-LLM + LLM-judge). Default off
  // => zero LLM calls, zero cost, recall path + kpi bytes unchanged.
  readonly qa: boolean;
}

function parseFlags(args: ReadonlyArray<string>): ParsedFlags {
  let variantRaw: string = "oracle";
  let limit: number | undefined;
  let offset: number | undefined;
  let historyRoot: string = DEFAULT_HISTORY_ROOT;
  let dataDir: string | undefined;
  let source: string | undefined;
  let embeddingMode: BenchEmbeddingMode = "disabled";
  let embeddingProviderKind: BenchEmbeddingProviderKind = "openai";
  let policyShape: BenchPolicyShape = "stress";
  let simulateReport: BenchSimulateReportMode = "none";
  let weightOverridesJson: string | undefined;
  let rounds: number | undefined;
  let force = false;
  let snapshot: string | undefined;
  let snapshotOut: string | undefined;
  let dataDirRoot: string | undefined;
  let pinnedMetaRoot: string | undefined;
  let extractionCacheRoot: string | undefined;
  let concurrency: number | undefined;
  let qa = false;
  const shards: string[] = [];
  let collectingShards = false;

  for (let i = 0; i < args.length; i++) {
    const token = args[i] ?? "";
    if (token === "--variant") {
      variantRaw = args[++i] ?? "oracle";
      collectingShards = false;
    } else if (token === "--limit") {
      const raw = args[++i];
      if (raw !== undefined) {
        const parsed = parseInt(raw, 10);
        if (!Number.isNaN(parsed) && parsed > 0) limit = parsed;
      }
      collectingShards = false;
    } else if (token === "--offset") {
      const raw = args[++i];
      if (raw !== undefined) {
        const parsed = parseInt(raw, 10);
        if (!Number.isNaN(parsed) && parsed >= 0) offset = parsed;
      }
      collectingShards = false;
    } else if (token === "--rounds") {
      const raw = args[++i];
      if (raw !== undefined) {
        const parsed = parseInt(raw, 10);
        if (!Number.isNaN(parsed) && parsed > 0) rounds = parsed;
      }
      collectingShards = false;
    } else if (token === "--history-root") {
      historyRoot = args[++i] ?? DEFAULT_HISTORY_ROOT;
      collectingShards = false;
    } else if (token === "--embedding") {
      const raw = args[++i] ?? "disabled";
      if (raw !== "disabled" && raw !== "env") {
        throw new Error("--embedding must be one of: disabled, env");
      }
      embeddingMode = raw;
      collectingShards = false;
    } else if (token === "--embedding-provider" || token.startsWith("--embedding-provider=")) {
      const raw = token.startsWith("--embedding-provider=")
        ? token.slice("--embedding-provider=".length)
        : args[++i] ?? "openai";
      if (raw !== "openai" && raw !== "local_onnx") {
        throw new Error("--embedding-provider must be one of: openai, local_onnx");
      }
      embeddingProviderKind = raw;
      collectingShards = false;
    } else if (token === "--policy-shape" || token.startsWith("--policy-shape=")) {
      const raw = token.startsWith("--policy-shape=")
        ? token.slice("--policy-shape=".length)
        : args[++i] ?? "stress";
      if (raw !== "stress" && raw !== "chat") {
        throw new Error("--policy-shape must be one of: stress, chat");
      }
      policyShape = raw;
      collectingShards = false;
    } else if (token === "--simulate-report" || token.startsWith("--simulate-report=")) {
      const raw = token.startsWith("--simulate-report=")
        ? token.slice("--simulate-report=".length)
        : args[++i] ?? "none";
      if (
        raw !== "none" &&
        raw !== "always-used" &&
        raw !== "gold-only" &&
        raw !== "mixed"
      ) {
        throw new Error(
          "--simulate-report must be one of: none, always-used, gold-only, mixed"
        );
      }
      simulateReport = raw;
      collectingShards = false;
    } else if (token === "--weights" || token.startsWith("--weights=")) {
      const raw = token.startsWith("--weights=")
        ? token.slice("--weights=".length)
        : args[++i];
      if (raw === undefined) {
        throw new Error("--weights requires a JSON value");
      }
      weightOverridesJson = raw;
      collectingShards = false;
    } else if (token === "--data-dir") {
      dataDir = args[++i];
      collectingShards = false;
    } else if (token === "--snapshot-out" || token.startsWith("--snapshot-out=")) {
      snapshotOut = token.startsWith("--snapshot-out=")
        ? token.slice("--snapshot-out=".length)
        : args[++i];
      collectingShards = false;
    } else if (token === "--data-dir-root" || token.startsWith("--data-dir-root=")) {
      dataDirRoot = token.startsWith("--data-dir-root=")
        ? token.slice("--data-dir-root=".length)
        : args[++i];
      collectingShards = false;
    } else if (token === "--pinned-meta-root" || token.startsWith("--pinned-meta-root=")) {
      pinnedMetaRoot = token.startsWith("--pinned-meta-root=")
        ? token.slice("--pinned-meta-root=".length)
        : args[++i];
      collectingShards = false;
    } else if (
      token === "--extraction-cache-root" ||
      token.startsWith("--extraction-cache-root=")
    ) {
      // Override the longmemeval extraction-cache root the run-start preflight
      // validates against and the snapshot records provenance from. Operators
      // can point a run at an alternate cache; integration tests point it at an
      // isolated dir so they do not couple to the committed production manifest.
      extractionCacheRoot = token.startsWith("--extraction-cache-root=")
        ? token.slice("--extraction-cache-root=".length)
        : args[++i];
      collectingShards = false;
    } else if (token === "--snapshot" || token.startsWith("--snapshot=")) {
      snapshot = token.startsWith("--snapshot=")
        ? token.slice("--snapshot=".length)
        : args[++i];
      collectingShards = false;
    } else if (token === "--concurrency" || token.startsWith("--concurrency=")) {
      const raw = token.startsWith("--concurrency=")
        ? token.slice("--concurrency=".length)
        : args[++i];
      if (raw !== undefined) {
        const parsed = parseInt(raw, 10);
        if (!Number.isNaN(parsed) && parsed > 0) concurrency = parsed;
      }
      collectingShards = false;
    } else if (token === "--force") {
      force = true;
      collectingShards = false;
    } else if (token === "--qa" || token === "--answer-judge") {
      qa = true;
      collectingShards = false;
    } else if (token === "--source") {
      source = args[++i];
      collectingShards = false;
    } else if (token === "--shards") {
      collectingShards = true;
    } else if (collectingShards) {
      shards.push(token);
    }
  }

  const variantMap: Record<string, LongMemEvalVariant> = {
    oracle: "longmemeval_oracle",
    s: "longmemeval_s",
    m: "longmemeval_m",
    longmemeval_oracle: "longmemeval_oracle",
    longmemeval_s: "longmemeval_s",
    longmemeval_m: "longmemeval_m"
  };
  const variant: LongMemEvalVariant =
    variantMap[variantRaw] ?? "longmemeval_oracle";

  return {
    variant,
    limit,
    offset,
    historyRoot,
    dataDir,
    shards: shards.length > 0 ? shards : undefined,
    source,
    embeddingMode,
    embeddingProviderKind,
    policyShape,
    simulateReport,
    weightOverridesJson,
    rounds,
    force,
    snapshot,
    snapshotOut,
    dataDirRoot,
    pinnedMetaRoot,
    extractionCacheRoot,
    concurrency,
    qa
  };
}

async function runFetchLongMemEval(opts: ParsedFlags): Promise<number> {
  try {
    process.stdout.write(`Fetching ${opts.variant} from HuggingFace...\n`);
    const result = await fetchLongMemEval(opts.variant, {
      dataDir: opts.dataDir,
      force: opts.force
    });
    process.stdout.write(
      `Cached: ${result.localPath}\n` +
        `  sha256: ${result.sha256}\n` +
        `  questions: ${result.questionCount}\n`
    );
    return 0;
  } catch (err) {
    process.stderr.write(
      `alaya-bench-runner fetch-longmemeval: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 2;
  }
}

async function runLongMemEvalCommand(opts: ParsedFlags): Promise<number> {
  try {
    // --qa: construct the garden chat fn from env (fail-loud on missing creds).
    // Off => qaOption undefined => runner makes zero LLM calls. Each --qa
    // question costs 2 chat calls (answer + judge) — real money.
    const qaOption = opts.qa
      ? (() => {
          const config = resolveQaChatConfig();
          return {
            chat: createGardenChatFn(config),
            answerModel: config.model,
            judgeModel: config.model
          };
        })()
      : undefined;
    process.stdout.write(
      `Running LongMemEval ${opts.variant}` +
        (opts.offset !== undefined ? ` offset=${opts.offset}` : "") +
        (opts.limit !== undefined ? ` limit=${opts.limit}` : "") +
        (opts.embeddingMode !== "disabled" ? ` embedding=${opts.embeddingMode}` : "") +
        ` policy_shape=${opts.policyShape}` +
        (opts.simulateReport !== "none" ? ` simulate_report=${opts.simulateReport}` : "") +
        (opts.weightOverridesJson !== undefined ? " weights=cli" : "") +
        (qaOption !== undefined ? " qa=on" : "") +
        "...\n"
    );
    const result = await runLongMemEval({
      variant: opts.variant,
      limit: opts.limit,
      offset: opts.offset,
      historyRoot: opts.historyRoot,
      dataDir: opts.dataDir,
      embeddingMode: opts.embeddingMode,
      embeddingProviderKind: opts.embeddingProviderKind,
      policyShape: opts.policyShape,
      simulateReport: opts.simulateReport,
      weightOverridesJson: opts.weightOverridesJson,
      ...(qaOption === undefined ? {} : { qa: qaOption }),
      // @anchor longmemeval-snapshot-out-cli: producer half of the recall-eval
      // fast loop. When set, runLongMemEval pins the seeded DB and writes
      // <db> + .manifest.json + .sidecar.json, which recall-eval --snapshot
      // consumes. cross-file: longmemeval/runner.ts (snapshotOut/dataDirRoot)
      ...(opts.snapshotOut === undefined ? {} : { snapshotOut: opts.snapshotOut }),
      ...(opts.dataDirRoot === undefined ? {} : { dataDirRoot: opts.dataDirRoot }),
      ...(opts.pinnedMetaRoot === undefined
        ? {}
        : { pinnedMetaRoot: opts.pinnedMetaRoot }),
      ...(opts.extractionCacheRoot === undefined
        ? {}
        : { extractionCacheRoot: opts.extractionCacheRoot })
    });
    const kpi = result.payload.kpi;
    process.stdout.write(
      `Done. Slug: ${result.slug}\n` +
        `  Policy shape: ${result.payload.policy_shape ?? "stress"}\n` +
        `  Simulate report: ${result.payload.simulate_report ?? "none"}\n` +
        `  R@1=${pct(kpi.r_at_1)} R@5=${pct(kpi.r_at_5)} R@10=${pct(kpi.r_at_10)}\n` +
        (kpi.qa_metrics === undefined
          ? ""
          : `  QA accuracy=${pct(kpi.qa_metrics.qa_accuracy)} ` +
            `(${kpi.qa_metrics.qa_correct}/${kpi.qa_metrics.qa_total})` +
            ` | abstention ${kpi.qa_metrics.qa_abstention_correct}/${kpi.qa_metrics.qa_abstention_total}\n` +
            Object.entries(kpi.qa_metrics.qa_by_type)
              .map(
                ([type, t]) => `    ${type}: ${t.correct}/${t.total}\n`
              )
              .join("")) +
        `  latency p50=${kpi.latency_ms_p50}ms p95=${kpi.latency_ms_p95}ms\n` +
        `  KPI: ${result.kpiPath}\n`
    );
    return exitCodeForBenchmarkResult(result.payload);
  } catch (err) {
    process.stderr.write(
      `alaya-bench-runner longmemeval: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 2;
  }
}

async function runLongMemEvalMultiturnCommand(opts: ParsedFlags): Promise<number> {
  try {
    process.stdout.write(
      `Running LongMemEval multi-turn ${opts.variant}` +
        (opts.offset !== undefined ? ` offset=${opts.offset}` : "") +
        (opts.limit !== undefined ? ` limit=${opts.limit}` : "") +
        ` rounds=${opts.rounds ?? 3}` +
        (opts.embeddingMode !== "disabled" ? ` embedding=${opts.embeddingMode}` : "") +
        "...\n"
    );
    const result = await runLongMemEvalMultiturn({
      variant: opts.variant,
      limit: opts.limit,
      offset: opts.offset,
      rounds: opts.rounds,
      historyRoot: opts.historyRoot,
      dataDir: opts.dataDir,
      embeddingMode: opts.embeddingMode
    });
    const kpi = result.payload.kpi;
    process.stdout.write(
      `Done. Slug: ${result.slug}\n` +
        `  R@1=${pct(kpi.r_at_1)} R@5=${pct(kpi.r_at_5)} R@10=${pct(kpi.r_at_10)}\n` +
        `  round1=${pct(kpi.r_at_5_round_1 ?? kpi.r_at_5)} roundN=${pct(kpi.r_at_5_round_n ?? kpi.r_at_5)}\n` +
        `  latency p50=${kpi.latency_ms_p50}ms p95=${kpi.latency_ms_p95}ms\n` +
        `  KPI: ${result.kpiPath}\n`
    );
    return exitCodeForBenchmarkResult(result.payload);
  } catch (err) {
    process.stderr.write(
      `alaya-bench-runner longmemeval-multiturn: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 2;
  }
}

async function runLongMemEvalCrossQuestionCommand(opts: ParsedFlags): Promise<number> {
  try {
    process.stdout.write(
      `Running LongMemEval cross-question ${opts.variant}` +
        (opts.offset !== undefined ? ` offset=${opts.offset}` : "") +
        (opts.limit !== undefined ? ` limit=${opts.limit}` : "") +
        (opts.embeddingMode !== "disabled" ? ` embedding=${opts.embeddingMode}` : "") +
        "...\n"
    );
    const result = await runLongMemEvalCrossQuestion({
      variant: opts.variant,
      limit: opts.limit,
      offset: opts.offset,
      historyRoot: opts.historyRoot,
      dataDir: opts.dataDir,
      embeddingMode: opts.embeddingMode
    });
    const kpi = result.payload.kpi;
    process.stdout.write(
      `Done. Slug: ${result.slug}\n` +
        `  R@1=${pct(kpi.r_at_1)} R@5=${pct(kpi.r_at_5)} R@10=${pct(kpi.r_at_10)}\n` +
        `  first_half=${pct(kpi.r_at_5_first_half ?? kpi.r_at_5)} last_half=${pct(kpi.r_at_5_last_half ?? kpi.r_at_5)}\n` +
        `  latency p50=${kpi.latency_ms_p50}ms p95=${kpi.latency_ms_p95}ms\n` +
        `  KPI: ${result.kpiPath}\n`
    );
    return exitCodeForBenchmarkResult(result.payload);
  } catch (err) {
    process.stderr.write(
      `alaya-bench-runner longmemeval-crossquestion: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 2;
  }
}

async function runFetchLocomoCommand(opts: ParsedFlags): Promise<number> {
  try {
    process.stdout.write("Fetching locomo10 from snap-research/locomo...\n");
    const result = await fetchLocomo("locomo10", {
      dataDir: opts.dataDir,
      force: opts.force
    });
    process.stdout.write(
      `Cached: ${result.localPath}\n` +
        `  sha256: ${result.sha256}\n` +
        `  conversations: ${result.conversationCount}\n`
    );
    return 0;
  } catch (err) {
    process.stderr.write(
      `alaya-bench-runner fetch-locomo: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 2;
  }
}

async function runLocomoCommand(opts: ParsedFlags): Promise<number> {
  try {
    process.stdout.write(
      `Running LoCoMo10` +
        (opts.offset !== undefined ? ` offset=${opts.offset}` : "") +
        (opts.limit !== undefined ? ` limit=${opts.limit}` : "") +
        (opts.embeddingMode !== "disabled" ? ` embedding=${opts.embeddingMode}` : "") +
        "...\n"
    );
    const result = await runLocomo({
      variant: "locomo10",
      limit: opts.limit,
      offset: opts.offset,
      historyRoot: opts.historyRoot,
      dataDir: opts.dataDir,
      embeddingMode: opts.embeddingMode,
      embeddingProviderKind: opts.embeddingProviderKind
    });
    const kpi = result.payload.kpi;
    process.stdout.write(
      `Done. Slug: ${result.slug}\n` +
        `  R@1=${pct(kpi.r_at_1)} R@5=${pct(kpi.r_at_5)} R@10=${pct(kpi.r_at_10)}\n` +
        `  latency p50=${kpi.latency_ms_p50}ms p95=${kpi.latency_ms_p95}ms\n` +
        `  KPI: ${result.kpiPath}\n`
    );
    return exitCodeForBenchmarkResult(result.payload);
  } catch (err) {
    process.stderr.write(
      `alaya-bench-runner locomo: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 2;
  }
}

async function runSelfCommand(opts: ParsedFlags): Promise<number> {
  try {
    process.stdout.write("Running self-bench (8 synthetic scenarios)...\n");
    const result = await runSelfBench({ historyRoot: opts.historyRoot });
    const kpi = result.payload.kpi;
    process.stdout.write(
      `Done. Slug: ${result.slug}\n` +
        `  R@1=${pct(kpi.r_at_1)} R@5=${pct(kpi.r_at_5)} R@10=${pct(kpi.r_at_10)}\n` +
        `  latency p50=${kpi.latency_ms_p50}ms p95=${kpi.latency_ms_p95}ms\n` +
        `  KPI: ${result.kpiPath}\n`
    );
    return exitCodeForVerdicts(result.payload.diff_vs_previous?.verdict_per_kpi);
  } catch (err) {
    process.stderr.write(
      `alaya-bench-runner self: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 2;
  }
}

async function runLiveCommand(opts: ParsedFlags): Promise<number> {
  try {
    process.stdout.write("Archiving live strict-real check into bench-history...\n");
    const result = await runLiveBench({
      historyRoot: opts.historyRoot,
      sourcePath: opts.source
    });
    const kpi = result.payload.kpi;
    process.stdout.write(
      `Done. Slug: ${result.slug}\n` +
        `  R@1=${pct(kpi.r_at_1)} R@5=${pct(kpi.r_at_5)} R@10=${pct(kpi.r_at_10)}\n` +
        `  latency p50=${kpi.latency_ms_p50}ms p95=${kpi.latency_ms_p95}ms\n` +
        `  KPI: ${result.kpiPath}\n` +
        `  Live gates: ${result.liveGatesPath}\n`
    );
    if (result.status === "fail") return 1;
    return exitCodeForVerdicts(result.payload.diff_vs_previous?.verdict_per_kpi);
  } catch (err) {
    process.stderr.write(
      `alaya-bench-runner live: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 2;
  }
}

async function runControlledReplayCommand(opts: ParsedFlags): Promise<number> {
  try {
    process.stdout.write("Running controlled replay...\n");
    const result = await runControlledReplay({ historyRoot: opts.historyRoot });
    const failedGateIds = result.archive.native_health_gates.gates
      .filter((gate) => !gate.passed)
      .map((gate) => gate.id);
    process.stdout.write(
      `Controlled replay complete. Slug: ${result.slug}\n` +
        `  Native health: ${result.archive.native_health_gates.verdict}\n` +
        `  Archive: ${result.archivePath}\n`
    );
    if (failedGateIds.length > 0) {
      process.stderr.write(
        `controlled-replay native health gates failed: ${failedGateIds.join(", ")}\n`
      );
      return 1;
    }
    return 0;
  } catch (err) {
    process.stderr.write(
      `alaya-bench-runner controlled-replay: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 2;
  }
}

/**
 * Pick the worst verdict across all gated KPIs. A previous version of this
 * mapping only inspected verdict_per_kpi["r_at_5"], which masked latency /
 * tier / token-budget failures. Worst-across-all keeps the exit-code contract
 * consistent with the report.md `Worst verdict: …` line and with
 * diff.worst_verdict in @do-soul/alaya-eval.
 *
 * fail → exit 1; warn → exit 0 (advisory); ok / missing → exit 0.
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
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`);
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
  const questions = shardDiagnostics.flatMap((diagnostics) => diagnostics?.questions ?? []);
  const questionCount = shardDiagnostics.reduce(
    (sum, diagnostics) => sum + diagnosticQuestionCount(diagnostics),
    0
  );
  const reportSideEffectSnapshotCount = aggregateReportSideEffectSnapshotCount(
    shardDiagnostics
  );
  const embeddingMode =
    shardDiagnostics.find((diagnostics): diagnostics is LongMemEvalDiagnosticsSidecar => diagnostics !== null)?.embedding_mode ??
    (payload.embedding_provider === "none" ? "disabled" : "env");
  const reportUsage = aggregateReportUsage(
    shardDiagnostics
      .map((diagnostics) => diagnostics?.report_usage)
      .filter((usage): usage is LongMemEvalReportUsageSummary => usage !== undefined)
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
    ...(evidence.report_side_effects === null ? {} : { report_side_effects: evidence.report_side_effects }),
    ...(evidence.scored_recall_evidence === null ? {} : { scored_recall_evidence: evidence.scored_recall_evidence }),
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
  const compactQuestionCount = (diagnostics as { readonly question_count?: unknown })
    .question_count;
  return requiredCompactNonNegativeInteger(compactQuestionCount, "question_count");
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

function requiredCompactNonNegativeInteger(value: unknown, fieldName: string): number {
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
    reports_attempted: usages.reduce((sum, usage) => sum + usage.reports_attempted, 0),
    reports_used: usages.reduce((sum, usage) => sum + usage.reports_used, 0),
    reports_skipped: usages.reduce((sum, usage) => sum + usage.reports_skipped, 0),
    used_object_count: usages.reduce((sum, usage) => sum + usage.used_object_count, 0)
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
  const lastError = [...summaries].reverse().find((summary) => summary.last_error !== undefined)?.last_error;
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
 *
 * Each shard was produced by `longmemeval --offset X --limit Y --history-root
 * /tmp/shard-N`. Reads each shard's latest-passing/latest-run/legacy-baseline
 * pointer -> kpi.json,
 * concatenates per_scenario, sums tier_distribution / degradation_reasons,
 * recomputes R@K from per_scenario, and uses exact merged latency
 * percentiles when shard rows carry per-question latency. Legacy shards
 * without row latency fall back to a conservative worst-shard bound.
 *
 * Writes the merged entry under `--history-root` and rewrites the latest-run
 * and latest-passing pointer set based on the first shard's split. Legacy
 * latest-baseline aliases are still emitted by `writeEntry` for old tools.
 */
async function runMergeLongMemEvalCommand(
  opts: ParsedFlags
): Promise<number> {
  try {
    const shards = opts.shards ?? [];
    if (shards.length === 0) {
      process.stderr.write(
        `alaya-bench-runner merge-longmemeval: --shards <dir1> <dir2> ... required\n`
      );
      return 2;
    }

    process.stdout.write(`Merging ${shards.length} shard(s)...\n`);

    const shardPayloads: KpiPayload[] = [];
    const shardArchiveRefs: Array<{ readonly root: string; readonly slug: string }> = [];
    for (const shardRoot of shards) {
      const pointerPath = await resolveShardPointerPath(shardRoot);
      const pointer = JSON.parse(await readFile(pointerPath, "utf8")) as {
        slug?: string;
        kpi_path?: string;
      };
      if (typeof pointer.slug !== "string") {
        throw new Error(`shard ${shardRoot} ${path.basename(pointerPath)} missing slug`);
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

    // @anchor merge-shard-validations: refuse incompatible shards.
    // Scalar identity branches expressed as a table; dataset composite
    // and duplicate-id / over-eval guards remain inline below because
    // they don't reduce to a single-field equality.
    // see also: packages/eval/src/kpi-schema.ts §harness_mode for the
    // mcp_propose_review vs direct_db_seed audit-distinguishability
    // contract.
    // @anchor scalar-identity-field-narrowing: the union literal
    // shape (vs `keyof KpiPayload`) makes adding a non-scalar key like
    // `dataset` or `kpi` a compile error rather than a silent
    // object-reference comparison.
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
      if (JSON.stringify(shard.seed_policy ?? null) !== JSON.stringify(first.seed_policy ?? null)) {
        throw new Error(`merge refused: shard[${i}] seed_policy differs from shard[0]`);
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

    // Sum counters across shards. R@K is recomputed from concatenated
    // per_scenario rather than weighted-averaged from shard R@K, so the
    // final number is exact even if shards had unequal sizes.
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
    // Event-sourced token-economy blocks, one per shard that carries one.
    // A merge is honest only when EVERY shard reported token_economy; a
    // partial set would silently undercount, so the merged block is
    // emitted only when all shards have it.
    const shardTokenEconomies: BenchTokenMetrics[] = [];

    for (const shard of shardPayloads) {
      if (shard.kpi.token_economy !== undefined) {
        shardTokenEconomies.push(shard.kpi.token_economy);
      }
      for (const row of shard.kpi.per_scenario) {
        perScenario.push(row);
      }
      // per_scenario only records hit_at_5; R@1 / R@10 are encoded only
      // in the shard-level scalars. Approximate the total by multiplying
      // by the shard size; assumes per-question contributions to R@1 /
      // R@10 are 0 or 1 (which they are).
      totalHitAt1 += Math.round(
        shard.kpi.r_at_1 * shard.evaluated_count
      );
      totalHitAt10 += Math.round(
        shard.kpi.r_at_10 * shard.evaluated_count
      );
      tierHot += shard.kpi.tier_distribution.hot;
      tierWarm += shard.kpi.tier_distribution.warm;
      tierCold += shard.kpi.tier_distribution.cold;
      degradeNone += shard.kpi.degradation_reasons.none;
      degradeWarm += shard.kpi.degradation_reasons.warm_cascade_engaged;
      degradeCold += shard.kpi.degradation_reasons.cold_cascade_engaged;
      degradePartial += shard.kpi.degradation_reasons.recall_explainability_partial;
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

    // Merge the event-sourced token economy across shards. Honest only
    // when every shard carried a token_economy block; otherwise the
    // merged block is dropped and the headline ratio falls back to 0.
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
      ...(first.seed_policy === undefined ? {} : { seed_policy: first.seed_policy }),
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
        // @anchor merged-latency-source: see kpi-schema @latency-source.
        latency_source: hasExactMergedLatency ? "exact" : "worst_shard_bound",
        token_saved_ratio_vs_full_prompt: mergedTokenSavedRatio,
        ...(mergedTokenEconomy === undefined
          ? {}
          : { token_economy: mergedTokenEconomy }),
        // @anchor merged-recall-token-economy: per-recall structural
        // distributions live in each shard's KPI. The honest cross-shard
        // distribution would require the raw per-recall samples (not just
        // the shard summaries); since we do not persist samples, the merged
        // KPI deliberately omits the block. Per-shard archives still carry
        // their own recall_token_economy untouched.
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
    const entry = await writeEntry(
      layout,
      "public",
      slug,
      merged,
      report,
      findings,
      {
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
      }
    );

    process.stdout.write(
      `Merged ${shards.length} shards → slug ${slug}\n` +
        `  evaluated=${evaluatedTotal} R@1=${pct(rAt1)} R@5=${pct(rAt5)} R@10=${pct(rAt10)}\n` +
        (hasExactMergedLatency
          ? `  latency p50=${latencyP50}ms p95=${latencyP95}ms\n`
          : `  latency p50≤${latencyP50}ms p95≤${latencyP95}ms (worst-shard upper bound)\n`) +
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

/**
 * @anchor extraction-fill-command — Layer 1 (slow, one-time, daemon-free).
 * Fills the extraction cache + writes the cache manifest (incl. coverage).
 * see also: apps/bench-runner/src/longmemeval/extraction-fill.ts
 */
async function runExtractionFillCommand(opts: ParsedFlags): Promise<number> {
  try {
    process.stdout.write(
      `Filling extraction cache for ${opts.variant}` +
        (opts.offset !== undefined ? ` offset=${opts.offset}` : "") +
        (opts.limit !== undefined ? ` limit=${opts.limit}` : "") +
        (opts.concurrency !== undefined ? ` concurrency=${opts.concurrency}` : "") +
        "...\n"
    );
    const result = await runExtractionFill({
      variant: opts.variant,
      ...(opts.limit === undefined ? {} : { limit: opts.limit }),
      ...(opts.offset === undefined ? {} : { offset: opts.offset }),
      ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency }),
      ...(opts.dataDir === undefined ? {} : { dataDir: opts.dataDir })
    });
    process.stdout.write(
      `Done. requested_turns=${result.requestedTurns} ` +
        `cache_hits=${result.cacheHits} newly_extracted=${result.newlyExtracted} ` +
        `failures=${result.failures} coverage=${pct(result.coverage)}\n`
    );
    return result.failures > 0 ? 1 : 0;
  } catch (err) {
    process.stderr.write(
      `alaya-bench-runner extraction-fill: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 2;
  }
}

/**
 * @anchor recall-eval-command — Layers 2+3 (fast, every iteration). Recall-only
 * against a seeded-DB snapshot; no LLM, no materialization.
 * see also: apps/bench-runner/src/longmemeval/recall-eval.ts
 */
async function runRecallEvalCommand(opts: ParsedFlags): Promise<number> {
  if (opts.snapshot === undefined) {
    process.stderr.write(
      "alaya-bench-runner recall-eval: --snapshot <db> required\n"
    );
    return 2;
  }
  try {
    process.stdout.write(
      `Running recall-eval against snapshot ${opts.snapshot}` +
        (opts.offset !== undefined ? ` offset=${opts.offset}` : "") +
        (opts.limit !== undefined ? ` limit=${opts.limit}` : "") +
        ` policy_shape=${opts.policyShape}` +
        (opts.weightOverridesJson !== undefined ? " weights=cli" : "") +
        "...\n"
    );
    const result = await runRecallEval({
      snapshotDbPath: opts.snapshot,
      variant: opts.variant,
      ...(opts.limit === undefined ? {} : { limit: opts.limit }),
      ...(opts.offset === undefined ? {} : { offset: opts.offset }),
      historyRoot: opts.historyRoot,
      policyShape: opts.policyShape,
      simulateReport: opts.simulateReport,
      ...(opts.weightOverridesJson === undefined
        ? {}
        : { weightOverridesJson: opts.weightOverridesJson })
    });
    const kpi = result.payload.kpi;
    process.stdout.write(
      `Done. Slug: ${result.slug}\n` +
        `  R@1=${pct(kpi.r_at_1)} R@5=${pct(kpi.r_at_5)} R@10=${pct(kpi.r_at_10)}\n` +
        `  latency p50=${kpi.latency_ms_p50}ms p95=${kpi.latency_ms_p95}ms\n` +
        `  KPI: ${result.kpiPath}\n`
    );
    return exitCodeForVerdicts(result.payload.diff_vs_previous?.verdict_per_kpi);
  } catch (err) {
    process.stderr.write(
      `alaya-bench-runner recall-eval: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 2;
  }
}

function mergeQualityMetrics(
  shards: readonly KpiPayload[]
): QualityMetrics | undefined {
  if (shards.length === 0) return undefined;
  const metrics = shards.map((shard) => shard.kpi.quality_metrics);
  if (metrics.every((item) => item === undefined)) return undefined;
  if (metrics.some((item) => item === undefined)) return undefined;

  let nonMonotonicCount = 0;
  let nonMonotonicDenominator = 0;
  let highLexicalDemotedCount = 0;
  let highLexicalDemotedDenominator = 0;
  let candidateAbsentCount = 0;
  let candidateAbsentDenominator = 0;
  let noGoldCount = 0;
  let noGoldDenominator = 0;
  let evidenceStreamGoldDeliveryCount = 0;
  let evidenceStreamGoldDeliveryDenominator = 0;
  let pathStreamTop10Count = 0;
  let pathStreamTop10Denominator = 0;
  const budgetCounts = new Map<string, { count: number; denominator: number }>();
  const missDistribution: Record<string, number> = {};
  const planeGoldCounts = new Map<string, number>();
  const planeHitAt5Counts = new Map<string, number>();
  // Cohort fan-in attribution (codex I2): additive across shards; rate is
  // recomputed from the merged counts. Present only when a shard carried it.
  let anyCohortAttribution = false;
  let cohortDeliveredPlaneCount = 0;
  let cohortGoldSourcePlaneCount = 0;
  let cohortGoldFirstAdmittedCount = 0;
  let cohortGoldWinningAdmissionCount = 0;
  let cohortGoldHitAt5Count = 0;
  // Path-vs-graph fan-in diagnostic: additive across shards; rates
  // recomputed from the merged counts. Present only when a shard carried it.
  let anyPathVsGraphFanin = false;
  let pathFaninGoldSourceCount = 0;
  let pathFaninGoldHitAt5Count = 0;
  let graphFaninGoldSourceCount = 0;
  let graphFaninGoldHitAt5Count = 0;
  let pathPrimaryGoldHitAt5Count = 0;
  let graphOnlyGoldHitAt5Count = 0;

  for (const metric of metrics) {
    if (metric === undefined) continue;
    for (const [plane, entry] of Object.entries(
      metric.per_plane_recall_coverage
    )) {
      planeGoldCounts.set(
        plane,
        (planeGoldCounts.get(plane) ?? 0) + entry.gold_count
      );
      planeHitAt5Counts.set(
        plane,
        (planeHitAt5Counts.get(plane) ?? 0) + entry.hit_at_5_count
      );
    }
    nonMonotonicCount += metric.non_monotonic_count;
    nonMonotonicDenominator += metric.non_monotonic_denominator;
    highLexicalDemotedCount += metric.high_lexical_demoted_count;
    highLexicalDemotedDenominator += metric.high_lexical_demoted_denominator;
    candidateAbsentCount += metric.candidate_absent_count;
    candidateAbsentDenominator += metric.candidate_absent_denominator;
    noGoldCount += metric.no_gold_count;
    noGoldDenominator += metric.no_gold_denominator;
    evidenceStreamGoldDeliveryCount += metric.evidence_stream_gold_delivery_count;
    evidenceStreamGoldDeliveryDenominator += metric.evidence_stream_gold_delivery_denominator;
    pathStreamTop10Count += metric.path_stream_top10_count;
    pathStreamTop10Denominator += metric.path_stream_top10_denominator;
    for (const [key, entry] of Object.entries(metric.budget_drop_distribution)) {
      const existing = budgetCounts.get(key) ?? { count: 0, denominator: 0 };
      budgetCounts.set(key, {
        count: existing.count + entry.count,
        denominator: existing.denominator + entry.denominator
      });
    }
    for (const [key, count] of Object.entries(metric.miss_distribution)) {
      missDistribution[key] = (missDistribution[key] ?? 0) + count;
    }
    if (metric.cohort_attribution !== undefined) {
      anyCohortAttribution = true;
      cohortDeliveredPlaneCount += metric.cohort_attribution.delivered_plane_count;
      cohortGoldSourcePlaneCount += metric.cohort_attribution.gold_source_plane_count;
      cohortGoldFirstAdmittedCount += metric.cohort_attribution.gold_first_admitted_count;
      cohortGoldWinningAdmissionCount += metric.cohort_attribution.gold_winning_admission_count;
      cohortGoldHitAt5Count += metric.cohort_attribution.hit_at_5_count;
    }
    if (metric.path_vs_graph_fanin !== undefined) {
      anyPathVsGraphFanin = true;
      pathFaninGoldSourceCount += metric.path_vs_graph_fanin.path_gold_source_count;
      pathFaninGoldHitAt5Count += metric.path_vs_graph_fanin.path_gold_hit_at_5_count;
      graphFaninGoldSourceCount += metric.path_vs_graph_fanin.graph_gold_source_count;
      graphFaninGoldHitAt5Count += metric.path_vs_graph_fanin.graph_gold_hit_at_5_count;
      pathPrimaryGoldHitAt5Count += metric.path_vs_graph_fanin.path_primary_hit_at_5_count;
      graphOnlyGoldHitAt5Count += metric.path_vs_graph_fanin.graph_only_hit_at_5_count;
    }
  }

  const budgetDropDistribution = Object.fromEntries(
    [...budgetCounts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, entry]) => [
        key,
        {
          count: entry.count,
          share: ratio(entry.count, entry.denominator),
          denominator: entry.denominator
        }
      ])
  );

  return {
    schema_version: "bench-quality-metrics.v1",
    non_monotonic_rate: ratio(nonMonotonicCount, nonMonotonicDenominator),
    non_monotonic_count: nonMonotonicCount,
    non_monotonic_denominator: nonMonotonicDenominator,
    budget_drop_distribution: budgetDropDistribution,
    high_lexical_demoted_rate: ratio(
      highLexicalDemotedCount,
      highLexicalDemotedDenominator
    ),
    high_lexical_demoted_count: highLexicalDemotedCount,
    high_lexical_demoted_denominator: highLexicalDemotedDenominator,
    candidate_absent_count: candidateAbsentCount,
    candidate_absent_denominator: candidateAbsentDenominator,
    no_gold_count: noGoldCount,
    no_gold_denominator: noGoldDenominator,
    evidence_stream_gold_delivery_rate: ratio(
      evidenceStreamGoldDeliveryCount,
      evidenceStreamGoldDeliveryDenominator
    ),
    evidence_stream_gold_delivery_count: evidenceStreamGoldDeliveryCount,
    evidence_stream_gold_delivery_denominator: evidenceStreamGoldDeliveryDenominator,
    path_stream_top10_rate: ratio(pathStreamTop10Count, pathStreamTop10Denominator),
    path_stream_top10_count: pathStreamTop10Count,
    path_stream_top10_denominator: pathStreamTop10Denominator,
    per_plane_recall_coverage: buildPerPlaneRecallCoverage(
      planeGoldCounts,
      planeHitAt5Counts
    ),
    ...(anyCohortAttribution
      ? {
          cohort_attribution: {
            delivered_plane_count: cohortDeliveredPlaneCount,
            gold_source_plane_count: cohortGoldSourcePlaneCount,
            gold_first_admitted_count: cohortGoldFirstAdmittedCount,
            gold_winning_admission_count: cohortGoldWinningAdmissionCount,
            hit_at_5_count: cohortGoldHitAt5Count,
            hit_at_5_rate: ratio(cohortGoldHitAt5Count, cohortGoldSourcePlaneCount)
          }
        }
      : {}),
    ...(anyPathVsGraphFanin
      ? {
          path_vs_graph_fanin: {
            path_gold_source_count: pathFaninGoldSourceCount,
            path_gold_hit_at_5_count: pathFaninGoldHitAt5Count,
            path_gold_hit_at_5_rate: ratio(pathFaninGoldHitAt5Count, pathFaninGoldSourceCount),
            graph_gold_source_count: graphFaninGoldSourceCount,
            graph_gold_hit_at_5_count: graphFaninGoldHitAt5Count,
            graph_gold_hit_at_5_rate: ratio(graphFaninGoldHitAt5Count, graphFaninGoldSourceCount),
            path_primary_hit_at_5_count: pathPrimaryGoldHitAt5Count,
            graph_only_hit_at_5_count: graphOnlyGoldHitAt5Count
          }
        }
      : {}),
    miss_distribution: missDistribution
  };
}
