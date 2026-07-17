import process from "node:process";
import { runExtractionFill } from "../../longmemeval/extraction-fill.js";
import { ExtractionFillTaskError } from
  "../../longmemeval/extraction/fill-pool.js";
import type { ParsedFlags } from "../cli-options.js";
import { verifyLongMemEvalExpansionContractInput } from
  "../promotion/expansion-input.js";
import { pct } from "../result-format.js";
import {
  ExtractionFillInterruptedError,
  withExtractionFillSignalScope,
  type ExtractionFillSignalSource
} from "./signal-scope.js";

/** Fill the extraction cache without starting the benchmark daemon. */
export async function runExtractionFillCommand(
  opts: ParsedFlags,
  deps: {
    readonly runExtractionFill: typeof runExtractionFill;
    readonly signalSource: ExtractionFillSignalSource;
    readonly verifyExpansionContract?: typeof verifyLongMemEvalExpansionContractInput;
  } = { runExtractionFill, signalSource: process }
): Promise<number> {
  try {
    if (opts.extractionAuthority === undefined) {
      process.stderr.write(
        "alaya-bench-runner extraction-fill: live extraction is blocked without " +
        "a digest-bound --extraction-authority receipt\n"
      );
      return 2;
    }
    const expansionCapability = opts.promotionContract === undefined
      ? undefined
      : await (deps.verifyExpansionContract ??
        verifyLongMemEvalExpansionContractInput)(opts.promotionContract);
    process.stdout.write(renderStart(opts));
    const result = await withExtractionFillSignalScope(
      deps.signalSource,
      (signal) => deps.runExtractionFill({
        variant: opts.variant,
        ...(opts.limit === undefined ? {} : { limit: opts.limit }),
        ...(opts.offset === undefined ? {} : { offset: opts.offset }),
        ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency }),
        ...(opts.dataDir === undefined ? {} : { dataDir: opts.dataDir }),
        ...(opts.extractionCacheRoot === undefined ? {} : {
          cacheRoot: opts.extractionCacheRoot
        }),
        authorityReceiptPath: opts.extractionAuthority,
        ...(opts.pinnedMetaRoot === undefined ? {} : {
          pinnedMetaRoot: opts.pinnedMetaRoot
        }),
        ...(expansionCapability === undefined ? {} : { expansionCapability }),
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
    "...\n";
}

function renderResult(
  result: Awaited<ReturnType<typeof runExtractionFill>>
): string {
  return `Done. requested_turns=${result.requestedTurns} ` +
    `cache_hits=${result.cacheHits} newly_extracted=${result.newlyExtracted} ` +
    `failures=0 retry_successes=${result.retrySuccesses} ` +
    `rate_limit_retries=${result.rateLimitRetries} ` +
    `adaptive_backoffs=${result.adaptiveConcurrencyBackoffs} ` +
    `adaptive_backoff_ms=${result.adaptiveConcurrencyBackoffMs} ` +
    renderAuthorityTelemetry(result.authorityTelemetry) +
    `terminal_max_retries=${result.terminalRetryClassifications.failure_max_retries} ` +
    `terminal_nonretryable_4xx=${result.terminalRetryClassifications.failure_non_retryable_4xx} ` +
    `terminal_timeouts=${result.terminalRetryClassifications.failure_timeout} ` +
    `coverage=${pct(result.coverage)}\n`;
}

function renderAuthorityTelemetry(
  telemetry: Awaited<ReturnType<typeof runExtractionFill>>["authorityTelemetry"]
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
    `alaya-bench-runner extraction-fill: ${error instanceof Error
      ? error.message
      : String(error)}\n`
  );
  return 2;
}
