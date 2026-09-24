import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  admitSourceSemanticCorrespondence, admitSourceSemanticQuery, refuseRecallCampaignLiveExtraction
} from "@do-soul/alaya-core";
import { AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import {
  proposeCorrespondenceSemantics, proposeQuerySemantics,
  type SourceSemanticCorrespondenceRequest, type SourceSemanticQueryRequest
} from "@do-soul/alaya-soul";
import { readGeminiFailureResponse } from "../compile-seed/http/gemini-http.js";
import { createSemanticProviderHttpExtractor, isCompleteSemanticFinish,
  readStepFailureResponse, STEP_SEMANTIC_REQUEST_PROFILE } from "../compile-seed/http/semantic-provider-http.js";
import { GEMINI_INTERACTIVE_TIMEOUT_FLOOR_MS } from "../compile-seed/http/gemini-http.js";
import { resolveExtractionRequestTimeoutMs } from "../compile-seed/http/output-token-retry.js";
import type { CompileSeedExtractionConfig } from "../compile-seed/compile-seed-types.js";
import { assertAttemptInputWithinReceiptLimit } from "../extraction/authority/receipt-limits.js";
import { acquireExtractionCacheWriteLease, type ExtractionCacheWriteLease } from "../extraction/fill/manifest/fill-root-guard.js";
import { assertStepReportedUsage, baseReportedUsage } from "../extraction/authority/step-quote.js";
import {
  listProviderRawAttempts, readProviderRawAttempt,
  writeProviderRawAttempt, retainedFailureOutcome, providerRawSuccessEvidenceState, type ProviderRawAttempt
} from "../extraction/fill/provider-raw-attempt.js";
import { readLiveTransportFailure } from "../extraction/cache/cache-live-delegate.js";
import {
  type SemanticProposalLine, type SemanticProposalWorkset,
  materializeSemanticProposalLines, semanticProposalRequestBinding
} from "./workset.js";
import {
  type SemanticProposalAuthority, buildSemanticProposalPreflight, verifySemanticProposalAuthority,
  assertSemanticProposalExecutionScope, inspectSemanticProposalExecutionScope
} from "./authority.js";
import { openSemanticProposalAttemptLedger, readSemanticProposalAttemptState, assertProposalRawReservation,
  semanticProposalLookup } from "./attempt.js";
import {
  hasAdmittedProposalOutcome, hasVerifiedProposalCompletion, proposalOutcomeStatus,
  writeSemanticProposalShard, SEMANTIC_PROPOSAL_CACHE_CONTRACT, SemanticProposalIdentityError,
  type SemanticProposalShard
} from "./artifact.js";

export type ProposalAttemptClass = "interpreted" | "abstained" | "retryable" | "terminal" | "incomplete" | "unknown" | "pending";

export function classifyProposalOutcome(
  outcome: Readonly<{ status: string; reason?: string }>,
  finishReason?: string | null,
  requestProfile = "gemini-2.5-nonthinking-v1"
): ProposalAttemptClass {
  if (finishReason !== undefined && !isCompleteSemanticFinish(requestProfile, finishReason)) return "incomplete";
  if (outcome.status === "interpreted") return "interpreted";
  if (outcome.status === "abstained") return "abstained";
  if (outcome.status === "transport_failure") return "retryable";
  if (outcome.status === "invalid" && outcome.reason === "malformed_json") return "retryable";
  return "terminal";
}

export function prepareSemanticProposal(
  workset: SemanticProposalWorkset, cacheRoot: string, maxOutputTokens: number, maxAttemptsPerKey?: number
) {
  const lines = materializeSemanticProposalLines(workset, maxOutputTokens);
  const cachedKeys = new Set<string>();
  for (const line of lines) {
    const state = readSemanticProposalAttemptState(cacheRoot, line.key, semanticProposalLookup(workset, line, maxOutputTokens));
    const existing = state.shard;
    if (existing !== undefined) {
      if (state.status !== "settled") {
        throw new AlayaError("CONFLICT", `semantic proposal ${line.key} requires fill recovery with its existing authority before preflight`);
      }
      replayCachedProposalShard(line, existing);
      cachedKeys.add(line.key);
    }
  }
  return buildSemanticProposalPreflight({
    kind: workset.kind, model: workset.model, request_profile: workset.request_profile,
    maxOutputTokens, maxAttemptsPerKey, lines, cachedKeys, executionScope: inspectSemanticProposalExecutionScope(cacheRoot)
  });
}

export async function executeSemanticProposalFill(input: Readonly<{
  workset: SemanticProposalWorkset;
  cacheRoot: string;
  authority: SemanticProposalAuthority;
  config: CompileSeedExtractionConfig;
  extractor?: ReturnType<typeof createSemanticProviderHttpExtractor>;
}>) {
  refuseRecallCampaignLiveExtraction("extraction_write");
  const authority = verifySemanticProposalAuthority(input.authority);
  assertSemanticProposalExecutionScope(authority.execution_scope, input.cacheRoot);
  input = { ...input, authority, cacheRoot: authority.execution_scope.execution_root_path };
  if (authority.kind !== input.workset.kind || authority.model !== input.workset.model ||
      authority.request_profile !== input.workset.request_profile) {
    throw new AlayaError("CONFLICT", "semantic proposal authority does not bind this workset");
  }
  const maxOutputTokens = authority.limits.max_output_tokens;
  const lines = materializeSemanticProposalLines(input.workset, maxOutputTokens);
  assertAuthorizedProposalRequest(input, lines, maxOutputTokens);
  const authorized = new Set(authority.keys);
  const dispatch: SemanticProposalLine[] = [];
  const retainedLines: SemanticProposalLine[] = [];
  let cacheHits = 0;
  for (const line of lines) {
    const existing = readSemanticProposalAttemptState(
      input.cacheRoot, line.key, semanticProposalLookup(input.workset, line, maxOutputTokens)
    ).shard;
    if (existing !== undefined) {
      const prior = replayCachedProposalShard(line, existing);
      if (input.workset.request_profile === STEP_SEMANTIC_REQUEST_PROFILE &&
          prior !== "interpreted" && prior !== "abstained") {
        throw new AlayaError("CONFLICT", `Step proposal fill stopped after retained ${prior} for ${line.key}`);
      }
      cacheHits += 1;
      if (authorized.has(line.key)) retainedLines.push(line);
      continue;
    }
    if (!authorized.has(line.key)) {
      continue;
    }
    dispatch.push(line);
  }
  if (dispatch.length > 0 && authority.limits.maximum_attempts === 0) {
    throw new AlayaError("CONFLICT", "semantic proposal authority has no remaining provider attempt capacity");
  }
  if (dispatch.length === 0 && retainedLines.length === 0) {
    return summarize(input, cacheHits, 0, 0);
  }
  const lease = acquireExtractionCacheWriteLease(input.cacheRoot);
  try {
    assertSemanticProposalExecutionScope(authority.execution_scope, input.cacheRoot, lease);
    input = { ...input, cacheRoot: lease.stableRootPath };
    const ledger = openSemanticProposalAttemptLedger({
      cacheRoot: input.cacheRoot, authority, kind: input.workset.kind, writeLease: lease
    });
    for (const line of retainedLines) {
      if (!ledger.snapshot().pendingKeys.includes(line.key) &&
          !ledger.snapshot().unresolvedAttempts.some((item) => item.cacheKey === line.key)) continue;
      const replayed = replayExistingProposalRaws(input, line, ledger);
      if (input.workset.request_profile === STEP_SEMANTIC_REQUEST_PROFILE && replayed.done &&
          replayed.classified !== "interpreted" && replayed.classified !== "abstained") {
        throw new AlayaError("CONFLICT", `Step proposal fill stopped after retained ${replayed.classified} for ${line.key}`);
      }
      if (ledger.snapshot().pendingKeys.includes(line.key) ||
          ledger.snapshot().unresolvedAttempts.some((item) => item.cacheKey === line.key)) {
        throw new SemanticProposalIdentityError(`retained proposal has unresolved attempt evidence: ${line.key}`);
      }
    }
    const extractor = dispatch.length === 0 ? undefined : input.extractor ??
      createSemanticProviderHttpExtractor(input.config, "source_semantic_proposal");
    let newlyAdmitted = 0, attempts = 0;
    for (const line of dispatch) {
      assertAttemptInputWithinReceiptLimit(line.inputByteUpper, authority.price.maximum_input_tokens_per_attempt);
      const filled = await fillLine(input, line, extractor!, ledger, maxOutputTokens, lease);
      attempts += filled.attempts;
      if (input.workset.request_profile === STEP_SEMANTIC_REQUEST_PROFILE &&
          filled.classified !== "interpreted" && filled.classified !== "abstained") {
        throw new AlayaError("CONFLICT", `Step proposal fill stopped after ${filled.classified} for ${line.key}`);
      }
      if (filled.admitted) {
        newlyAdmitted += 1;
      }
    }
    return summarize(input, cacheHits, newlyAdmitted, attempts);
  } finally {
    lease.release();
  }
}

function summarize(
  input: Parameters<typeof executeSemanticProposalFill>[0], cacheHits: number, newlyAdmitted: number, attempts: number
) {
  const rows = readSemanticProposalResults(input.workset, input.cacheRoot, input.authority.limits.max_output_tokens);
  const count = (...statuses: readonly string[]) => rows.filter(row => statuses.includes(row.status)).length;
  return {
    requested: rows.length, cache_hits: cacheHits, newly_admitted: newlyAdmitted,
    terminal_failures: count("transport_failure"), resource_exhausted: count("resource_exhausted"),
    attempts, interpreted: count("interpreted"),
    abstained: count("abstained"), cached_invalid: rows.filter(row => row.shard !== undefined &&
      ["invalid", "core_rejected", "incomplete", "transport_failure"].includes(row.status)).length,
    unattempted: count("unattempted"), unknown: count("unknown"), pending: count("pending"),
    incomplete: count("incomplete"), rejected: count("invalid", "core_rejected")
  };
}

function assertAuthorizedProposalRequest(
  input: Parameters<typeof executeSemanticProposalFill>[0], lines: readonly SemanticProposalLine[], maxOutputTokens: number
): void {
  if (input.config.model !== input.workset.model || input.config.requestProfile !== input.workset.request_profile) {
    throw new AlayaError("CONFLICT", "semantic proposal execution config differs from authorized model/profile");
  }
  for (const line of lines) {
    const actual = semanticProposalRequestBinding(input.config, { systemPrompt: line.systemPrompt,
      userPrompt: line.userPrompt, responseJsonSchema: line.responseJsonSchema, maxOutputTokens });
    if (actual.requestDigest !== line.requestDigest ||
        canonicalJson(actual.transportProvenance) !== canonicalJson(line.transportProvenance) ||
        canonicalJson(line.transportProvenance) !== canonicalJson(input.authority.transport_provenance)) {
      throw new AlayaError("CONFLICT", "semantic proposal actual HTTP request differs from authorized request");
    }
  }
}

/** Offline consumers use the same exact-request lookup, receiver and Core admission as fill. */
export function readSemanticProposalResults(workset: SemanticProposalWorkset, cacheRoot: string, maxOutputTokens: number) {
  return materializeSemanticProposalLines(workset, maxOutputTokens).map((line) => {
    const state = readSemanticProposalAttemptState(cacheRoot, line.key, semanticProposalLookup(workset, line, maxOutputTokens));
    const shard = state.shard;
    if (state.status !== "settled") return { line, shard, status: state.status };
    if (shard === undefined) return { line, status: "unattempted" as const };
    replayCachedProposalShard(line, shard);
    if (!hasAdmittedProposalOutcome(shard)) {
      const outcome = proposalOutcomeStatus(shard);
      // Retry/cache classification is not a semantic outcome. In particular,
      // absent decoded text on a failed HTTP attempt is not valid-empty output.
      const status = outcome === "transport_failure" ? outcome : !hasVerifiedProposalCompletion(shard) ||
        typeof shard.outcome === "object" && shard.outcome !== null &&
        "reason" in shard.outcome && ["truncated_raw", "missing_response_body", "truncated_response_body",
          "unsupported_response_body"].includes(String(shard.outcome.reason)) ? "incomplete"
        : outcome !== "interpreted" ? outcome
        : hasVerifiedProposalCompletion(shard) ? "core_rejected" : "incomplete";
      return { line, shard, status };
    }
    const received = receiveLine(line, shard.raw_json);
    if (!isCoreAdmittedProposal(line, received)) throw new SemanticProposalIdentityError("cached proposal no longer admits");
    return { line, shard, received, status: "interpreted" as const };
  });
}

type ProposalLedger = ReturnType<typeof openSemanticProposalAttemptLedger>;

async function fillLine(
  input: Parameters<typeof executeSemanticProposalFill>[0],
  line: SemanticProposalLine,
  extractor: ReturnType<typeof createSemanticProviderHttpExtractor>,
  ledger: ProposalLedger,
  maxOutputTokens: number,
  writeLease: ExtractionCacheWriteLease
): Promise<{ classified: ProposalAttemptClass; admitted: boolean; attempts: number }> {
  const replayed = replayExistingProposalRaws(input, line, ledger);
  if (replayed.done) {
    return { classified: replayed.classified, admitted: replayed.admitted, attempts: replayed.attempts };
  }
  let used = replayed.attempts;
  const attemptLimit = input.authority.limits.maximum_attempts_per_key;
  while (used < attemptLimit) {
    const remainingGlobal = remainingProposalSlots(ledger);
    if (remainingGlobal <= 0) {
      return { classified: "retryable", admitted: false, attempts: used };
    }
    if (input.extractor === undefined && (input.config.apiKey === null || input.config.apiKey.trim().length === 0)) {
      throw new AlayaError("UNAVAILABLE", "garden API key is unavailable");
    }
    assertSemanticProposalExecutionScope(input.authority.execution_scope, input.cacheRoot, writeLease);
    const ordinal = ledger.reserveAttemptOrdinal(line.key);
    used += 1;
    const lastAttempt = isFinalReservedProposalAttempt(ledger, line.key, ordinal, attemptLimit);
    let extracted: Awaited<ReturnType<typeof extractor.extract>>;
    try {
      extracted = await extractor.extract({
        systemPrompt: line.systemPrompt, userPrompt: line.userPrompt, retryMode: "disabled",
        timeoutMs: Math.max(resolveExtractionRequestTimeoutMs(maxOutputTokens), GEMINI_INTERACTIVE_TIMEOUT_FLOOR_MS),
        maxOutputTokens, outputTokenField: input.config.requestProfile === STEP_SEMANTIC_REQUEST_PROFILE
          ? "max_tokens" : "maxOutputTokens",
        validateRawJson: () => undefined, responseJsonSchema: line.responseJsonSchema
      });
    } catch (cause) {
      if (isLocalPersistenceFailure(cause)) throw cause;
      const transport = readLiveTransportFailure(cause);
      if (transport === undefined || transport.transportFailures.length === 0) throw cause;
      appendFileSync(join(input.cacheRoot, "interactive-extract-errors.log"),
        `${line.key}\t${cause instanceof Error ? cause.message : String(cause)}\n`);
      const settled = persistFailedExtract(input, line, ledger, transport, ordinal, used,
        readGeminiFailureResponse(cause), readStepFailureResponse(cause), lastAttempt);
      if (settled.classified !== "retryable" || lastAttempt) return settled;
      continue;
    }
    const raw = writeProviderRawAttempt({
      root: input.cacheRoot, cacheKey: line.key, attemptOrdinal: ordinal, kind: line.kind,
      model: input.workset.model, requestProfile: input.workset.request_profile,
      requestDigest: line.requestDigest, attemptLineageDigest: input.authority.attempt_lineage_digest,
      decodedText: extracted.rawJson,
      finishReason: extracted.responseMetadata?.finishReason ?? null,
      ...(extracted.usage === undefined ? {} : { usage: extracted.usage }),
      ...(extracted.responseBody === undefined ? {} : { responseBody: extracted.responseBody }),
      ...(extracted.httpResponse === undefined ? {} : { httpResponse: extracted.httpResponse })
    });
    const settled = replayPersistedProposalRaw(input, line, ledger, raw, lastAttempt);
    if (settled.classified !== "retryable" || lastAttempt) {
      return { ...settled, attempts: used };
    }
  }
  return { classified: "terminal", admitted: false, attempts: used };
}

type ProposalReplayProgress =
  | {
      readonly done: true;
      readonly classified: ProposalAttemptClass;
      readonly admitted: boolean;
      readonly attempts: number;
    }
  | { readonly done: false; readonly attempts: number };

function remainingProposalSlots(ledger: ProposalLedger): number {
  const snapshot = ledger.snapshot();
  return snapshot.maximumAttempts - snapshot.attempts;
}

function isFinalReservedProposalAttempt(
  ledger: ProposalLedger, cacheKey: string, ordinal: number, attemptLimit: number
): boolean {
  const snapshot = ledger.snapshot();
  const reserved = proposalReservedOrdinals(snapshot, cacheKey);
  const laterReservation = [...reserved].some(attemptOrdinal => attemptOrdinal > ordinal);
  // Exhausted capacity cannot make an older raw supersede a later reserved response.
  return !laterReservation && (reserved.size >= attemptLimit || snapshot.attempts >= snapshot.maximumAttempts);
}

function proposalReservedOrdinals(snapshot: ReturnType<ProposalLedger["snapshot"]>, cacheKey: string): ReadonlySet<number> {
  return new Set([...snapshot.unresolvedAttempts, ...snapshot.settledAttempts, ...snapshot.transportFailures]
    .filter(attempt => attempt.cacheKey === cacheKey).map(attempt => attempt.attemptOrdinal));
}

function replayExistingProposalRaws(
  input: Parameters<typeof executeSemanticProposalFill>[0],
  line: SemanticProposalLine,
  ledger: ProposalLedger
): ProposalReplayProgress {
  const attemptLimit = input.authority.limits.maximum_attempts_per_key;
  const processed = new Set<number>();
  const snapshot = ledger.snapshot();
  const used = proposalReservedOrdinals(snapshot, line.key).size;
  const raws = listProviderRawAttempts(input.cacheRoot, line.key);
  const rawOrdinals = new Set(raws.map((item) => item.attempt_ordinal));
  const unresolved = snapshot.unresolvedAttempts.filter((item) => item.cacheKey === line.key);
  // A failure record still spends its ordinal. Its lost raw cannot prove the
  // retry disposition, including when an older ledger has no settled witness.
  const missingSettled = [...snapshot.settledAttempts, ...snapshot.transportFailures]
    .some(attempt => attempt.cacheKey === line.key && !rawOrdinals.has(attempt.attemptOrdinal));
  if (missingSettled) {
    return { done: true, classified: "incomplete", admitted: false, attempts: used };
  }
  if (snapshot.pendingKeys.includes(line.key) && raws.length === 0 && unresolved.length === 0 &&
      !snapshot.transportFailures.some(attempt => attempt.cacheKey === line.key)) {
    // Legacy aggregate counts cannot reconstruct a lost exact reservation.
    return { done: true, classified: "pending", admitted: false, attempts: 0 };
  }
  for (const pending of unresolved) {
    const raw = readProviderRawAttempt(input.cacheRoot, line.key, pending.attemptOrdinal);
    processed.add(pending.attemptOrdinal);
    if (raw === undefined) return { done: true, classified: "unknown", admitted: false, attempts: used };
    const lastAttempt = isFinalReservedProposalAttempt(ledger, line.key, raw.attempt_ordinal, attemptLimit);
    const settled = replayPersistedProposalRaw(
      input, line, ledger, raw, lastAttempt
    );
    if (settled.classified !== "retryable" || lastAttempt) {
      return { done: true, classified: settled.classified, admitted: settled.admitted, attempts: used };
    }
  }
  for (const raw of raws) {
    if (processed.has(raw.attempt_ordinal)) continue;
    processed.add(raw.attempt_ordinal);
    const lastAttempt = isFinalReservedProposalAttempt(ledger, line.key, raw.attempt_ordinal, attemptLimit);
    const settled = replayPersistedProposalRaw(
      input, line, ledger, raw, lastAttempt
    );
    if (settled.classified !== "retryable" || lastAttempt) {
      return { done: true, classified: settled.classified, admitted: settled.admitted, attempts: used };
    }
  }
  return { done: false, attempts: used };
}

function replayPersistedProposalRaw(
  input: Parameters<typeof executeSemanticProposalFill>[0],
  line: SemanticProposalLine,
  ledger: ProposalLedger,
  raw: ProviderRawAttempt,
  lastAttempt: boolean
): { classified: ProposalAttemptClass; admitted: boolean } {
  assertProposalRawReservation(raw, ledger.snapshot(), semanticProposalLookup(input.workset, line, input.authority.limits.max_output_tokens), line.key);
  assertStepReportedUsage(input.workset.request_profile, raw.usage, input.authority.limits.max_output_tokens);
  const failure = retainedFailureOutcome(raw);
  if (failure !== undefined) {
    if (raw.failure_retryable !== true || lastAttempt) writeAttempt(input, line, raw.decoded_text, baseReportedUsage(raw.usage),
      { status: "transport_failure", failure: raw.transport_failure }, false, raw.attempt_ordinal, raw.finish_reason);
    ledger.recordTransportOutcome(line.key, failure, raw.attempt_ordinal);
    ledger.abandonPendingShard(line.key, raw.attempt_ordinal);
    return { classified: raw.failure_retryable === true ? "retryable" : "terminal", admitted: false };
  }
  if (!raw.full_replay_possible) {
    const usage = baseReportedUsage(raw.usage);
    writeAttempt(input, line, raw.decoded_text, usage,
      { status: "invalid", reason: "truncated_raw" }, false, raw.attempt_ordinal, raw.finish_reason);
    ledger.recordTransportOutcome(line.key, settledProposalRequestOutcome(usage), raw.attempt_ordinal);
    ledger.abandonPendingShard(line.key, raw.attempt_ordinal);
    return { classified: "incomplete", admitted: false };
  }
  const physicalEvidence = providerRawSuccessEvidenceState(raw);
  if (physicalEvidence !== "bound") {
    const usage = baseReportedUsage(raw.usage);
    writeAttempt(input, line, raw.decoded_text, usage,
      { status: "invalid", reason: physicalEvidence === "missing" ? "missing_response_body" :
        physicalEvidence === "truncated" ? "truncated_response_body" : "unsupported_response_body" },
      false, raw.attempt_ordinal, raw.finish_reason);
    ledger.recordTransportOutcome(line.key, settledProposalRequestOutcome(usage), raw.attempt_ordinal);
    ledger.abandonPendingShard(line.key, raw.attempt_ordinal);
    return { classified: "incomplete", admitted: false };
  }
  return settleDecoded(input, line, ledger, {
    rawJson: raw.decoded_text,
    finishReason: raw.finish_reason,
    usage: baseReportedUsage(raw.usage)
  }, raw.attempt_ordinal, lastAttempt);
}

function settleDecoded(
  input: Parameters<typeof executeSemanticProposalFill>[0],
  line: SemanticProposalLine,
  ledger: ProposalLedger,
  decoded: Readonly<{
    rawJson: string; finishReason: string | null;
    usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  }>,
  ordinal: number,
  lastAttempt: boolean
): { classified: ProposalAttemptClass; admitted: boolean } {
  const received = receiveLine(line, decoded.rawJson);
  const classified = classifyProposalOutcome(received.outcome, decoded.finishReason, input.workset.request_profile);
  const admitted = classified === "interpreted" && isCoreAdmittedProposal(line, received);
  const persistShard = classified !== "retryable" || lastAttempt;
  // Shard publication precedes reservation settle so a crash cannot look like missing work.
  if (persistShard) {
    writeAttempt(
      input, line, decoded.rawJson, decoded.usage, received.outcome, admitted, ordinal, decoded.finishReason
    );
  }
  ledger.recordTransportOutcome(line.key, settledProposalRequestOutcome(decoded.usage), ordinal);
  if (persistShard) {
    if (admitted) ledger.commitSuccessfulShard(line.key);
    else ledger.abandonPendingShard(line.key, ordinal);
  }
  return { classified, admitted };
}

function replayCachedProposalShard(
  line: SemanticProposalLine, shard: SemanticProposalShard
): ProposalAttemptClass | "empty" {
  if (typeof shard.outcome === "object" && shard.outcome !== null && "reason" in shard.outcome &&
      ["missing_response_body", "truncated_response_body", "unsupported_response_body"]
        .includes(String(shard.outcome.reason))) return "incomplete";
  if (shard.raw_json.length === 0) {
    if (shard.admitted || proposalOutcomeStatus(shard) === "interpreted") {
      throw new SemanticProposalIdentityError(`semantic proposal cache identity mismatch: ${shard.cache_key}`);
    }
    return "empty";
  }
  const receivedOutcome = receiveLine(line, shard.raw_json).outcome;
  const recordedStatus = proposalOutcomeStatus(shard);
  if ((recordedStatus === "resource_exhausted" || receivedOutcome.status === "resource_exhausted") &&
      recordedStatus !== receivedOutcome.status) {
    throw new SemanticProposalIdentityError(`semantic proposal resource outcome mismatch: ${shard.cache_key}`);
  }
  const classified = classifyProposalOutcome(receivedOutcome, shard.finish_reason, shard.request_profile);
  if (classified === "incomplete") {
    // Parser/semantic outcome stays distinct from completion: interpreted plus
    // non-STOP with admitted=false is the retained incomplete cache state.
    if (shard.admitted) {
      throw new SemanticProposalIdentityError(`semantic proposal cache identity mismatch: ${shard.cache_key}`);
    }
    return classified;
  }
  if (shard.admitted || proposalOutcomeStatus(shard) === "interpreted") {
    if (classified !== "interpreted") {
      throw new SemanticProposalIdentityError(`semantic proposal cache identity mismatch: ${shard.cache_key}`);
    }
    return classified;
  }
  if (proposalOutcomeStatus(shard) === "abstained" && classified !== "abstained") {
    throw new SemanticProposalIdentityError(`semantic proposal cache identity mismatch: ${shard.cache_key}`);
  }
  return classified;
}

function receiveLine(line: SemanticProposalLine, rawJson: string) {
  if (line.kind === "query") {
    const request = line.request as SourceSemanticQueryRequest;
    const received = proposeQuerySemantics({
      original_query: request.original_query,
      producer_id: request.producer_capability.producer_id,
      producer_version: request.producer_capability.producer_version,
      resource_limits: request.resource_limits,
      ...(request.approved_fixed_context === undefined ? {} : { approved_fixed_context: request.approved_fixed_context }),
      attribution_context: request.attribution_context
    }, { rawJson });
    if (canonicalJson(received.request) !== canonicalJson(request)) {
      throw new AlayaError("INTERNAL", "semantic proposal receive lost the retained request envelope");
    }
    return received;
  }
  const request = line.request as SourceSemanticCorrespondenceRequest;
  const received = proposeCorrespondenceSemantics({
    original_query: request.original_query,
    admitted_query_semantics: request.admitted_query_semantics, source_interpretation_descriptors: request.source_interpretation_descriptors,
    producer_id: request.producer_capability.producer_id,
    producer_version: request.producer_capability.producer_version,
    resource_limits: request.resource_limits
  }, { rawJson });
  if (canonicalJson(received.request) !== canonicalJson(request)) {
    throw new AlayaError("INTERNAL", "semantic proposal receive lost the retained request envelope");
  }
  return received;
}

function writeAttempt(
  input: Parameters<typeof executeSemanticProposalFill>[0],
  line: SemanticProposalLine,
  rawJson: string,
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined,
  outcome: unknown,
  admitted: boolean,
  attemptOrdinal: number,
  finishReason: string | null
): void {
  writeSemanticProposalShard(input.cacheRoot, {
    contract: SEMANTIC_PROPOSAL_CACHE_CONTRACT, kind: line.kind, cache_key: line.key,
    model: input.workset.model, request_profile: input.workset.request_profile,
    original_query: line.original_query, system_prompt: line.systemPrompt, user_prompt: line.userPrompt,
    raw_json: rawJson, outcome, admitted, attempt_ordinal: attemptOrdinal,
    extracted_at: new Date().toISOString(),
    finish_reason: finishReason,
    completion_witness: finishReason === null ? null : "finish_reason",
    raw_digest: createHash("sha256").update(rawJson, "utf8").digest("hex"),
    max_output_tokens: input.authority.limits.max_output_tokens,
    transport_provenance: line.transportProvenance,
    request_digest: line.requestDigest, attempt_lineage_digest: input.authority.attempt_lineage_digest,
    ...(usage === undefined ? {} : { usage })
  });
}

function isCoreAdmittedProposal(
  line: SemanticProposalLine,
  received: ReturnType<typeof receiveLine>
): boolean {
  if (line.kind === "query") {
    return admitSourceSemanticQuery(
      "query" in received ? received.query : undefined,
      line.original_query
    ).kind === "admitted";
  }
  const request = line.request as SourceSemanticCorrespondenceRequest;
  return admitSourceSemanticCorrespondence({
    semantic_correspondence: "semantic_correspondence" in received ? received.semantic_correspondence : undefined,
    source_interpretation: request.source_interpretation_descriptors[0]?.interpretation,
    query_semantics: request.admitted_query_semantics,
    original_query: line.original_query
  }).kind === "admitted";
}

function settledProposalRequestOutcome(
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined
) {
  return {
    retryCount: 0,
    rateLimitRetries: 0,
    successfulRequestCount: 1,
    usageRequestCount: usage === undefined ? 0 : 1,
    ...(usage === undefined ? {} : { usage })
  };
}

function persistFailedExtract(
  input: Parameters<typeof executeSemanticProposalFill>[0],
  line: SemanticProposalLine,
  ledger: ProposalLedger,
  transport: NonNullable<ReturnType<typeof readLiveTransportFailure>>,
  ordinal: number,
  used: number,
  response: ReturnType<typeof readGeminiFailureResponse>,
  stepResponse: ReturnType<typeof readStepFailureResponse>,
  lastAttempt: boolean
): { classified: ProposalAttemptClass; admitted: boolean; attempts: number } {
  const usage = transport.usage;
  const phase = transport.transportFailures[0]?.phase;
  const raw = writeProviderRawAttempt({
    root: input.cacheRoot, cacheKey: line.key, attemptOrdinal: ordinal, kind: line.kind,
    model: input.workset.model, requestProfile: input.workset.request_profile,
    requestDigest: line.requestDigest, attemptLineageDigest: input.authority.attempt_lineage_digest, decodedText: "",
    finishReason: response?.finishReason ?? null,
    ...(response === undefined ? {} : { responseBody: response.rawBody }),
    ...(stepResponse === undefined ? {} : { httpResponse: stepResponse }),
    ...(transport.transportFailures[0] === undefined ? {} : { transportFailure: transport.transportFailures[0] }),
    failureRetryable: !isCompletedNonRetryableResponse(transport),
    ...(transport.terminalRetryClassification === undefined ? {} : { failureClassification: transport.terminalRetryClassification }),
    ...(usage === undefined ? {} : { usage }),
    ...(phase === undefined ? {} : { transportPhase: phase })
  });
  return {
    ...replayPersistedProposalRaw(input, line, ledger, raw, lastAttempt),
    attempts: used
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
