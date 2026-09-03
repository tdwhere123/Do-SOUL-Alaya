import process from "node:process";
import { runMergeLongMemEvalCommand } from "./merge.js";
import { parseFlags, type ParsedFlags } from "./cli-options.js";
import { runAuthorizeExtractionCommand } from "./extraction-authority/command.js";
import { runSelectExtractionTargetCommand } from "./target-selection/command.js";
import { runDiagnosticLoopCommand } from "./diagnostic-loop/command.js";
import { runEmitEmbeddingCacheOverlayCommand } from
  "./emit-embedding-cache-overlay/command.js";
import { runProviderPreflightCommand } from "./provider-preflight/command.js";
import { peelExtractionFillLazyFlags } from "./extraction-fill/lazy-field-flags.js";
import {
  runExtractionFillCommand,
  runFetchLocomoCommand,
  runFetchLongMemEval,
  runLocomoCommand,
  runLongMemEvalCommand,
  runRecallEvalCommand
} from "./cli-commands.js";

const HELP_TEXT = `alaya-bench-runner — daemon-attached benchmark harness

Operator benches are LongMemEval-S (\`s\`) and LoCoMo. Dataset files still
include oracle|s|m; \`s\` is the operator bench.

Usage:
  alaya-bench-runner fetch-longmemeval [--variant oracle|s|m] [--data-dir <path>] [--force]
  alaya-bench-runner longmemeval [--variant oracle|s|m] [--limit N] [--offset N] [--concurrency N] [--embedding disabled|env] [--embedding-provider openai|local_onnx] [--policy-shape stress|chat] [--simulate-report none|always-used|gold-only|mixed] [--expected-reconciliation-basis rule_only|garden_llm] [--weights '<json>'] [--qa] [--data-dir <path>] [--snapshot-out <db>] [--data-dir-root <path>] [--pinned-meta-root <path>] [--history-root <path>]
    --qa  end-to-end QA accuracy (answer-LLM + LLM-judge over delivered recall). OFF by default. ON => 2 provider chat calls/question (costs money). Needs ALAYA_QA_PROVIDER_URL / ALAYA_QA_API_KEY / ALAYA_QA_MODEL; optional ALAYA_QA_JUDGE_MODEL.
    --expected-reconciliation-basis  fail before question execution unless the daemon attests the requested effective decision basis.
  alaya-bench-runner fetch-locomo [--data-dir <path>] [--force]
  alaya-bench-runner locomo [--limit N] [--offset N] [--embedding disabled|env] [--embedding-provider openai|local_onnx] [--edge-plane] [--data-dir <path>] [--history-root <path>]
    --edge-plane  drain the BULK_ENRICH edge pass before recall (cumulative modes only). OFF by default to keep embedding ON/OFF corpora comparable.
  alaya-bench-runner merge-longmemeval --shards <dir1> <dir2> ... --variant <v> --history-root <path> [--concurrency N]
  alaya-bench-runner extraction-fill [--variant oracle|s|m] [--limit N] [--offset N] [--concurrency N] [--extraction-initial-concurrency N] [--question-batch-limit N] [--tolerate-provider-task-failures] [--data-dir <path>] [--extraction-cache-root <path>] --extraction-authority <receipt.json> [--extraction-predecessor-authority <receipt.json>] [--extraction-target-selection <receipt.json>] [--pinned-meta-root <path>] [--r3-spend-approval <json>] [--ingestion-mode precomputed_full|lazy_field] [--semantic-artifact-root <path>] [--semantic-max-calls N] [--semantic-max-failures N]
  alaya-bench-runner authorize-extraction [--variant oracle|s|m] [--limit N] [--offset N] [--question-batch-limit N] [--concurrency N] [--data-dir <path>] [--extraction-cache-root <path>] [--pinned-meta-root <path>] --extraction-action probe|fill --extraction-receipt-out <receipt.json> --extraction-output-token-cap N --extraction-output-token-field max_tokens|max_completion_tokens --extraction-input-price-usd-per-million N --extraction-output-price-usd-per-million N --extraction-max-input-tokens N --extraction-disk-floor-bytes N [--extraction-probe-key <sha256>] [--extraction-predecessor-authority <receipt.json>] [--extraction-target-selection <receipt.json>] [--repair-invalid-shards]
  alaya-bench-runner select-extraction-target --variant s --offset 0 --limit 100 --extraction-cache-root <target-root> (--cache-audit-receipt <audit-receipt.json> | --materialization-receipt <receipt.json> | --retired-source-rebuild-operator <operator> | --predecessor-target-selection <receipt.json> --extraction-predecessor-authority <receipt.json> [--adopt-existing-child-target-selection <receipt.json> --adopt-existing-child-authority <receipt.json>]) --target-selection-out <receipt.json> [--data-dir <path>] [--pinned-meta-root <path>]
  alaya-bench-runner recall-eval --snapshot <db> [--embedding-cache-overlay <receipt.json>] [--query-semantic-factor-cache <json>] [--experiment [--seed-extraction-system-prompt <txt>] [--rebuild-evidence-search-projections [--backfill-missing-fact-frame-formations|--fact-frame-retrofit-ledger <ndjson>]] [--warm-derived-snapshot-receipt <json>]] [--variant oracle|s|m] [--limit N] [--offset N] [--concurrency N] [--policy-shape stress|chat] [--weights '<json>'] [--data-dir <path>] [--data-dir-root <path>] [--pinned-meta-root <path>] [--history-root <path>]
  alaya-bench-runner emit-embedding-cache-overlay --snapshot <db> --receipt <json>
    Cache-only document embed into a source-bound overlay sidecar. Frozen snapshot stays read-only; recall-eval imports the overlay before scoring.
  alaya-bench-runner diagnostic-loop --work-root <dir> --request-manifest <json> [--mode smoke|run|cache-only|report-only] [--from-phase <phase>] [--snapshot <db>] [--snapshot-out <db>] [--query-semantic-factor-cache <json>] [--embedding-cache-overlay <receipt.json>] [--canary-unlock <3q-work-root>] [--history-root <path>]
    One resumable cache-only campaign: preflight → authority/cache → extraction proof → snapshot → control/treatment recall → miss ledger → report. Smoke uses the same path including host_worker. Report-only never reruns extraction or recall.
  alaya-bench-runner provider-preflight --mode replay --request-manifest <json>
  alaya-bench-runner provider-preflight --mode probe|probe-sse --provider-route <url> [--model <id>]
  alaya-bench-runner provider-preflight --mode retire-obsolete --extraction-cache-root <dir> --expected-path <dir> --profile <profile> [--confirm-retire]
    Replay requires the canonical sealed request manifest and a credentialless environment. Probe requires credentials and a catalog binding. Retire-obsolete is a path/lock preflight and does not delete.
  alaya-bench-runner --help

Variants:
  oracle  longmemeval_oracle (default)
  s       longmemeval_s (operator bench)
  m       longmemeval_m

Exit codes:
  0  success (verdict ok or warn)
  1  verdict = fail (regression)
  2  argument / IO error
`;

/**
 * CLI entry point for the bench-runner binary.
 * Operator benches are LongMemEval-S and LoCoMo.
 */
export async function runCli(argv: ReadonlyArray<string>): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  const [command, ...rest] = argv;
  if (command === "authorize-extraction") {
    return runAuthorizeExtractionCommand(rest);
  }
  if (command === "select-extraction-target") {
    return runSelectExtractionTargetCommand(rest);
  }
  if (command === "diagnostic-loop") {
    return runDiagnosticLoopCommand(rest);
  }
  if (command === "emit-embedding-cache-overlay") {
    return runEmitEmbeddingCacheOverlayCommand(rest);
  }
  if (command === "provider-preflight") {
    return runProviderPreflightCommand(rest);
  }
  if (command === "extraction-fill") {
    return dispatchExtractionFill(rest);
  }
  const opts = parseCommandFlags(rest);
  if (opts === null) return 2;
  const compatibilityError = commandFlagCompatibilityError(command, opts);
  if (compatibilityError !== null) {
    process.stderr.write(`alaya-bench-runner: ${compatibilityError}\n`);
    return 2;
  }
  return dispatchParsedCommand(command, opts);
}

function commandFlagCompatibilityError(
  command: string | undefined,
  opts: ParsedFlags
): string | null {
  if (opts.extractionPredecessorAuthority !== undefined &&
      command !== "extraction-fill") {
    return "--extraction-predecessor-authority is only valid for " +
      "continuation extraction commands";
  }
  if (opts.experiment === true && command !== "recall-eval") {
    return "--experiment is only valid for recall-eval";
  }
  if (opts.tolerateProviderTaskFailures && command !== "extraction-fill") {
    return "--tolerate-provider-task-failures is only valid for extraction-fill";
  }
  if (opts.rebuildEvidenceSearchProjections === true && command !== "recall-eval") {
    return "--rebuild-evidence-search-projections is only valid for recall-eval";
  }
  if (opts.backfillMissingFactFrameFormations === true && command !== "recall-eval") {
    return "--backfill-missing-fact-frame-formations is only valid for recall-eval";
  }
  if (opts.warmDerivedSnapshotReceipt !== undefined && command !== "recall-eval") {
    return "--warm-derived-snapshot-receipt is only valid for recall-eval";
  }
  if (opts.embeddingCacheOverlayReceipt !== undefined && command !== "recall-eval") {
    return "--embedding-cache-overlay is only valid for recall-eval";
  }
  if (opts.factFrameRetrofitLedger !== undefined && command !== "recall-eval") {
    return "--fact-frame-retrofit-ledger is only valid for recall-eval";
  }
  if (opts.seedExtractionSystemPrompt !== undefined && command !== "recall-eval") {
    return "--seed-extraction-system-prompt is only valid for recall-eval";
  }
  if (opts.querySemanticFactorCache !== undefined && command !== "recall-eval") {
    return "--query-semantic-factor-cache is only valid for recall-eval";
  }
  return null;
}

function dispatchExtractionFill(rest: ReadonlyArray<string>): number | Promise<number> {
  let peeled;
  try {
    peeled = peelExtractionFillLazyFlags(rest);
  } catch (err) {
    process.stderr.write(
      `alaya-bench-runner: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 2;
  }
  const opts = parseCommandFlags(peeled.rest);
  if (opts === null) return 2;
  const compatibilityError = commandFlagCompatibilityError("extraction-fill", opts);
  if (compatibilityError !== null) {
    process.stderr.write(`alaya-bench-runner: ${compatibilityError}\n`);
    return 2;
  }
  return runExtractionFillCommand(opts, undefined, peeled.lazy);
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
    case "fetch-locomo":
      return runFetchLocomoCommand(opts);
    case "locomo":
      return runLocomoCommand(opts);
    case "merge-longmemeval":
      return runMergeLongMemEvalCommand(opts);
    case "recall-eval":
      return runRecallEvalCommand(opts);
    default:
      process.stderr.write(
        `alaya-bench-runner: unknown command '${command ?? ""}'\n${HELP_TEXT}`
      );
      return 2;
  }
}
