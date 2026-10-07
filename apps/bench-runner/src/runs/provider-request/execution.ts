import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { AlayaError } from "@do-soul/alaya-protocol";
import { readGeminiFailureResponse } from "../compile-seed/http/gemini-http.js";
import { GEMINI_INTERACTIVE_TIMEOUT_FLOOR_MS } from "../compile-seed/http/gemini-http.js";
import { readStepFailureResponse, STEP_SEMANTIC_REQUEST_PROFILE } from "../compile-seed/http/semantic-provider-http.js";
import { resolveExtractionRequestTimeoutMs } from "../compile-seed/http/output-token-retry.js";
import type { BenchSignalExtractor, CompileSeedExtractionConfig } from "../compile-seed/compile-seed-types.js";
import type { ExtractionAttemptLedgerSnapshot } from "../extraction/authority/attempt-ledger.js";
import type { ExtractionTransportOutcome } from "../extraction/authority/attempt-ledger/outcome.js";
import { assertStepReportedUsage, baseReportedUsage } from "../extraction/authority/step-quote.js";
import type { ExtractionCacheWriteLease } from "../extraction/fill/manifest/fill-root-guard.js";
import {
  listProviderRawAttempts, readProviderRawAttempt, writeProviderRawAttempt,
  retainedFailureOutcome, providerRawSuccessEvidenceState, type ProviderRawAttempt, type RawAttemptOwner
} from "../extraction/fill/provider-raw-attempt.js";
import { readLiveTransportFailure } from "../extraction/cache/cache-live-delegate.js";

export type ProviderRequestAttemptClass =
  | "interpreted" | "abstained" | "retryable" | "terminal" | "incomplete" | "unknown" | "pending";

export type ProviderRequestLine = Readonly<{
  key: string;
  kind: Extract<RawAttemptOwner["kind"], "query" | "semantic_correspondence" | "source_evidence_selection" | "source_evidence_preservation" | "page_support_comparison">;
  systemPrompt: string;
  userPrompt: string;
  responseJsonSchema: object;
  requestDigest: string;
  inputByteUpper: number;
}>;

export type ProviderRequestDecoded = Readonly<{
  rawJson: string;
  finishReason: string | null;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}>;

export type ProviderRequestLedger = {
  reserveAttemptOrdinal(cacheKey: string): number;
  recordTransportOutcome(
    cacheKey: string, outcome: ExtractionTransportOutcome, attemptOrdinal?: number
  ): boolean;
  abandonPendingShard(cacheKey: string, attemptOrdinal?: number): void;
  commitSuccessfulShard(cacheKey: string): void;
  snapshot(): ExtractionAttemptLedgerSnapshot;
};

export type ProviderRequestPhysicalContext = Readonly<{
  cacheRoot: string;
  model: string;
  requestProfile: string;
  attemptLineageDigest: string;
  maxOutputTokens: number;
  maximumAttemptsPerKey: number;
  /** Verified settled ancestry is retained separately from this child lineage's raw namespace. */
  settledPredecessorAttemptOrdinals?: ReadonlySet<number>;
  continuationLineageDigest?: string;
  ledger: ProviderRequestLedger;
  assertReservation: (raw: ProviderRawAttempt) => void;
  interpretDecoded: (line: ProviderRequestLine, decoded: ProviderRequestDecoded) => {
    classified: ProviderRequestAttemptClass;
    admitted: boolean;
    outcome: unknown;
  };
  publishArtifact: (input: Readonly<{
    line: ProviderRequestLine;
    rawJson: string;
    usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
    outcome: unknown;
    admitted: boolean;
    attemptOrdinal: number;
    finishReason: string | null;
  }>) => void;
}>;

export type ProviderRequestDispatchContext = ProviderRequestPhysicalContext & Readonly<{
  writeLease: ExtractionCacheWriteLease;
  extractor: BenchSignalExtractor;
  config: CompileSeedExtractionConfig;
  suppliedExtractor: boolean;
  assertScope: () => void;
}>;

type ReplayProgress =
  | {
      readonly done: true;
      readonly classified: ProviderRequestAttemptClass;
      readonly admitted: boolean;
      readonly attempts: number;
    }
  | { readonly done: false; readonly attempts: number };

export async function executeProviderRequestLine(
  context: ProviderRequestDispatchContext, line: ProviderRequestLine
): Promise<{ classified: ProviderRequestAttemptClass; admitted: boolean; attempts: number }> {
  const replayed = replayExistingProviderRequestRaws(context, line);
  if (replayed.done) {
    return { classified: replayed.classified, admitted: replayed.admitted, attempts: replayed.attempts };
  }
  let used = replayed.attempts;
  const attemptLimit = context.maximumAttemptsPerKey;
  while (used < attemptLimit) {
    if (remainingProviderRequestSlots(context.ledger) <= 0) {
      return { classified: "retryable", admitted: false, attempts: used };
    }
    if (!context.suppliedExtractor && (context.config.apiKey === null || context.config.apiKey.trim().length === 0)) {
      throw new AlayaError("UNAVAILABLE", "garden API key is unavailable");
    }
    context.assertScope();
    const ordinal = context.ledger.reserveAttemptOrdinal(line.key);
    used += 1;
    const lastAttempt = isFinalReservedProviderRequestAttempt(context.ledger, line.key, ordinal, attemptLimit);
    let extracted: Awaited<ReturnType<BenchSignalExtractor["extract"]>>;
    try {
      extracted = await context.extractor.extract({
        systemPrompt: line.systemPrompt, userPrompt: line.userPrompt, retryMode: "disabled",
        timeoutMs: Math.max(resolveExtractionRequestTimeoutMs(context.maxOutputTokens), GEMINI_INTERACTIVE_TIMEOUT_FLOOR_MS),
        maxOutputTokens: context.maxOutputTokens,
        outputTokenField: context.config.requestProfile === STEP_SEMANTIC_REQUEST_PROFILE
          ? "max_tokens" : "maxOutputTokens",
        validateRawJson: () => undefined, responseJsonSchema: line.responseJsonSchema,
        ...(context.requestProfile === STEP_SEMANTIC_REQUEST_PROFILE
          ? { retainHttpResponseEvidence: true as const } : {})
      });
    } catch (cause) {
      if (isLocalPersistenceFailure(cause)) throw cause;
      const transport = readLiveTransportFailure(cause);
      if (transport === undefined || transport.transportFailures.length === 0) throw cause;
      appendFileSync(join(context.cacheRoot, "interactive-extract-errors.log"),
        `${line.key}\t${cause instanceof Error ? cause.message : String(cause)}\n`);
      const settled = persistFailedProviderRequest(context, line, transport, ordinal, used,
        readGeminiFailureResponse(cause), readStepFailureResponse(cause), lastAttempt);
      if (settled.classified !== "retryable" || lastAttempt) return settled;
      continue;
    }
    const raw = retainProviderRequestRaw(context, line, ordinal, {
      decodedText: extracted.rawJson,
      finishReason: extracted.responseMetadata?.finishReason ?? null,
      ...(extracted.usage === undefined ? {} : { usage: extracted.usage }),
      ...(extracted.responseBody === undefined ? {} : { responseBody: extracted.responseBody }),
      ...(extracted.httpResponse === undefined ? {} : { httpResponse: extracted.httpResponse })
    });
    const settled = replayPersistedProviderRequestRaw(context, line, raw, lastAttempt);
    if (settled.classified !== "retryable" || lastAttempt) {
      return { ...settled, attempts: used };
    }
  }
  return { classified: "terminal", admitted: false, attempts: used };
}

export function replayExistingProviderRequestRaws(
  context: ProviderRequestPhysicalContext, line: ProviderRequestLine
): ReplayProgress {
  const attemptLimit = context.maximumAttemptsPerKey;
  const processed = new Set<number>();
  const snapshot = context.ledger.snapshot();
  const used = reservedProviderRequestOrdinals(snapshot, line.key).size;
  const raws = listProviderRawAttempts(context.cacheRoot, line.key, context.continuationLineageDigest);
  const rawOrdinals = new Set(raws.map((item) => item.attempt_ordinal));
  const unresolved = snapshot.unresolvedAttempts.filter((item) => item.cacheKey === line.key);
  const missingSettled = [...snapshot.settledAttempts, ...snapshot.transportFailures]
    .some(attempt => attempt.cacheKey === line.key && !rawOrdinals.has(attempt.attemptOrdinal) &&
      !context.settledPredecessorAttemptOrdinals?.has(attempt.attemptOrdinal));
  if (missingSettled) {
    return { done: true, classified: "incomplete", admitted: false, attempts: used };
  }
  if (snapshot.pendingKeys.includes(line.key) && raws.length === 0 && unresolved.length === 0 &&
      !snapshot.transportFailures.some(attempt => attempt.cacheKey === line.key)) {
    return { done: true, classified: "pending", admitted: false, attempts: 0 };
  }
  for (const pending of unresolved) {
    const raw = readProviderRawAttempt(context.cacheRoot, line.key, pending.attemptOrdinal,
      context.continuationLineageDigest);
    processed.add(pending.attemptOrdinal);
    if (raw === undefined) return { done: true, classified: "unknown", admitted: false, attempts: used };
    const lastAttempt = isFinalReservedProviderRequestAttempt(context.ledger, line.key, raw.attempt_ordinal, attemptLimit);
    const settled = replayPersistedProviderRequestRaw(context, line, raw, lastAttempt);
    if (settled.classified !== "retryable" || lastAttempt) {
      return { done: true, classified: settled.classified, admitted: settled.admitted, attempts: used };
    }
  }
  for (const raw of raws) {
    if (processed.has(raw.attempt_ordinal)) continue;
    processed.add(raw.attempt_ordinal);
    const lastAttempt = isFinalReservedProviderRequestAttempt(context.ledger, line.key, raw.attempt_ordinal, attemptLimit);
    const settled = replayPersistedProviderRequestRaw(context, line, raw, lastAttempt);
    if (settled.classified !== "retryable" || lastAttempt) {
      return { done: true, classified: settled.classified, admitted: settled.admitted, attempts: used };
    }
  }
  return { done: false, attempts: used };
}

function remainingProviderRequestSlots(ledger: ProviderRequestLedger): number {
  const snapshot = ledger.snapshot();
  return snapshot.maximumAttempts - snapshot.attempts;
}

function isFinalReservedProviderRequestAttempt(
  ledger: ProviderRequestLedger, cacheKey: string, ordinal: number, attemptLimit: number
): boolean {
  const snapshot = ledger.snapshot();
  const reserved = reservedProviderRequestOrdinals(snapshot, cacheKey);
  const laterReservation = [...reserved].some(attemptOrdinal => attemptOrdinal > ordinal);
  return !laterReservation && (reserved.size >= attemptLimit || snapshot.attempts >= snapshot.maximumAttempts);
}

function reservedProviderRequestOrdinals(
  snapshot: ExtractionAttemptLedgerSnapshot, cacheKey: string
): ReadonlySet<number> {
  return new Set([...snapshot.unresolvedAttempts, ...snapshot.settledAttempts, ...snapshot.transportFailures]
    .filter(attempt => attempt.cacheKey === cacheKey).map(attempt => attempt.attemptOrdinal));
}

function replayPersistedProviderRequestRaw(
  context: ProviderRequestPhysicalContext,
  line: ProviderRequestLine,
  raw: ProviderRawAttempt,
  lastAttempt: boolean
): { classified: ProviderRequestAttemptClass; admitted: boolean } {
  context.assertReservation(raw);
  assertStepReportedUsage(context.requestProfile, raw.usage, context.maxOutputTokens);
  const failure = retainedFailureOutcome(raw);
  if (failure !== undefined) {
    if (raw.failure_retryable !== true || lastAttempt) {
      publishPhysicalFailure(context, line, raw, { status: "transport_failure", failure: raw.transport_failure }, false);
    }
    context.ledger.recordTransportOutcome(line.key, failure, raw.attempt_ordinal);
    context.ledger.abandonPendingShard(line.key, raw.attempt_ordinal);
    return { classified: raw.failure_retryable === true ? "retryable" : "terminal", admitted: false };
  }
  if (!raw.full_replay_possible) {
    publishPhysicalFailure(context, line, raw, { status: "invalid", reason: "truncated_raw" }, false);
    context.ledger.recordTransportOutcome(line.key, settledProviderRequestOutcome(baseReportedUsage(raw.usage)), raw.attempt_ordinal);
    context.ledger.abandonPendingShard(line.key, raw.attempt_ordinal);
    return { classified: "incomplete", admitted: false };
  }
  const physicalEvidence = providerRawSuccessEvidenceState(raw);
  if (physicalEvidence !== "bound") {
    publishPhysicalFailure(context, line, raw, {
      status: "invalid",
      reason: physicalEvidence === "missing" ? "missing_response_body" :
        physicalEvidence === "truncated" ? "truncated_response_body" : "unsupported_response_body"
    }, false);
    context.ledger.recordTransportOutcome(line.key, settledProviderRequestOutcome(baseReportedUsage(raw.usage)), raw.attempt_ordinal);
    context.ledger.abandonPendingShard(line.key, raw.attempt_ordinal);
    return { classified: "incomplete", admitted: false };
  }
  return settleDecodedProviderRequest(context, line, {
    rawJson: raw.decoded_text,
    finishReason: raw.finish_reason,
    usage: baseReportedUsage(raw.usage)
  }, raw.attempt_ordinal, lastAttempt);
}

function settleDecodedProviderRequest(
  context: ProviderRequestPhysicalContext,
  line: ProviderRequestLine,
  decoded: ProviderRequestDecoded,
  ordinal: number,
  lastAttempt: boolean
): { classified: ProviderRequestAttemptClass; admitted: boolean } {
  const interpreted = context.interpretDecoded(line, decoded);
  const persistShard = interpreted.classified !== "retryable" || lastAttempt;
  if (persistShard) {
    context.publishArtifact({
      line, rawJson: decoded.rawJson, usage: decoded.usage, outcome: interpreted.outcome,
      admitted: interpreted.admitted, attemptOrdinal: ordinal, finishReason: decoded.finishReason
    });
  }
  context.ledger.recordTransportOutcome(line.key, settledProviderRequestOutcome(decoded.usage), ordinal);
  if (persistShard) {
    if (interpreted.admitted) context.ledger.commitSuccessfulShard(line.key);
    else context.ledger.abandonPendingShard(line.key, ordinal);
  }
  return { classified: interpreted.classified, admitted: interpreted.admitted };
}

function persistFailedProviderRequest(
  context: ProviderRequestDispatchContext,
  line: ProviderRequestLine,
  transport: NonNullable<ReturnType<typeof readLiveTransportFailure>>,
  ordinal: number,
  used: number,
  response: ReturnType<typeof readGeminiFailureResponse>,
  stepResponse: ReturnType<typeof readStepFailureResponse>,
  lastAttempt: boolean
): { classified: ProviderRequestAttemptClass; admitted: boolean; attempts: number } {
  const usage = transport.usage;
  const phase = transport.transportFailures[0]?.phase;
  const raw = retainProviderRequestRaw(context, line, ordinal, {
    decodedText: "",
    finishReason: response?.finishReason ?? null,
    ...(response === undefined ? {} : { responseBody: response.rawBody }),
    ...(stepResponse === undefined ? {} : { httpResponse: stepResponse }),
    ...(transport.transportFailures[0] === undefined ? {} : { transportFailure: transport.transportFailures[0] }),
    failureRetryable: !isCompletedNonRetryableResponse(transport),
    ...(transport.terminalRetryClassification === undefined ? {} : { failureClassification: transport.terminalRetryClassification }),
    ...(usage === undefined ? {} : { usage }),
    ...(phase === undefined ? {} : { transportPhase: phase })
  });
  return { ...replayPersistedProviderRequestRaw(context, line, raw, lastAttempt), attempts: used };
}

function retainProviderRequestRaw(
  context: ProviderRequestPhysicalContext,
  line: ProviderRequestLine,
  ordinal: number,
  fields: Omit<Parameters<typeof writeProviderRawAttempt>[0],
    "root" | "cacheKey" | "attemptOrdinal" | "kind" | "model" | "requestProfile" | "requestDigest" | "attemptLineageDigest">
): ProviderRawAttempt {
  return writeProviderRawAttempt({
    root: context.cacheRoot, cacheKey: line.key, attemptOrdinal: ordinal, kind: line.kind,
    model: context.model, requestProfile: context.requestProfile,
    requestDigest: line.requestDigest, attemptLineageDigest: context.attemptLineageDigest,
    ...(context.continuationLineageDigest === undefined ? {} : {
      continuationLineageDigest: context.continuationLineageDigest }),
    ...fields
  });
}

function publishPhysicalFailure(
  context: ProviderRequestPhysicalContext,
  line: ProviderRequestLine,
  raw: ProviderRawAttempt,
  outcome: unknown,
  admitted: boolean
): void {
  context.publishArtifact({
    line, rawJson: raw.decoded_text, usage: baseReportedUsage(raw.usage), outcome, admitted,
    attemptOrdinal: raw.attempt_ordinal, finishReason: raw.finish_reason
  });
}

function settledProviderRequestOutcome(
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined
): ExtractionTransportOutcome {
  return {
    retryCount: 0, rateLimitRetries: 0, successfulRequestCount: 1,
    usageRequestCount: usage === undefined ? 0 : 1,
    ...(usage === undefined ? {} : { usage })
  };
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
