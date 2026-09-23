import { AlayaError } from "@do-soul/alaya-protocol";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { buildOfficialApiSourceCorpus } from "@do-soul/alaya-soul";
import { refuseRecallCampaignLiveExtraction } from "@do-soul/alaya-core";
import { readLiveTransportFailure } from "../cache/cache-live-delegate.js";
import { createGeminiHttpExtractor, readGeminiFailureResponse } from "../../compile-seed/http/gemini-http.js";
import { GEMINI_INTERACTIVE_TIMEOUT_FLOOR_MS } from "../../compile-seed/http/gemini-http.js";
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
import { encodeGeminiGenerateContent, isCompleteGeminiFinish, isGeminiGenerateContentProfile } from "./batch/native-codec.js";
import {
  bindProviderRawAttempt, listProviderRawAttempts, readProviderRawAttempt, requestEnvelopeDigest,
  writeProviderRawAttempt, retainedFailureOutcome, verifyProviderRawReservation, type ProviderRawAttempt
} from "./provider-raw-attempt.js";
import { assertExtractionFillComplete } from "./fill-completion.js";
import { ExtractionCacheInvariantError } from "../cache/cache-invariant-error.js";
import {
  attemptInputByteUpperBound,
  assertAttemptInputWithinReceiptLimit,
  COMPLETE_SOURCE_FILL_ATTEMPTS_PER_MISSING_SHARD
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
    throw new AlayaError("VALIDATION", "open-semantics interactive fill request profile is unsupported");
  }
  if (authority.receipt.limits.output_token_field !== "maxOutputTokens") {
    throw new AlayaError("VALIDATION", "open-semantics interactive fill requires maxOutputTokens");
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
  const extractor = createGeminiHttpExtractor(input.prepared.config);
  let newlyExtracted = 0;
  await runBoundedWorkers(workset.lines, input.concurrency, async (line) => {
    if (await fillInteractiveLine(input, workset, line, extractor, maxOutputTokens) === "admitted") {
      newlyExtracted += 1;
    }
  });
  importDeterministicEmpty(input, workset);
  return publishInteractiveFill(input, workset, newlyExtracted);
}

function assertInteractiveOpenSemanticsScope(input: InteractiveFillInput): void {
  if (input.options.ingestionMode === "lazy_field" || input.prepared.expansion !== undefined ||
      input.options.extractorFactory !== undefined || input.options.questionBatchLimit !== undefined) {
    throw new AlayaError("VALIDATION", "open-semantics interactive fill requires a full, isolated precomputed extraction window");
  }
  if (input.authority === undefined) {
    throw new AlayaError("VALIDATION", "open-semantics interactive fill requires an extraction authority receipt");
  }
  if (input.authority.receipt.action === "sample") throw new AlayaError("CONFLICT", "sample authority is Batch-only");
  if (input.authority.receipt.repair_scope !== undefined) {
    throw new AlayaError("VALIDATION", "open-semantics interactive fill needs a fill or probe authority");
  }
  if (input.prepared.config.openSemantics === undefined) {
    throw new AlayaError("CONFLICT", "open-semantics interactive fill requires pinned open semantics");
  }
}

function selectedInteractiveKeys(authority: ExecutionExtractionAuthority): ReadonlySet<string> | undefined {
  if (authority.receipt.action === "probe") return new Set([authority.receipt.probe_key!]);
  if (authority.receipt.catalog_refill === undefined) return undefined;
  return new Set(authority.receipt.catalog_refill.keys);
}

async function fillInteractiveLine(
  input: InteractiveFillInput,
  workset: BatchExtractionWorkset,
  line: GeminiBatchLine,
  extractor: ReturnType<typeof createGeminiHttpExtractor>,
  maxOutputTokens: number
): Promise<"admitted" | "quarantined" | "transport_exhausted"> {
  const replayed = replayInteractiveRaws(input, workset, line);
  if (replayed !== undefined) return replayed;
  const retained = new Set(input.authority!.snapshot()?.transportFailures
    .filter((item) => item.cacheKey === line.key).map((item) => item.attemptOrdinal));
  let last: "quarantined" | "transport_exhausted" = "transport_exhausted";
  for (let attempt = retained.size; attempt < COMPLETE_SOURCE_FILL_ATTEMPTS_PER_MISSING_SHARD; attempt += 1) {
    const outcome = await dispatchInteractiveLine(input, workset, line, extractor, maxOutputTokens);
    if (outcome === "admitted" || outcome === "quarantined") return outcome;
    last = outcome;
  }
  return last;
}

function replayInteractiveRaws(
  input: InteractiveFillInput,
  workset: BatchExtractionWorkset,
  line: GeminiBatchLine
): "admitted" | "quarantined" | "transport_exhausted" | undefined {
  const unresolved = input.authority!.snapshot()?.unresolvedAttempts
    .filter((item) => item.cacheKey === line.key) ?? [];
  for (const pending of unresolved) {
    if (readProviderRawAttempt(input.cacheRoot, line.key, pending.attemptOrdinal) === undefined) {
      return "transport_exhausted";
    }
  }
  const raws = listProviderRawAttempts(input.cacheRoot, line.key);
  if (raws.length === 0) return undefined;
  const sourceCorpus = boundSourceCorpus(workset, line);
  for (const raw of raws) {
    const outcome = importInteractiveFromRaw(input, line, sourceCorpus, raw);
    if (outcome === "admitted" || outcome === "quarantined") return outcome;
  }
  return raws.length >= COMPLETE_SOURCE_FILL_ATTEMPTS_PER_MISSING_SHARD ? "transport_exhausted" : undefined;
}

function importInteractiveFromRaw(
  input: InteractiveFillInput,
  line: GeminiBatchLine,
  sourceCorpus: string,
  raw: ProviderRawAttempt
): "admitted" | "quarantined" | "transport_exhausted" {
  bindProviderRawAttempt(raw, {
    cacheKey: line.key, kind: "source_semantic", model: input.prepared.config.model,
    requestProfile: input.prepared.config.requestProfile,
    requestDigest: requestEnvelopeDigest(line.userPrompt)
  });
  if (verifyProviderRawReservation(raw, input.authority!.snapshot()) === "rejected") return "quarantined";
  const failure = retainedFailureOutcome(raw);
  if (failure !== undefined) {
    input.authority!.recordTransportOutcome(line.key, failure, raw.attempt_ordinal);
    input.authority!.abandonPendingShard(line.key, raw.attempt_ordinal);
    return raw.failure_retryable === true ? "transport_exhausted" : "quarantined";
  }
  const extracted: InteractiveExtracted = {
    rawJson: raw.decoded_text,
    responseMetadata: { finishReason: raw.finish_reason },
    ...(raw.usage === null ? {} : { usage: raw.usage })
  };
  if (!raw.full_replay_possible) {
    // Settle the completed response without parsing its prefix or replacing the full-response digest.
    recordInteractiveOutcome(input.authority!, line.key, raw.attempt_ordinal,
      extracted, "quarantined", raw.decoded_text_digest);
    return "quarantined";
  }
  return importInteractiveLine(input, line, sourceCorpus, extracted, raw.attempt_ordinal);
}

function boundSourceCorpus(workset: BatchExtractionWorkset, line: GeminiBatchLine): string {
  const sourceCorpus = workset.requests.find((request) => request.line.key === line.key)?.units[0]?.sourceCorpus;
  if (sourceCorpus === undefined) throw new AlayaError("INTERNAL", "open-semantics interactive fill lost its bound source corpus");
  return sourceCorpus;
}

async function dispatchInteractiveLine(
  input: InteractiveFillInput,
  workset: BatchExtractionWorkset,
  line: GeminiBatchLine,
  extractor: ReturnType<typeof createGeminiHttpExtractor>,
  maxOutputTokens: number
): Promise<"admitted" | "quarantined" | "transport_exhausted"> {
  const sourceCorpus = boundSourceCorpus(workset, line);
  const authority = input.authority!;
  if (authority.reserveAttemptOrdinal === undefined) {
    throw new AlayaError("CONFLICT", "open-semantics interactive fill requires bound attempt authority");
  }
  input.options.signal?.throwIfAborted();
  if (input.prepared.config.apiKey === null || input.prepared.config.apiKey.trim().length === 0) {
    throw new AlayaError("UNAVAILABLE", "garden API key is unavailable");
  }
  const attemptOrdinal = await authority.reserveAttemptOrdinal(line.key, input.options.signal);
  let extracted: Awaited<ReturnType<typeof extractor.extract>>;
  try {
    extracted = await extractor.extract({
      systemPrompt: line.systemPrompt, userPrompt: line.userPrompt, retryMode: "disabled",
      timeoutMs: Math.max(resolveExtractionRequestTimeoutMs(maxOutputTokens), GEMINI_INTERACTIVE_TIMEOUT_FLOOR_MS),
      maxOutputTokens,
      outputTokenField: "maxOutputTokens",
      validateRawJson: () => undefined,
      ...(input.options.signal === undefined ? {} : { abortSignal: input.options.signal })
    });
  } catch (cause) {
    if (input.options.signal?.aborted === true) throw cause;
    if (isLocalPersistenceFailure(cause)) throw cause;
    const outcome = readLiveTransportFailure(cause);
    if (outcome === undefined || outcome.transportFailures.length === 0) throw cause;
    appendFileSync(join(input.cacheRoot, "interactive-extract-errors.log"),
      `${line.key}\t${cause instanceof Error ? cause.message : String(cause)}\n`);
    const response = readGeminiFailureResponse(cause);
    const raw = writeProviderRawAttempt({
      root: input.cacheRoot, cacheKey: line.key, attemptOrdinal, kind: "source_semantic",
      model: input.prepared.config.model, requestProfile: input.prepared.config.requestProfile,
      requestDigest: requestEnvelopeDigest(line.userPrompt), decodedText: "",
      finishReason: response?.finishReason ?? null,
      failureRetryable: !isCompletedNonRetryableResponse(outcome),
      failureClassification: outcome.terminalRetryClassification,
      ...(response === undefined ? {} : { responseBody: response.rawBody }),
      ...(outcome.transportFailures[0] === undefined ? {} : { transportFailure: outcome.transportFailures[0] }),
      ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
      ...(outcome.transportFailures[0]?.phase === undefined
        ? {} : { transportPhase: outcome.transportFailures[0].phase })
    });
    return importInteractiveFromRaw(input, line, sourceCorpus, raw);
  }
  const raw = writeProviderRawAttempt({
    root: input.cacheRoot, cacheKey: line.key, attemptOrdinal, kind: "source_semantic",
    model: input.prepared.config.model, requestProfile: input.prepared.config.requestProfile,
    requestDigest: requestEnvelopeDigest(line.userPrompt), decodedText: extracted.rawJson,
    finishReason: extracted.responseMetadata?.finishReason ?? null,
    ...(extracted.usage === undefined ? {} : { usage: extracted.usage })
  });
  return importInteractiveFromRaw(input, line, sourceCorpus, raw);
}

function isCompletedNonRetryableResponse(
  transport: NonNullable<ReturnType<typeof readLiveTransportFailure>>
): boolean {
  return transport.terminalRetryClassification === "failure_non_retryable_response" &&
    transport.transportFailures.some((item) =>
      item.phase === "response_schema" || item.phase === "response_parse");
}

function isLocalPersistenceFailure(cause: unknown): boolean {
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOSPC" || code === "EACCES" || code === "EPERM" || code === "EROFS" || code === "EEXIST";
}

type InteractiveExtracted = Readonly<{
  rawJson: string;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  responseMetadata?: { finishReason: string | null };
}>;

function importInteractiveLine(
  input: InteractiveFillInput,
  line: GeminiBatchLine,
  sourceCorpus: string,
  extracted: InteractiveExtracted,
  attemptOrdinal: number
): "admitted" | "quarantined" {
  const authority = input.authority!;
  const finishReason = extracted.responseMetadata?.finishReason ?? null;
  const provenance = {
    transport: "gemini-generate-content" as const, finishReason, attemptOrdinal,
    responseSha256: batchDigest(extracted.rawJson),
    ...(extracted.usage === undefined ? {} : { usage: extracted.usage })
  };
  if (!isCompleteGeminiFinish(finishReason)) {
    appendFileSync(join(input.cacheRoot, "interactive-extract-errors.log"),
      `${line.key}\tincomplete\tfinish_reason=${String(finishReason)}\n`);
    authority.abandonPendingShard(line.key, attemptOrdinal);
    recordInteractiveOutcome(authority, line.key, attemptOrdinal, extracted, "quarantined", provenance.responseSha256);
    return "quarantined";
  }
  try {
    importSourceSemanticArtifact({
      config: input.prepared.config, cacheRoot: input.cacheRoot, writeLease: input.writeLease,
      sourceCorpus, result: { line, rawJson: extracted.rawJson, provenance }
    });
  } catch (cause) {
    if (!(cause instanceof SourceSemanticAdmissionError)) throw cause;
    appendFileSync(join(input.cacheRoot, "interactive-extract-errors.log"),
      `${line.key}\tadmission\t${cause.message}\n`);
    authority.abandonPendingShard(line.key, attemptOrdinal);
    recordInteractiveOutcome(authority, line.key, attemptOrdinal, extracted, "quarantined", provenance.responseSha256);
    return "quarantined";
  }
  const inspected = inspectCachedExtractionArtifact(
    input.cacheRoot, line.key, input.prepared.config.model, input.prepared.config.requestProfile,
    extractionTypedArtifactMode(input.prepared.config)
  );
  if (inspected.status !== "hit") {
    // Admission completed; retain the shard reservation so intact raw can rebuild it without another request.
    recordInteractiveOutcome(authority, line.key, attemptOrdinal, extracted, "admitted");
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
  extracted: InteractiveExtracted,
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
  const authorityTelemetry = input.authority!.snapshot();
  return {
    requestedTurns: input.prepared.requestedTurns, cacheHits: workset.cachedRequests.length,
    newlyExtracted, coverage: completion.coverage, manifest,
    ...readFillRetryTelemetry({ ...newFillStats(), ...authorityTelemetry?.telemetry }), authorityTelemetry
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
