import path from "node:path";
import process from "node:process";
import { fetchLongMemEval } from "./longmemeval/fetch.js";
import { runLongMemEval } from "./longmemeval/runner.js";
import { runSelfBench } from "./self/runner.js";
import type { LongMemEvalVariant } from "./longmemeval/dataset.js";

const DEFAULT_HISTORY_ROOT = path.resolve(process.cwd(), "docs/v0.3/bench-history");

const HELP_TEXT = `alaya-bench-runner — daemon-attached benchmark harness

Usage:
  alaya-bench-runner fetch-longmemeval [--variant oracle|s|m]
  alaya-bench-runner longmemeval [--variant oracle|s|m] [--limit N] [--history-root <path>]
  alaya-bench-runner self [--history-root <path>]
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
  readonly historyRoot: string;
  readonly dataDir?: string;
}

function parseFlags(args: ReadonlyArray<string>): ParsedFlags {
  let variantRaw: string = "oracle";
  let limit: number | undefined;
  let historyRoot: string = DEFAULT_HISTORY_ROOT;
  let dataDir: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const token = args[i] ?? "";
    if (token === "--variant") {
      variantRaw = args[++i] ?? "oracle";
    } else if (token === "--limit") {
      const raw = args[++i];
      if (raw !== undefined) {
        const parsed = parseInt(raw, 10);
        if (!Number.isNaN(parsed) && parsed > 0) limit = parsed;
      }
    } else if (token === "--history-root") {
      historyRoot = args[++i] ?? DEFAULT_HISTORY_ROOT;
    } else if (token === "--data-dir") {
      dataDir = args[++i];
    }
  }

  // Map short alias to full variant name
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

  return { variant, limit, historyRoot, dataDir };
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
      `Running LongMemEval ${opts.variant}${opts.limit !== undefined ? ` (limit=${opts.limit})` : ""}...\n`
    );
    const result = await runLongMemEval({
      variant: opts.variant,
      limit: opts.limit,
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
    const verdict = result.payload.diff_vs_previous?.verdict_per_kpi["r_at_5"] ?? "ok";
    return verdict === "fail" ? 1 : 0;
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
    const verdict = result.payload.diff_vs_previous?.verdict_per_kpi["r_at_5"] ?? "ok";
    return verdict === "fail" ? 1 : 0;
  } catch (err) {
    process.stderr.write(
      `alaya-bench-runner self: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 2;
  }
}

function pct(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}
