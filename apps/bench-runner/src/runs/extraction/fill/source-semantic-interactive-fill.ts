import { buildOfficialApiSourceCorpus } from "@do-soul/alaya-soul";
import { refuseRecallCampaignLiveExtraction } from "@do-soul/alaya-core";
import { createGeminiHttpExtractor } from "../../compile-seed/http/gemini-http.js";
import { resolveExtractionRequestTimeoutMs } from "../../compile-seed/http/output-token-retry.js";
import { inspectCachedExtractionArtifact } from "../../compile-seed/cache/cache-shard.js";
import {
  SourceSemanticAdmissionError, writeDeterministicSourceSemanticArtifact, importSourceSemanticArtifact
} from "../cache/source-semantic-artifact.js";
import { extractionTypedArtifactMode } from "../request-artifact.js";
import { readExtractionCacheManifestIdentity, writeExtractionCacheManifest } from
  "../cache/extraction-cache-manifest.js";
import { resolveExtractionTransportRoute } from "../transport-route.js";
import type { ExtractionFillOptions, ExtractionFillResult } from "../extraction-fill.js";
import type { ExecutionExtractionAuthority } from "./fill-execution.js";
import { inspectFillWindow, type PreparedExtractionFill } from "./fill-preparation.js";
import { newFillStats, readFillRetryTelemetry } from "./fill-stats.js";
import { buildFillManifest } from "./manifest/fill-manifest.js";
import type { ExtractionCacheWriteLease } from "./manifest/fill-root-guard.js";
import { prepareBatchExtractionWorkset, type BatchExtractionWorkset } from "./batch-workset.js";
import type { GeminiBatchLine } from "./batch/contract.js";
import { batchDigest } from "./batch/plan.js";
import { encodeGeminiGenerateContent, isGeminiGenerateContentProfile } from "./batch/native-codec.js";
import { assertExtractionFillComplete } from "./fill-completion.js";
import { ExtractionCacheInvariantError } from "../cache/cache-invariant-error.js";
import {
  attemptInputByteUpperBound,
  assertAttemptInputWithinReceiptLimit
} from "../authority/receipt-limits.js";

interface InteractiveFillInput {
  readonly options: ExtractionFillOptions;
  readonly prepared: PreparedExtractionFill;
  readonly cacheRoot: string;
  readonly writeLease: ExtractionCacheWriteLease;
  readonly authority: ExecutionExtractionAuthority | undefined;
  readonly concurrency: number;
}

export async function executeOpenSemanticsInteractiveFill(
  input: InteractiveFillInput
): Promise<ExtractionFillResult> {
  refuseRecallCampaignLiveExtraction("extraction_write");
  assertInteractiveOpenSemanticsScope(input);
  const authority = input.authority!;
  const route = resolveExtractionTransportRoute(input.prepared.config);
  const profile = input.prepared.config.requestProfile;
  if (!isGeminiGenerateContentProfile(profile)) {
    throw new Error("open-semantics interactive fill request profile is unsupported");
  }
  if (authority.receipt.limits.output_token_field !== "maxOutputTokens") {
    throw new Error("open-semantics interactive fill requires maxOutputTokens");
  }
  const selected = selectedInteractiveKeys(authority);
  const workset = prepareBatchExtractionWorkset({
    prepared: input.prepared, cacheRoot: input.cacheRoot,
    ...(selected === undefined ? {} : { executionCacheKeys: selected })
  });
  const maxOutputTokens = authority.receipt.limits.max_output_tokens;
  for (const line of workset.lines) {
    assertAttemptInputWithinReceiptLimit(
      attemptInputByteUpperBound(JSON.stringify(encodeGeminiGenerateContent(line, {
        model: route.model, requestProfile: profile, maxOutputTokens
      }))),
      authority.receipt.price.maximum_input_tokens_per_attempt
    );
  }
  if (input.prepared.config.apiKey === null) throw new Error("garden API key is unavailable");
  const extractor = createGeminiHttpExtractor(input.prepared.config);
  let newlyExtracted = 0;
  await runBoundedWorkers(workset.lines, input.concurrency, async (line) => {
    if (await dispatchInteractiveLine(input, workset, line, extractor, maxOutputTokens) === "admitted") {
      newlyExtracted += 1;
    }
  });
  importDeterministicEmpty(input, workset);
  return publishInteractiveFill(input, workset, newlyExtracted);
}

function assertInteractiveOpenSemanticsScope(input: InteractiveFillInput): void {
  if (input.options.ingestionMode === "lazy_field" || input.prepared.expansion !== undefined ||
      input.options.extractorFactory !== undefined || input.options.questionBatchLimit !== undefined) {
    throw new Error("open-semantics interactive fill requires a full, isolated precomputed extraction window");
  }
  if (input.authority === undefined) {
    throw new Error("open-semantics interactive fill requires an extraction authority receipt");
  }
  if (input.authority.receipt.action === "sample") throw new Error("sample authority is Batch-only");
  if (input.authority.receipt.repair_scope !== undefined) {
    throw new Error("open-semantics interactive fill needs a fill or probe authority");
  }
  if (input.prepared.config.openSemantics === undefined) {
    throw new Error("open-semantics interactive fill requires pinned open semantics");
  }
}

function selectedInteractiveKeys(authority: ExecutionExtractionAuthority): ReadonlySet<string> | undefined {
  if (authority.receipt.action === "probe") return new Set([authority.receipt.probe_key!]);
  if (authority.receipt.catalog_refill === undefined) return undefined;
  return new Set(authority.receipt.catalog_refill.keys);
}

async function dispatchInteractiveLine(
  input: InteractiveFillInput,
  workset: BatchExtractionWorkset,
  line: GeminiBatchLine,
  extractor: ReturnType<typeof createGeminiHttpExtractor>,
  maxOutputTokens: number
): Promise<"admitted" | "quarantined"> {
  const sourceCorpus = workset.requests.find((request) => request.line.key === line.key)?.units[0]?.sourceCorpus;
  if (sourceCorpus === undefined) throw new Error("open-semantics interactive fill lost its bound source corpus");
  const authority = input.authority!;
  if (authority.reserveAttemptOrdinal === undefined) {
    throw new Error("open-semantics interactive fill requires bound attempt authority");
  }
  const attemptOrdinal = await authority.reserveAttemptOrdinal(line.key, input.options.signal);
  try {
    const extracted = await extractor.extract({
      systemPrompt: line.systemPrompt, userPrompt: line.userPrompt, retryMode: "disabled",
      timeoutMs: resolveExtractionRequestTimeoutMs(maxOutputTokens), maxOutputTokens,
      outputTokenField: "maxOutputTokens",
      validateRawJson: () => undefined,
      ...(input.options.signal === undefined ? {} : { abortSignal: input.options.signal })
    });
    return importInteractiveLine(input, line, sourceCorpus, extracted, attemptOrdinal);
  } catch (cause) {
    authority.abandonPendingShard(line.key, attemptOrdinal);
    throw cause;
  }
}

function importInteractiveLine(
  input: InteractiveFillInput,
  line: GeminiBatchLine,
  sourceCorpus: string,
  extracted: Awaited<ReturnType<ReturnType<typeof createGeminiHttpExtractor>["extract"]>>,
  attemptOrdinal: number
): "admitted" | "quarantined" {
  const authority = input.authority!;
  const provenance = {
    transport: "gemini-generate-content" as const, finishReason: "STOP" as const, attemptOrdinal,
    responseSha256: batchDigest(extracted.rawJson),
    ...(extracted.usage === undefined ? {} : { usage: extracted.usage })
  };
  try {
    importSourceSemanticArtifact({
      config: input.prepared.config, cacheRoot: input.cacheRoot, writeLease: input.writeLease,
      sourceCorpus, result: { line, rawJson: extracted.rawJson, provenance }
    });
  } catch (cause) {
    if (!(cause instanceof SourceSemanticAdmissionError)) throw cause;
    authority.abandonPendingShard(line.key, attemptOrdinal);
    recordInteractiveOutcome(authority, line.key, attemptOrdinal, extracted, "quarantined", provenance.responseSha256);
    return "quarantined";
  }
  const inspected = inspectCachedExtractionArtifact(
    input.cacheRoot, line.key, input.prepared.config.model, input.prepared.config.requestProfile,
    extractionTypedArtifactMode(input.prepared.config)
  );
  if (inspected.status !== "hit") {
    authority.abandonPendingShard(line.key, attemptOrdinal);
    return "quarantined";
  }
  recordInteractiveOutcome(authority, line.key, attemptOrdinal, extracted, "admitted");
  authority.commitSuccessfulShard(line.key);
  return "admitted";
}

function recordInteractiveOutcome(
  authority: ExecutionExtractionAuthority,
  key: string,
  attemptOrdinal: number,
  extracted: Awaited<ReturnType<ReturnType<typeof createGeminiHttpExtractor>["extract"]>>,
  outcome: "admitted" | "quarantined",
  fingerprint?: string
): void {
  authority.recordTransportOutcome(key, {
    retryCount: 0, rateLimitRetries: 0,
    successfulRequestCount: outcome === "admitted" ? 1 : 0,
    usageRequestCount: extracted.usage === undefined ? 0 : 1,
    ...(outcome === "admitted" ? {} : { terminalRetryClassification: "failure_non_retryable_response" as const }),
    transportFailures: outcome === "admitted" || fingerprint === undefined ? [] : [{
      attempt: 1, kind: "response_schema_error" as const, phase: "response_schema" as const,
      httpStatus: null, fingerprint
    }],
    ...(extracted.usage === undefined ? {} : { usage: extracted.usage })
  }, attemptOrdinal);
}

function importDeterministicEmpty(input: InteractiveFillInput, workset: BatchExtractionWorkset): void {
  for (const { line, sourceTurn } of workset.deterministicEmptyRequests) {
    writeDeterministicSourceSemanticArtifact({
      config: input.prepared.config, cacheRoot: input.cacheRoot, writeLease: input.writeLease, line,
      sourceCorpus: buildOfficialApiSourceCorpus(sourceTurn.turnContent, sourceTurn.turnMessages)
    });
    input.authority!.commitDeterministicShard(line.key);
  }
}

function publishInteractiveFill(
  input: InteractiveFillInput, workset: BatchExtractionWorkset, newlyExtracted: number
): ExtractionFillResult {
  input.writeLease.assertOwned();
  const completion = inspectFillWindow(input.cacheRoot, input.prepared.config, input.prepared.distinctExtractionTurns);
  let status: "complete" | "in_progress" = "complete";
  try { assertExtractionFillComplete(completion); }
  catch (cause) {
    if (!(cause instanceof ExtractionCacheInvariantError)) throw cause;
    status = "in_progress";
  }
  const manifest = buildFillManifest({
    config: input.prepared.config, variant: input.prepared.variant,
    existingManifest: readExtractionCacheManifestIdentity(input.cacheRoot)?.manifest,
    datasetRevision: input.prepared.datasetRevision, windowOffset: input.prepared.windowOffset,
    windowLimit: input.prepared.windowLimit, completion, status
  });
  writeExtractionCacheManifest(input.cacheRoot, manifest);
  return {
    requestedTurns: input.prepared.requestedTurns, cacheHits: workset.cachedRequests.length,
    newlyExtracted, coverage: completion.coverage, manifest,
    ...readFillRetryTelemetry(newFillStats()), authorityTelemetry: input.authority!.snapshot()
  };
}

async function runBoundedWorkers<T>(
  items: readonly T[], concurrency: number, worker: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  let cursor = 0;
  async function pump(): Promise<void> {
    while (cursor < items.length) {
      const item = items[cursor++];
      if (item !== undefined) await worker(item);
    }
  }
  const settled = await Promise.allSettled(
    Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, () => pump())
  );
  const rejected = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (rejected !== undefined) throw rejected.reason;
}
