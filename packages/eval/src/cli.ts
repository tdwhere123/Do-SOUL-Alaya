import path from "node:path";
import process from "node:process";
import { ZodError } from "zod";
import { diffKpis } from "./diff.js";
import { listEntries, readEntry, readPrevious, type HistoryLayout } from "./history.js";
import { renderReport } from "./report.js";
import { BenchName } from "./kpi-schema.js";

const DEFAULT_HISTORY_ROOT = path.resolve(process.cwd(), "docs/bench-history");

// invariant: @do-soul/alaya-eval is the bench-history schema + threshold diff
// engine, NOT a benchmark runner. The runnable harness lives in
// apps/bench-runner. This bin exposes only read-side verbs (diff / list) over
// an already-archived run.
const HELP_TEXT = `alaya-eval — bench-history schema + threshold diff engine

Usage:
  alaya-eval diff <bench-name> [--history-root <path>]
  alaya-eval list <bench-name> [--history-root <path>]

bench-name = self | public | live

To RUN a benchmark, use the harness in apps/bench-runner
(e.g. \`pnpm --dir apps/bench-runner exec alaya-bench-runner …\`).

Exit code 1 if a regression hits the ✗ threshold; 0 otherwise.
`;

export async function runCli(argv: ReadonlyArray<string>): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  const [command, ...rest] = argv;
  const opts = parseFlags(rest);
  const layout: HistoryLayout = {
    historyRoot: opts.historyRoot ?? DEFAULT_HISTORY_ROOT
  };

  switch (command) {
    case "diff":
      return await runDiffCommand(layout, opts);
    case "list":
      return await runListCommand(layout, opts);
    case "self":
    case "longmemeval":
      // invariant: the runnable harness lives in apps/bench-runner; these are
      // not eval-package verbs. Fail loud (no false-green return 0).
      process.stderr.write(
        `alaya-eval: '${command}' is not an alaya-eval verb. Run benchmarks ` +
          `with the harness in apps/bench-runner; alaya-eval only diffs / ` +
          `lists archived runs.\n${HELP_TEXT}`
      );
      return 2;
    default:
      process.stderr.write(`alaya-eval: unknown command '${command}'\n${HELP_TEXT}`);
      return 2;
  }
}

interface ParsedFlags {
  readonly historyRoot?: string;
  readonly positional: readonly string[];
}

function parseFlags(args: ReadonlyArray<string>): ParsedFlags {
  let historyRoot: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i] ?? "";
    if (token === "--history-root") {
      historyRoot = args[++i];
    } else {
      positional.push(token);
    }
  }
  return { historyRoot, positional };
}

async function runDiffCommand(
  layout: HistoryLayout,
  opts: ParsedFlags
): Promise<number> {
  const benchNameRaw = opts.positional[0];
  if (benchNameRaw === undefined) {
    process.stderr.write("alaya-eval diff: missing <bench-name>\n");
    return 2;
  }
  const parsed = BenchName.safeParse(benchNameRaw);
  if (!parsed.success) {
    process.stderr.write(
      `alaya-eval diff: invalid bench-name '${benchNameRaw}' (expected self|public|live)\n`
    );
    return 2;
  }
  const benchName = parsed.data;
  try {
    const slugs = await listEntries(layout, benchName);
    if (slugs.length === 0) {
      process.stdout.write(
        `alaya-eval diff: no entries yet under ${path.join(layout.historyRoot, benchName)}\n`
      );
      return 0;
    }
    const currentSlug = slugs[slugs.length - 1];
    if (currentSlug === undefined) return 0;
    const current = await readEntry(layout, benchName, currentSlug);
    if (current === null) {
      process.stderr.write(`alaya-eval diff: latest entry '${currentSlug}' unreadable\n`);
      return 2;
    }
    const previous = await readPrevious(layout, benchName, currentSlug);
    const diffResult = diffKpis(current, previous);
    process.stdout.write(renderReport(current, previous, diffResult));
    process.stdout.write("\n");
    return diffResult.worst_verdict === "fail" ? 1 : 0;
  } catch (error) {
    return reportReadError("diff", error);
  }
}

async function runListCommand(
  layout: HistoryLayout,
  opts: ParsedFlags
): Promise<number> {
  const benchNameRaw = opts.positional[0];
  if (benchNameRaw === undefined) {
    process.stderr.write("alaya-eval list: missing <bench-name>\n");
    return 2;
  }
  const parsed = BenchName.safeParse(benchNameRaw);
  if (!parsed.success) {
    process.stderr.write(
      `alaya-eval list: invalid bench-name '${benchNameRaw}' (expected self|public|live)\n`
    );
    return 2;
  }
  try {
    const slugs = await listEntries(layout, parsed.data);
    if (slugs.length === 0) {
      process.stdout.write("(no entries)\n");
      return 0;
    }
    for (const slug of slugs) {
      process.stdout.write(`${slug}\n`);
    }
    return 0;
  } catch (error) {
    return reportReadError("list", error);
  }
}

function reportReadError(command: string, error: unknown): number {
  if (error instanceof ZodError) {
    process.stderr.write(
      `alaya-eval ${command}: kpi.json failed schema validation — ${error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ")}\n`
    );
    return 2;
  }
  if (error instanceof SyntaxError) {
    process.stderr.write(
      `alaya-eval ${command}: kpi.json is not valid JSON — ${error.message}\n`
    );
    return 2;
  }
  process.stderr.write(
    `alaya-eval ${command}: unexpected error — ${error instanceof Error ? error.message : String(error)}\n`
  );
  return 2;
}
