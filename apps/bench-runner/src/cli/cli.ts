import path from "node:path";
import process from "node:process";
import {
  releaseHardGateVerdict,
  type BenchPolicyShape,
  type BenchSimulateReportMode,
  type KpiPayload
} from "@do-soul/alaya-eval";
import { fetchLongMemEval } from "../longmemeval/fetch.js";
import { runLongMemEvalMultiturn } from "../longmemeval/multiturn.js";
import { runLongMemEvalCrossQuestion } from "../longmemeval/crossquestion.js";
import { runLiveBench } from "../live/runner.js";
import { runLongMemEval } from "../longmemeval/runner.js";
import {
  createGardenChatFn,
  resolveQaChatConfig,
  resolveQaJudgeChatConfig
} from "../longmemeval/qa-chat.js";
import { runExtractionFill } from "../longmemeval/extraction-fill.js";
import { runRecallEval } from "../longmemeval/recall-eval.js";
import {
  seedExtractionReleaseBlockerExitCode
} from "../longmemeval/seed-extraction-release-blocker.js";
import { runSelfBench } from "../self/runner.js";
import { fetchLocomo } from "../locomo/fetch.js";
import { runLocomo } from "../locomo/runner.js";
import { runControlledReplay } from "../controlled-replay/runner.js";
import { runMergeLongMemEvalCommand } from "./merge.js";
import type { BenchEmbeddingMode, BenchEmbeddingProviderKind } from "../harness/daemon.js";
import type { LongMemEvalVariant } from "../longmemeval/dataset.js";

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
          const judgeConfig = resolveQaJudgeChatConfig();
          return {
            chat: createGardenChatFn(config),
            judgeChat: createGardenChatFn(judgeConfig),
            answerModel: config.model,
            judgeModel: judgeConfig.model
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
        (kpi.full_gold_coverage === undefined
          ? ""
          : `  full-gold@5=${pct(kpi.full_gold_coverage.full_gold_at_5)} ` +
            `cov@5=${pct(kpi.full_gold_coverage.gold_coverage_at_5)} ` +
            `(official R@5 counts ANY gold; this needs ALL ${kpi.full_gold_coverage.gold_bearing_questions}q)\n`) +
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
      embeddingProviderKind: opts.embeddingProviderKind,
      ...(opts.qa
        ? {
            qa: {
              chat: createGardenChatFn(resolveQaChatConfig()),
              judgeChat: createGardenChatFn(resolveQaJudgeChatConfig())
            }
          }
        : {})
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

function pct(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
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
