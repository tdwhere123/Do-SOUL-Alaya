import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  admitSourceSemanticAlignment, admitSourceSemanticQuery, refuseRecallCampaignLiveExtraction
} from "@do-soul/alaya-core";
import { canonicalJson } from "@do-soul/alaya-protocol";
import {
  proposeAlignmentSemantics, proposeQuerySemantics,
  type SourceSemanticAlignmentRequest, type SourceSemanticQueryRequest
} from "@do-soul/alaya-soul";
import { createGeminiHttpExtractor, readGeminiFailureResponse } from "../compile-seed/http/gemini-http.js";
import { GEMINI_INTERACTIVE_TIMEOUT_FLOOR_MS } from "../compile-seed/http/gemini-http.js";
import { resolveExtractionRequestTimeoutMs } from "../compile-seed/http/output-token-retry.js";
import type { CompileSeedExtractionConfig } from "../compile-seed/compile-seed-types.js";
import { assertAttemptInputWithinReceiptLimit } from "../extraction/authority/receipt-limits.js";
import { acquireExtractionCacheWriteLease } from "../extraction/fill/manifest/fill-root-guard.js";
import { isCompleteGeminiFinish } from "../extraction/fill/batch/native-codec.js";
import {
  bindProviderRawAttempt, listProviderRawAttempts, readProviderRawAttempt, requestEnvelopeDigest,
  writeProviderRawAttempt, retainedFailureOutcome, type ProviderRawAttempt
} from "../extraction/fill/provider-raw-attempt.js";
import { readLiveTransportFailure } from "../extraction/cache/cache-live-delegate.js";
import { buildExtractionTransportProvenance } from "../extraction/transport-route.js";
import {
  SEMANTIC_PROPOSAL_ATTEMPTS_PER_KEY, type SemanticProposalLine, type SemanticProposalWorkset,
  materializeSemanticProposalLines
} from "./workset.js";
import {
  type SemanticProposalAuthority, buildSemanticProposalPreflight, verifySemanticProposalAuthority
} from "./authority.js";
import { openSemanticProposalAttemptLedger } from "./attempt.js";
import {
  inspectSemanticProposalShard, isExecutableProposalShard, hasVerifiedProposalCompletion, proposalOutcomeStatus,
  writeSemanticProposalShard, SEMANTIC_PROPOSAL_CACHE_CONTRACT, SemanticProposalIdentityError,
  type SemanticProposalLookup, type SemanticProposalShard
} from "./artifact.js";

export type ProposalAttemptClass = "interpreted" | "abstained" | "retryable" | "terminal" | "incomplete";

export function classifyProposalOutcome(
  outcome: Readonly<{ status: string; reason?: string }>,
  finishReason?: string | null
): ProposalAttemptClass {
  if (finishReason !== undefined && !isCompleteGeminiFinish(finishReason)) return "incomplete";
  if (outcome.status === "interpreted") return "interpreted";
  if (outcome.status === "abstained") return "abstained";
  if (outcome.status === "transport_failure") return "retryable";
  if (outcome.status === "invalid" && outcome.reason === "malformed_json") return "retryable";
  return "terminal";
}

export function prepareSemanticProposal(
  workset: SemanticProposalWorkset, cacheRoot: string, maxOutputTokens: number
) {
  const lines = materializeSemanticProposalLines(workset, maxOutputTokens);
  const cachedKeys = new Set<string>();
  for (const line of lines) {
    const existing = inspectSemanticProposalShard(cacheRoot, line.key, lookupOf(workset, line, maxOutputTokens));
    if (existing !== undefined) {
      replayCachedProposalShard(line, existing);
      cachedKeys.add(line.key);
    }
  }
  return buildSemanticProposalPreflight({
    kind: workset.kind, model: workset.model, request_profile: workset.request_profile,
    maxOutputTokens, lines, cachedKeys
  });
}

export async function executeSemanticProposalFill(input: Readonly<{
  workset: SemanticProposalWorkset;
  cacheRoot: string;
  authority: SemanticProposalAuthority;
  config: CompileSeedExtractionConfig;
  extractor?: ReturnType<typeof createGeminiHttpExtractor>;
}>): Promise<Readonly<{
  requested: number; cache_hits: number; newly_admitted: number; terminal_failures: number; attempts: number;
  interpreted: number; abstained: number; cached_invalid: number; unattempted: number;
}>> {
  refuseRecallCampaignLiveExtraction("extraction_write");
  const authority = verifySemanticProposalAuthority(input.authority);
  if (authority.kind !== input.workset.kind || authority.model !== input.workset.model ||
      authority.request_profile !== input.workset.request_profile) {
    throw new Error("semantic proposal authority does not bind this workset");
  }
  mkdirSync(input.cacheRoot, { recursive: true });
  const maxOutputTokens = authority.limits.max_output_tokens;
  const lines = materializeSemanticProposalLines(input.workset, maxOutputTokens);
  const authorized = new Set(authority.keys);
  const dispatch: SemanticProposalLine[] = [];
  const retainedLines: SemanticProposalLine[] = [];
  let cacheHits = 0, interpreted = 0, abstained = 0, cachedInvalid = 0, unattempted = 0;
  for (const line of lines) {
    const existing = inspectSemanticProposalShard(
      input.cacheRoot, line.key, lookupOf(input.workset, line, maxOutputTokens)
    );
    if (existing !== undefined) {
      const classified = replayCachedProposalShard(line, existing);
      cacheHits += 1;
      if (isExecutableProposalShard(existing)) interpreted += 1;
      else if (classified === "abstained") abstained += 1;
      else cachedInvalid += 1;
      if (authorized.has(line.key)) retainedLines.push(line);
      continue;
    }
    if (!authorized.has(line.key)) {
      unattempted += 1;
      continue;
    }
    dispatch.push(line);
  }
  if (dispatch.length > 0 && authority.limits.maximum_attempts === 0) {
    throw new Error("semantic proposal authority has no remaining provider attempt capacity");
  }
  if (dispatch.length === 0 && retainedLines.length === 0) {
    return summarize(lines.length, cacheHits, 0, 0, 0, interpreted, abstained, cachedInvalid, unattempted);
  }
  const lease = acquireExtractionCacheWriteLease(input.cacheRoot);
  try {
    lease.assertOwned();
    const ledger = openSemanticProposalAttemptLedger({
      cacheRoot: input.cacheRoot, authority, kind: input.workset.kind
    });
    for (const line of retainedLines) {
      if (!ledger.snapshot().pendingKeys.includes(line.key) &&
          !ledger.snapshot().unresolvedAttempts.some((item) => item.cacheKey === line.key)) continue;
      replayExistingProposalRaws(input, line, ledger);
      if (ledger.snapshot().pendingKeys.includes(line.key) ||
          ledger.snapshot().unresolvedAttempts.some((item) => item.cacheKey === line.key)) {
        throw new SemanticProposalIdentityError(`retained proposal has unresolved attempt evidence: ${line.key}`);
      }
    }
    const extractor = dispatch.length === 0 ? undefined : input.extractor ?? createGeminiHttpExtractor(input.config);
    let newlyAdmitted = 0, terminalFailures = 0, attempts = 0;
    for (const line of dispatch) {
      assertAttemptInputWithinReceiptLimit(line.inputByteUpper, authority.price.maximum_input_tokens_per_attempt);
      const filled = await fillLine(input, line, extractor!, ledger, maxOutputTokens);
      attempts += filled.attempts;
      if (filled.admitted) {
        newlyAdmitted += 1;
        interpreted += 1;
      } else if (filled.classified === "abstained") abstained += 1;
      else terminalFailures += 1;
    }
    return summarize(lines.length, cacheHits, newlyAdmitted, terminalFailures, attempts,
      interpreted, abstained, cachedInvalid, unattempted);
  } finally {
    lease.release();
  }
}

function summarize(
  requested: number, cacheHits: number, newlyAdmitted: number, terminalFailures: number, attempts: number,
  interpreted: number, abstained: number, cachedInvalid: number, unattempted: number
) {
  return {
    requested, cache_hits: cacheHits, newly_admitted: newlyAdmitted, terminal_failures: terminalFailures,
    attempts, interpreted, abstained, cached_invalid: cachedInvalid, unattempted
  };
}

function lookupOf(
  workset: SemanticProposalWorkset, line: SemanticProposalLine, maxOutputTokens: number
): SemanticProposalLookup {
  return {
    kind: workset.kind, model: workset.model, request_profile: workset.request_profile,
    system_prompt: line.systemPrompt, user_prompt: line.userPrompt,
    schema: line.responseJsonSchema, max_output_tokens: maxOutputTokens
  };
}

/** Offline consumers use the same exact-request lookup, receiver and Core admission as fill. */
export function readSemanticProposalResults(workset: SemanticProposalWorkset, cacheRoot: string, maxOutputTokens: number) {
  return materializeSemanticProposalLines(workset, maxOutputTokens).map((line) => {
    const shard = inspectSemanticProposalShard(cacheRoot, line.key, lookupOf(workset, line, maxOutputTokens));
    if (shard === undefined) return { line, status: "unattempted" as const };
    replayCachedProposalShard(line, shard);
    if (!isExecutableProposalShard(shard)) {
      const outcome = proposalOutcomeStatus(shard);
      // Retry/cache classification is not a semantic outcome. In particular,
      // absent decoded text on a failed HTTP attempt is not valid-empty output.
      const status = outcome !== "interpreted" ? outcome
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
  extractor: ReturnType<typeof createGeminiHttpExtractor>,
  ledger: ProposalLedger,
  maxOutputTokens: number
): Promise<{ classified: ProposalAttemptClass; admitted: boolean; attempts: number }> {
  const replayed = replayExistingProposalRaws(input, line, ledger);
  if (replayed.done) {
    return { classified: replayed.classified, admitted: replayed.admitted, attempts: replayed.attempts };
  }
  let used = replayed.attempts;
  while (used < SEMANTIC_PROPOSAL_ATTEMPTS_PER_KEY) {
    const remainingGlobal = remainingProposalSlots(ledger);
    if (remainingGlobal <= 0) {
      return { classified: "retryable", admitted: false, attempts: used };
    }
    if (input.extractor === undefined && (input.config.apiKey === null || input.config.apiKey.trim().length === 0)) {
      throw new Error("garden API key is unavailable");
    }
    const ordinal = ledger.reserveAttemptOrdinal(line.key);
    used += 1;
    const lastAttempt = used >= SEMANTIC_PROPOSAL_ATTEMPTS_PER_KEY || remainingGlobal <= 1;
    let extracted: Awaited<ReturnType<typeof extractor.extract>>;
    try {
      extracted = await extractor.extract({
        systemPrompt: line.systemPrompt, userPrompt: line.userPrompt, retryMode: "disabled",
        timeoutMs: Math.max(resolveExtractionRequestTimeoutMs(maxOutputTokens), GEMINI_INTERACTIVE_TIMEOUT_FLOOR_MS),
        maxOutputTokens, outputTokenField: "maxOutputTokens",
        validateRawJson: () => undefined, responseJsonSchema: line.responseJsonSchema
      });
    } catch (cause) {
      if (isLocalPersistenceFailure(cause)) throw cause;
      const transport = readLiveTransportFailure(cause);
      if (transport === undefined || transport.transportFailures.length === 0) throw cause;
      appendFileSync(join(input.cacheRoot, "interactive-extract-errors.log"),
        `${line.key}\t${cause instanceof Error ? cause.message : String(cause)}\n`);
      const settled = persistFailedExtract(input, line, ledger, transport, ordinal, used,
        readGeminiFailureResponse(cause), lastAttempt);
      if (settled.classified !== "retryable" || lastAttempt) return settled;
      continue;
    }
    writeProviderRawAttempt({
      root: input.cacheRoot, cacheKey: line.key, attemptOrdinal: ordinal, kind: line.kind,
      model: input.workset.model, requestProfile: input.workset.request_profile,
      requestDigest: requestEnvelopeDigest(line.userPrompt), decodedText: extracted.rawJson,
      finishReason: extracted.responseMetadata?.finishReason ?? null,
      ...(extracted.usage === undefined ? {} : { usage: extracted.usage })
    });
    const settled = settleDecoded(input, line, ledger, {
      rawJson: extracted.rawJson,
      finishReason: extracted.responseMetadata?.finishReason ?? null,
      usage: extracted.usage,
      replay: false
    }, ordinal, lastAttempt);
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

function replayExistingProposalRaws(
  input: Parameters<typeof executeSemanticProposalFill>[0],
  line: SemanticProposalLine,
  ledger: ProposalLedger
): ProposalReplayProgress {
  let used = 0;
  const processed = new Set<number>();
  const snapshot = ledger.snapshot();
  const raws = listProviderRawAttempts(input.cacheRoot, line.key);
  const rawOrdinals = new Set(raws.map((item) => item.attempt_ordinal));
  const unresolved = snapshot.unresolvedAttempts.filter((item) => item.cacheKey === line.key);
  const unresolvedOrdinals = new Set(unresolved.map((item) => item.attemptOrdinal));
  for (const failure of snapshot.transportFailures) {
    if (failure.cacheKey !== line.key) continue;
    if (processed.has(failure.attemptOrdinal) || rawOrdinals.has(failure.attemptOrdinal) ||
        unresolvedOrdinals.has(failure.attemptOrdinal)) continue;
    processed.add(failure.attemptOrdinal);
    used += 1;
  }
  for (const pending of unresolved) {
    const raw = readProviderRawAttempt(input.cacheRoot, line.key, pending.attemptOrdinal);
    used += 1;
    processed.add(pending.attemptOrdinal);
    if (raw === undefined) return { done: true, classified: "incomplete", admitted: false, attempts: used };
    const settled = replayPersistedProposalRaw(
      input, line, ledger, raw, used >= SEMANTIC_PROPOSAL_ATTEMPTS_PER_KEY
    );
    if (settled.classified !== "retryable" || used >= SEMANTIC_PROPOSAL_ATTEMPTS_PER_KEY) {
      return { done: true, classified: settled.classified, admitted: settled.admitted, attempts: used };
    }
  }
  for (const raw of raws) {
    if (processed.has(raw.attempt_ordinal)) continue;
    // Count this key's reserved/replayed cardinality, never the global ledger ordinal.
    used += 1;
    processed.add(raw.attempt_ordinal);
    const settled = replayPersistedProposalRaw(
      input, line, ledger, raw, used >= SEMANTIC_PROPOSAL_ATTEMPTS_PER_KEY
    );
    if (settled.classified !== "retryable" || used >= SEMANTIC_PROPOSAL_ATTEMPTS_PER_KEY) {
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
  bindProviderRawAttempt(raw, {
    cacheKey: line.key, kind: line.kind, model: input.workset.model,
    requestProfile: input.workset.request_profile,
    requestDigest: requestEnvelopeDigest(line.userPrompt)
  });
  const failure = retainedFailureOutcome(raw);
  if (failure !== undefined) {
    if (raw.failure_retryable !== true || lastAttempt) writeAttempt(input, line, raw.decoded_text, raw.usage ?? undefined,
      { status: "transport_failure", failure: raw.transport_failure }, false, raw.attempt_ordinal, raw.finish_reason);
    ledger.recordTransportOutcome(line.key, failure, raw.attempt_ordinal);
    ledger.abandonPendingShard(line.key, raw.attempt_ordinal);
    return { classified: raw.failure_retryable === true ? "retryable" : "terminal", admitted: false };
  }
  if (!raw.full_replay_possible) {
    const usage = raw.usage_known && raw.usage !== null ? raw.usage : undefined;
    writeAttempt(input, line, raw.decoded_text, usage,
      { status: "invalid", reason: "truncated_raw" }, false, raw.attempt_ordinal, raw.finish_reason);
    ledger.recordTransportOutcome(line.key, settledProposalRequestOutcome(usage), raw.attempt_ordinal);
    ledger.abandonPendingShard(line.key, raw.attempt_ordinal);
    return { classified: "incomplete", admitted: false };
  }
  return settleDecoded(input, line, ledger, {
    rawJson: raw.decoded_text,
    finishReason: raw.finish_reason,
    usage: raw.usage ?? undefined,
    replay: true
  }, raw.attempt_ordinal, lastAttempt);
}

function settleDecoded(
  input: Parameters<typeof executeSemanticProposalFill>[0],
  line: SemanticProposalLine,
  ledger: ProposalLedger,
  decoded: Readonly<{
    rawJson: string; finishReason: string | null;
    usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
    replay: boolean;
  }>,
  ordinal: number,
  lastAttempt: boolean
): { classified: ProposalAttemptClass; admitted: boolean } {
  const received = receiveLine(line, decoded.rawJson);
  const classified = classifyProposalOutcome(received.outcome, decoded.finishReason);
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
  if (shard.raw_json.length === 0) {
    if (shard.admitted || proposalOutcomeStatus(shard) === "interpreted") {
      throw new SemanticProposalIdentityError(`semantic proposal cache identity mismatch: ${shard.cache_key}`);
    }
    return "empty";
  }
  const classified = classifyProposalOutcome(receiveLine(line, shard.raw_json).outcome, shard.finish_reason);
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
      ...(request.approved_fixed_context === undefined ? {} : { approved_fixed_context: request.approved_fixed_context })
    }, { rawJson });
    if (canonicalJson(received.request) !== canonicalJson(request)) {
      throw new Error("semantic proposal receive lost the retained request envelope");
    }
    return received;
  }
  const request = line.request as SourceSemanticAlignmentRequest;
  const received = proposeAlignmentSemantics({
    original_query: request.original_query,
    admitted_q: request.admitted_q, h_descriptors: request.h_descriptors,
    producer_id: request.producer_capability.producer_id,
    producer_version: request.producer_capability.producer_version,
    resource_limits: request.resource_limits
  }, { rawJson });
  if (canonicalJson(received.request) !== canonicalJson(request)) {
    throw new Error("semantic proposal receive lost the retained request envelope");
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
    transport_provenance: buildExtractionTransportProvenance(input.config),
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
  const request = line.request as SourceSemanticAlignmentRequest;
  return admitSourceSemanticAlignment({
    alignment: "alignment" in received ? received.alignment : undefined,
    h: request.h_descriptors[0]?.interpretation,
    q: request.admitted_q,
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
  lastAttempt: boolean
): { classified: ProposalAttemptClass; admitted: boolean; attempts: number } {
  const usage = transport.usage;
  const phase = transport.transportFailures[0]?.phase;
  const raw = writeProviderRawAttempt({
    root: input.cacheRoot, cacheKey: line.key, attemptOrdinal: ordinal, kind: line.kind,
    model: input.workset.model, requestProfile: input.workset.request_profile,
    requestDigest: requestEnvelopeDigest(line.userPrompt), decodedText: "",
    finishReason: response?.finishReason ?? null,
    ...(response === undefined ? {} : { responseBody: response.rawBody }),
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
