import process from "node:process";
import { runMergeLongMemEvalCommand } from "./merge.js";
import { parseFlags, type ParsedFlags } from "./cli-options.js";
import { runAuthorizeLongMemEvalMatrixCommand } from "./promotion/command.js";
import { runAuthorizeExtractionCommand } from "./extraction-authority/command.js";
import { runC0ReuseDecisionCommand } from "./c0/command.js";
import {
  runControlledReplayCommand,
  runExtractionFillCommand,
  runFetchLocomoCommand,
  runFetchLongMemEval,
  runLiveCommand,
  runLocomoCommand,
  runLongMemEvalCommand,
  runLongMemEvalCrossQuestionCommand,
  runLongMemEvalMultiturnCommand,
  runRecallEvalCommand,
  runSelfCommand
} from "./cli-commands.js";

const HELP_TEXT = `alaya-bench-runner — daemon-attached benchmark harness

Usage:
  alaya-bench-runner fetch-longmemeval [--variant oracle|s|m] [--data-dir <path>] [--force]
  alaya-bench-runner longmemeval [--variant oracle|s|m] [--limit N] [--offset N] [--concurrency N] [--embedding disabled|env] [--embedding-provider openai|local_onnx] [--policy-shape stress|chat] [--simulate-report none|always-used|gold-only|mixed] [--weights '<json>'] [--qa] [--data-dir <path>] [--snapshot-out <db>] [--data-dir-root <path>] [--pinned-meta-root <path>] [--history-root <path>] [--promotion-contract <json>]
    --qa  end-to-end QA accuracy (answer-LLM + LLM-judge over delivered recall). OFF by default. ON => 2 garden chat calls/question (costs money). Needs OFFICIAL_API_GARDEN_PROVIDER_URL / ALAYA_OFFICIAL_GARDEN_API_KEY / OFFICIAL_API_GARDEN_MODEL.
  alaya-bench-runner longmemeval-multiturn [--variant oracle|s|m] [--limit N] [--offset N] [--rounds N] [--embedding disabled|env] [--embedding-provider openai|local_onnx] [--edge-plane] [--data-dir <path>] [--history-root <path>]
  alaya-bench-runner longmemeval-crossquestion [--variant oracle|s|m] [--limit N] [--offset N] [--embedding disabled|env] [--embedding-provider openai|local_onnx] [--edge-plane] [--data-dir <path>] [--history-root <path>]
    --edge-plane  drain the BULK_ENRICH edge pass before recall (cumulative modes only). OFF by default to keep embedding ON/OFF corpora comparable.
  alaya-bench-runner fetch-locomo [--data-dir <path>] [--force]
  alaya-bench-runner locomo [--limit N] [--offset N] [--embedding disabled|env] [--embedding-provider openai|local_onnx] [--edge-plane] [--data-dir <path>] [--history-root <path>]
  alaya-bench-runner self [--history-root <path>]
  alaya-bench-runner live [--source <main-check.json|main-check-run.json>] [--history-root <path>]
  alaya-bench-runner controlled-replay [--history-root <path>]
  alaya-bench-runner merge-longmemeval --shards <dir1> <dir2> ... --variant <v> --history-root <path> [--concurrency N]
  alaya-bench-runner extraction-fill [--variant oracle|s|m] [--limit N] [--offset N] [--concurrency N] [--data-dir <path>] [--extraction-cache-root <path>] --extraction-authority <receipt.json> [--pinned-meta-root <path>] [--promotion-contract <json>]
  alaya-bench-runner authorize-extraction [--variant oracle|s|m] [--limit N] [--offset N] [--concurrency N] [--data-dir <path>] [--extraction-cache-root <path>] [--pinned-meta-root <path>] --extraction-action probe|fill --extraction-receipt-out <receipt.json> --extraction-output-token-cap N --extraction-output-token-field max_tokens|max_completion_tokens --extraction-input-price-usd-per-million N --extraction-output-price-usd-per-million N --extraction-max-input-tokens N --extraction-disk-floor-bytes N [--extraction-probe-key <sha256>]
  alaya-bench-runner recall-eval --snapshot <db> [--legacy-snapshot --legacy-manifest-sha256 <sha> --legacy-dataset-sha256 <sha>] [--variant oracle|s|m] [--limit N] [--offset N] [--policy-shape stress|chat] [--weights '<json>'] [--data-dir <path>] [--data-dir-root <path>] [--pinned-meta-root <path>] [--history-root <path>] [--promotion-contract <json>]
  alaya-bench-runner authorize-longmemeval-matrix --contract <json> --out <json>
  alaya-bench-runner c0-reuse-decision --variant s --offset 0 --limit 100 --data-dir <path> --pinned-meta-root <path> --extraction-cache-root <source-root> --c0-target-cache-root <new-root> --c0-evidence-root <new-dir> --c0-final-model <model> --c0-final-model-family <family> --c0-final-request-profile <profile> --c0-final-provider-url <url>
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
  if (command === "authorize-longmemeval-matrix") {
    return runAuthorizeLongMemEvalMatrixCommand(rest);
  }
  if (command === "authorize-extraction") {
    return runAuthorizeExtractionCommand(rest);
  }
  if (command === "c0-reuse-decision") {
    return runC0ReuseDecisionCommand(rest);
  }
  const opts = parseCommandFlags(rest);
  return opts === null ? 2 : dispatchParsedCommand(command, opts);
}

function parseCommandFlags(rest: ReadonlyArray<string>): ParsedFlags | null {
  try {
    return parseFlags(rest);
  } catch (err) {
    process.stderr.write(
      `alaya-bench-runner: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return null;
  }
}

function dispatchParsedCommand(
  command: string | undefined,
  opts: ParsedFlags
): number | Promise<number> {
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
