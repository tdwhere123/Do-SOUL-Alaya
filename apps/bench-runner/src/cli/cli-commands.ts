import process from "node:process";
import { z } from "zod";
import {
  releaseHardGateVerdict,
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
import { exitCodeForVerdicts, pct } from "./result-format.js";
import type { ParsedFlags } from "./cli-options.js";

const QaByTypeSchema = z.record(
  z.string(),
  z.object({
    correct: z.number().finite(),
    total: z.number().finite()
  })
);

export async function runFetchLongMemEval(opts: ParsedFlags): Promise<number> {
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

export async function runLongMemEvalCommand(opts: ParsedFlags): Promise<number> {
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
        (opts.concurrency !== undefined ? ` concurrency=${opts.concurrency}` : "") +
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
        : { extractionCacheRoot: opts.extractionCacheRoot }),
      ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency })
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
            `pool@50=${pct(kpi.full_gold_coverage.pool_recall_at_50)} ` +
            `pool@100=${pct(kpi.full_gold_coverage.pool_recall_at_100)} ` +
            `(official R@5 counts ANY gold; this needs ALL ${kpi.full_gold_coverage.gold_bearing_questions}q)\n`) +
        (kpi.qa_metrics === undefined
          ? ""
          : `  QA accuracy=${pct(kpi.qa_metrics.qa_accuracy)} ` +
            `(${kpi.qa_metrics.qa_correct}/${kpi.qa_metrics.qa_total})` +
            ` | abstention ${kpi.qa_metrics.qa_abstention_correct}/${kpi.qa_metrics.qa_abstention_total}\n` +
            Object.entries(parseQaByType(kpi.qa_metrics.qa_by_type))
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

function parseQaByType(value: unknown): Readonly<Record<string, { readonly correct: number; readonly total: number }>> {
  const parsed = QaByTypeSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

// --edge-plane sets the BULK_ENRICH drain gate the bench daemon reads
// (shouldRunBenchEdgePlane). Cumulative modes only — single-question recall
// never reaches the co_usage>=3 mint threshold the edge plane feeds.
function applyBenchEdgePlaneFlag(opts: ParsedFlags): void {
  if (opts.edgePlane) {
    process.env.ALAYA_BENCH_RUN_EDGE_PLANE = "true";
  }
}

export async function runLongMemEvalMultiturnCommand(opts: ParsedFlags): Promise<number> {
  try {
    applyBenchEdgePlaneFlag(opts);
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

export async function runLongMemEvalCrossQuestionCommand(opts: ParsedFlags): Promise<number> {
  try {
    applyBenchEdgePlaneFlag(opts);
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

export async function runFetchLocomoCommand(opts: ParsedFlags): Promise<number> {
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

export async function runLocomoCommand(opts: ParsedFlags): Promise<number> {
  try {
    applyBenchEdgePlaneFlag(opts);
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
      ...(qaOption === undefined ? {} : { qa: qaOption })
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

export async function runSelfCommand(opts: ParsedFlags): Promise<number> {
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

export async function runLiveCommand(opts: ParsedFlags): Promise<number> {
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

export async function runControlledReplayCommand(opts: ParsedFlags): Promise<number> {
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

function exitCodeForBenchmarkResult(payload: KpiPayload): number {
  const seedExtractionExitCode = seedExtractionReleaseBlockerExitCode(payload);
  if (seedExtractionExitCode !== 0) return seedExtractionExitCode;
  if (releaseHardGateVerdict(payload) === "fail") return 1;
  return exitCodeForVerdicts(payload.diff_vs_previous?.verdict_per_kpi);
}

/**
 * @anchor extraction-fill-command — Layer 1 (slow, one-time, daemon-free).
 * Fills the extraction cache + writes the cache manifest (incl. coverage).
 * see also: apps/bench-runner/src/longmemeval/extraction-fill.ts
 */
export async function runExtractionFillCommand(opts: ParsedFlags): Promise<number> {
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
export async function runRecallEvalCommand(opts: ParsedFlags): Promise<number> {
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
        (kpi.full_gold_coverage === undefined
          ? ""
          : `  full-gold@5=${pct(kpi.full_gold_coverage.full_gold_at_5)} ` +
            `cov@5=${pct(kpi.full_gold_coverage.gold_coverage_at_5)} ` +
            `pool@50=${pct(kpi.full_gold_coverage.pool_recall_at_50)} ` +
            `pool@100=${pct(kpi.full_gold_coverage.pool_recall_at_100)}\n`) +
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
