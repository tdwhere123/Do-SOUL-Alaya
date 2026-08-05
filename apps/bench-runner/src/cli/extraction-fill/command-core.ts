import process from "node:process";
import { ExtractionFillTaskError } from "../../longmemeval/extraction/fill/fill-pool.js";
import type { runExtractionFill } from "../../longmemeval/extraction/extraction-fill.js";
import type { ParsedFlags } from "../cli-options.js";
import type { verifyLongMemEvalExpansionContractInput } from "../promotion/expansion-input.js";
import type { readR3SpendApproval } from "../../longmemeval/promotion/r3-spend-approval.js";
import { pct } from "../result-format.js";
import { countTerminalProviderFailures } from "../../longmemeval/extraction/fill/fill-stats.js";
import {
  ExtractionFillInterruptedError,
  withExtractionFillSignalScope,
  type ExtractionFillSignalSource
} from "./signal-scope.js";
import type { ExtractionFillResult } from "../../longmemeval/extraction/extraction-fill.js";

export interface ExtractionFillCommandDependencies {
  readonly runExtractionFill: typeof runExtractionFill;
  readonly signalSource: ExtractionFillSignalSource;
  readonly verifyExpansionContract?: typeof verifyLongMemEvalExpansionContractInput;
  readonly readR3SpendApproval?: typeof readR3SpendApproval;
}

export async function runExtractionFillCommand(
  opts: ParsedFlags,
  deps: ExtractionFillCommandDependencies
): Promise<number> {
  try {
    if (opts.catalogRefillAllowlist !== undefined) {
      throw new Error(
        "--catalog-refill-allowlist is accepted only by authorize-extraction; " +
        "extraction-fill uses the receipt-bound key set"
      );
    }
    if (opts.extractionPredecessorAuthority !== undefined &&
        opts.extractionAuthority === undefined) {
      throw new Error(
        "--extraction-predecessor-authority requires --extraction-authority"
      );
    }
    const expansionCapability = opts.promotionContract === undefined
      ? undefined
      : deps.verifyExpansionContract === undefined
        ? (() => { throw new Error("expansion contract verifier is unavailable"); })()
        : await deps.verifyExpansionContract(opts.promotionContract);
    const r3SpendApproval = opts.r3SpendApproval === undefined
      ? undefined
      : deps.readR3SpendApproval === undefined
        ? (() => { throw new Error("R3 spend approval reader is unavailable"); })()
        : deps.readR3SpendApproval(opts.r3SpendApproval);
    process.stdout.write(renderStart(opts));
    const result = await withExtractionFillSignalScope(
      deps.signalSource,
      (signal) => deps.runExtractionFill({
        variant: opts.variant,
        ...(opts.limit === undefined ? {} : { limit: opts.limit }),
        ...(opts.offset === undefined ? {} : { offset: opts.offset }),
        ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency }),
        ...(opts.extractionInitialConcurrency === undefined ? {} : {
          initialConcurrency: opts.extractionInitialConcurrency
        }),
        ...(opts.questionBatchLimit === undefined ? {} : {
          questionBatchLimit: opts.questionBatchLimit
        }),
        ...(opts.tolerateProviderTaskFailures
          ? { tolerateProviderTaskFailures: true }
          : {}),
        ...(opts.dataDir === undefined ? {} : { dataDir: opts.dataDir }),
        ...(opts.extractionCacheRoot === undefined ? {} : {
          cacheRoot: opts.extractionCacheRoot
        }),
        ...(opts.extractionAuthority === undefined ? {} : {
          authorityReceiptPath: opts.extractionAuthority
        }),
        ...(opts.extractionTargetSelection === undefined ? {} : {
          targetSelectionReceiptPath: opts.extractionTargetSelection
        }),
        ...(opts.extractionPredecessorAuthority === undefined ? {} : {
          predecessorAuthorityReceiptPath: opts.extractionPredecessorAuthority
        }),
        ...(opts.pinnedMetaRoot === undefined ? {} : {
          pinnedMetaRoot: opts.pinnedMetaRoot
        }),
        ...(expansionCapability === undefined ? {} : { expansionCapability }),
        ...(r3SpendApproval === undefined ? {} : { r3SpendApproval }),
        signal
      })
    );
    process.stdout.write(renderResult(result));
    return 0;
  } catch (error) {
    return handleExtractionFillError(error);
  }
}

function renderStart(opts: ParsedFlags): string {
  return `Filling extraction cache for ${opts.variant}` +
    (opts.offset !== undefined ? ` offset=${opts.offset}` : "") +
    (opts.limit !== undefined ? ` limit=${opts.limit}` : "") +
    (opts.concurrency !== undefined ? ` concurrency=${opts.concurrency}` : "") +
    (opts.extractionInitialConcurrency !== undefined
      ? ` initial_concurrency=${opts.extractionInitialConcurrency}` : "") +
    (opts.questionBatchLimit !== undefined
      ? ` question_batch_limit=${opts.questionBatchLimit}` : "") +
    (opts.tolerateProviderTaskFailures
      ? " provider_failure_isolation=on" : "") +
    "...\n";
}

function renderResult(result: ExtractionFillResult): string {
  const partial = result.manifest.fill_status === "in_progress";
  const outcome = partial ? "Partial." : "Done.";
  const coverage = partial
    ? `partial_coverage=${pct(result.coverage)} full_coverage=${result.manifest.coverage === undefined
      ? "unknown" : pct(result.manifest.coverage)}`
    : `coverage=${pct(result.coverage)}`;
  return `${outcome} requested_turns=${result.requestedTurns} ` +
    `cache_hits=${result.cacheHits} newly_extracted=${result.newlyExtracted} ` +
    `failures=${countTerminalProviderFailures(result)} ` +
    `retry_successes=${result.retrySuccesses} ` +
    `rate_limit_retries=${result.rateLimitRetries} ` +
    `adaptive_backoffs=${result.adaptiveConcurrencyBackoffs} ` +
    `adaptive_backoff_ms=${result.adaptiveConcurrencyBackoffMs} ` +
    renderAuthorityTelemetry(result.authorityTelemetry) +
    `terminal_max_retries=${result.terminalRetryClassifications.failure_max_retries} ` +
    `terminal_nonretryable_4xx=${result.terminalRetryClassifications.failure_non_retryable_4xx} ` +
    `terminal_timeouts=${result.terminalRetryClassifications.failure_timeout} ` +
    `${coverage}\n`;
}

function renderAuthorityTelemetry(
  telemetry: ExtractionFillResult["authorityTelemetry"]
): string {
  if (telemetry === undefined) return "authority=none ";
  return `attempts=${telemetry.attempts}/${telemetry.maximumAttempts} ` +
    `successful_shards=${telemetry.successfulShards}/${telemetry.successfulShardCeiling} ` +
    `usage_input_tokens=${telemetry.telemetry.inputTokens} ` +
    `usage_output_tokens=${telemetry.telemetry.outputTokens} ` +
    `usage_total_tokens=${telemetry.telemetry.totalTokens} ` +
    `usage_unavailable=${telemetry.telemetry.usageUnavailableRequests} ` +
    `usage_unresolved=${telemetry.telemetry.unresolvedTransportAttempts} ` +
    `usage_unknown=${telemetry.telemetry.usageUnknownAttempts} `;
}

function handleExtractionFillError(error: unknown): number {
  if (error instanceof ExtractionFillInterruptedError) return error.exitCode;
  if (error instanceof ExtractionFillTaskError) {
    process.stderr.write(`alaya-bench-runner extraction-fill: ${error.message}\n`);
    return error.exitCode;
  }
  process.stderr.write(
    `alaya-bench-runner extraction-fill: ${error instanceof Error ? error.message : String(error)}\n`
  );
  return 2;
}
