import { execSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  diffKpis,
  entrySlug,
  KpiPayloadSchema,
  readLatest,
  renderFindings,
  renderReport,
  writeEntry,
  type HistoryLayout,
  type KpiPayload,
  type PerScenarioRow
} from "@do-soul/alaya-eval";
import { fetchLongMemEval } from "./longmemeval/fetch.js";
import { runLongMemEval } from "./longmemeval/runner.js";
import { runSelfBench } from "./self/runner.js";
import type { LongMemEvalVariant } from "./longmemeval/dataset.js";

const DEFAULT_HISTORY_ROOT = path.resolve(process.cwd(), "docs/v0.3/bench-history");

const HELP_TEXT = `alaya-bench-runner — daemon-attached benchmark harness

Usage:
  alaya-bench-runner fetch-longmemeval [--variant oracle|s|m]
  alaya-bench-runner longmemeval [--variant oracle|s|m] [--limit N] [--offset N] [--history-root <path>]
  alaya-bench-runner self [--history-root <path>]
  alaya-bench-runner merge-longmemeval --shards <dir1> <dir2> ... --variant <v> --history-root <path>
  alaya-bench-runner --help

Variants:
  oracle  longmemeval_oracle (default)
  s       longmemeval_s
  m       longmemeval_m

Exit codes:
  0  success (verdict ok or warn)
  1  verdict = fail (regression)
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
  const opts = parseFlags(rest);

  switch (command) {
    case "fetch-longmemeval":
      return runFetchLongMemEval(opts);
    case "longmemeval":
      return runLongMemEvalCommand(opts);
    case "self":
      return runSelfCommand(opts);
    case "merge-longmemeval":
      return runMergeLongMemEvalCommand(opts);
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
}

function parseFlags(args: ReadonlyArray<string>): ParsedFlags {
  let variantRaw: string = "oracle";
  let limit: number | undefined;
  let offset: number | undefined;
  let historyRoot: string = DEFAULT_HISTORY_ROOT;
  let dataDir: string | undefined;
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
    } else if (token === "--history-root") {
      historyRoot = args[++i] ?? DEFAULT_HISTORY_ROOT;
      collectingShards = false;
    } else if (token === "--data-dir") {
      dataDir = args[++i];
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
    shards: shards.length > 0 ? shards : undefined
  };
}

async function runFetchLongMemEval(opts: ParsedFlags): Promise<number> {
  try {
    process.stdout.write(`Fetching ${opts.variant} from HuggingFace...\n`);
    const result = await fetchLongMemEval(opts.variant, {
      dataDir: opts.dataDir,
      force: false
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
    process.stdout.write(
      `Running LongMemEval ${opts.variant}` +
        (opts.offset !== undefined ? ` offset=${opts.offset}` : "") +
        (opts.limit !== undefined ? ` limit=${opts.limit}` : "") +
        "...\n"
    );
    const result = await runLongMemEval({
      variant: opts.variant,
      limit: opts.limit,
      offset: opts.offset,
      historyRoot: opts.historyRoot,
      dataDir: opts.dataDir
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
      `alaya-bench-runner longmemeval: ${err instanceof Error ? err.message : String(err)}\n`
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

function pct(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

/**
 * @anchor merge-longmemeval — combine N shard kpi.jsons into one final entry
 *
 * Each shard was produced by `longmemeval --offset X --limit Y --history-root
 * /tmp/shard-N`. Reads each shard's `latest-baseline.json` -> kpi.json,
 * concatenates per_scenario, sums tier_distribution / degradation_reasons,
 * recomputes R@K from per_scenario, picks merged latency percentiles from
 * the union of per-question latencies (approximated via min/max bracketing
 * — exact p50/p95 across shards would require carrying the raw latency
 * array through shard kpi.json, which we do not today; if you need exact
 * p50/p95 fidelity across shards, rerun sequentially or extend the schema).
 *
 * Writes the merged entry under `--history-root` and rewrites
 * `latest-baseline.json` for split `longmemeval-{s|oracle}` based on the
 * first shard's split.
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
    for (const shardRoot of shards) {
      const pointerPath = path.join(shardRoot, "public", "latest-baseline.json");
      const pointer = JSON.parse(await readFile(pointerPath, "utf8")) as {
        slug?: string;
        kpi_path?: string;
      };
      if (typeof pointer.slug !== "string") {
        throw new Error(`shard ${shardRoot} latest-baseline.json missing slug`);
      }
      const kpiPath = path.join(shardRoot, "public", pointer.slug, "kpi.json");
      const raw = await readFile(kpiPath, "utf8");
      const payload = KpiPayloadSchema.parse(JSON.parse(raw));
      shardPayloads.push(payload);
      process.stdout.write(
        `  shard ${shardRoot}: ${payload.evaluated_count} questions, ` +
          `R@5=${pct(payload.kpi.r_at_5)}\n`
      );
    }

    const first = shardPayloads[0];
    if (first === undefined) {
      throw new Error("no shards loaded");
    }

    // @anchor merge-shard-validations — refuse incompatible shards.
    // Each branch maps to an operator-misuse path that would silently
    // corrupt the bench-history archive (apples-to-oranges merge):
    //   - split / dataset identity / sample_size: same-evaluation guard
    //   - harness_mode: kpi-schema §harness_mode forbids citing
    //     mcp_propose_review numbers mixed with direct_db_seed
    //   - embedding_provider / chat_provider: recall path identity
    //   - bench_name / alaya_version: archive provenance identity
    //   - duplicate per_scenario id: overlapping --offset/--limit
    //   - evaluated_total > sample_size: shards collectively over-eval
    for (let i = 1; i < shardPayloads.length; i++) {
      const shard = shardPayloads[i];
      if (shard === undefined) continue;
      if (shard.split !== first.split) {
        throw new Error(
          `merge refused: shard[${i}] split=${shard.split} != shard[0] split=${first.split}`
        );
      }
      if (shard.sample_size !== first.sample_size) {
        throw new Error(
          `merge refused: shard[${i}] sample_size=${shard.sample_size} != shard[0] sample_size=${first.sample_size}`
        );
      }
      if (
        shard.dataset.name !== first.dataset.name ||
        shard.dataset.size !== first.dataset.size ||
        shard.dataset.source !== first.dataset.source
      ) {
        throw new Error(
          `merge refused: shard[${i}] dataset identity (${shard.dataset.name}/${shard.dataset.size}/${shard.dataset.source}) != shard[0] (${first.dataset.name}/${first.dataset.size}/${first.dataset.source})`
        );
      }
      if (shard.harness_mode !== first.harness_mode) {
        throw new Error(
          `merge refused: shard[${i}] harness_mode=${shard.harness_mode} != shard[0] harness_mode=${first.harness_mode} (mixing harness modes corrupts the audit-distinguishability contract in kpi-schema §harness_mode)`
        );
      }
      if (shard.embedding_provider !== first.embedding_provider) {
        throw new Error(
          `merge refused: shard[${i}] embedding_provider=${shard.embedding_provider} != shard[0] embedding_provider=${first.embedding_provider}`
        );
      }
      if (shard.chat_provider !== first.chat_provider) {
        throw new Error(
          `merge refused: shard[${i}] chat_provider=${shard.chat_provider} != shard[0] chat_provider=${first.chat_provider}`
        );
      }
      if (shard.bench_name !== first.bench_name) {
        throw new Error(
          `merge refused: shard[${i}] bench_name=${shard.bench_name} != shard[0] bench_name=${first.bench_name}`
        );
      }
      if (shard.alaya_version !== first.alaya_version) {
        throw new Error(
          `merge refused: shard[${i}] alaya_version=${shard.alaya_version} != shard[0] alaya_version=${first.alaya_version}`
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
    let evaluatedTotal = 0;
    let latencyP50Max = 0;
    let latencyP95Max = 0;

    for (const shard of shardPayloads) {
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
      evaluatedTotal += shard.evaluated_count;
      latencyP50Max = Math.max(latencyP50Max, shard.kpi.latency_ms_p50);
      latencyP95Max = Math.max(latencyP95Max, shard.kpi.latency_ms_p95);
    }

    if (evaluatedTotal > first.sample_size) {
      throw new Error(
        `merge refused: evaluated_total=${evaluatedTotal} > sample_size=${first.sample_size} (shards collectively over-evaluated; check --offset/--limit ranges)`
      );
    }

    const n = evaluatedTotal;
    const rAt1 = n === 0 ? 0 : totalHitAt1 / n;
    const rAt5 =
      n === 0 ? 0 : perScenario.filter((r) => r.hit_at_5).length / n;
    const rAt10 = n === 0 ? 0 : totalHitAt10 / n;

    // Latency percentiles across shards: report the worst (max) shard
    // p50 / p95 — a conservative upper bound. kpi.latency_source =
    // "worst_shard_bound" marks this for downstream readers. Exact
    // union-percentile would require shard kpi.json to carry the raw
    // latency array.
    const latencyP50 = latencyP50Max;
    const latencyP95 = latencyP95Max;

    const runAt = new Date();
    const commitSha7 = (() => {
      try {
        return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
      } catch {
        return "0000000";
      }
    })();

    const merged: KpiPayload = {
      bench_name: first.bench_name,
      split: first.split,
      run_at: runAt.toISOString(),
      alaya_commit: commitSha7,
      alaya_version: first.alaya_version,
      embedding_provider: first.embedding_provider,
      chat_provider: first.chat_provider,
      dataset: first.dataset,
      sample_size: first.sample_size,
      evaluated_count: evaluatedTotal,
      harness_mode: first.harness_mode,
      kpi: {
        r_at_1: rAt1,
        r_at_5: rAt5,
        r_at_10: rAt10,
        latency_ms_p50: latencyP50,
        latency_ms_p95: latencyP95,
        // @anchor merged-latency-source — see kpi-schema @latency-source.
        latency_source: "worst_shard_bound",
        token_saved_ratio_vs_full_prompt: 0,
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
        per_scenario: perScenario
      }
    };

    const layout: HistoryLayout = { historyRoot: opts.historyRoot };
    const previous = await readLatest(layout, "public", { split: first.split });
    const diff = diffKpis(merged, previous);
    const slug = entrySlug(runAt, commitSha7);
    const report = renderReport(merged, previous, diff);
    const findings = renderFindings(merged, diff);
    const entry = await writeEntry(
      layout,
      "public",
      slug,
      merged,
      report,
      findings
    );

    process.stdout.write(
      `Merged ${shards.length} shards → slug ${slug}\n` +
        `  evaluated=${evaluatedTotal} R@1=${pct(rAt1)} R@5=${pct(rAt5)} R@10=${pct(rAt10)}\n` +
        `  latency p50≤${latencyP50}ms p95≤${latencyP95}ms (worst-shard upper bound)\n` +
        `  KPI: ${entry.kpiPath}\n`
    );
    return 0;
  } catch (err) {
    process.stderr.write(
      `alaya-bench-runner merge-longmemeval: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 2;
  }
}
