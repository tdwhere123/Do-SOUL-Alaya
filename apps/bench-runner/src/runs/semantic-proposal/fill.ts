import { createHash } from "node:crypto";
import {
  admitSourceSemanticCorrespondence, admitSourceSemanticQuery, refuseRecallCampaignLiveExtraction
} from "@do-soul/alaya-core";
import { AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import {
  prepareSourceSemanticProposalRevision, proposeCorrespondenceSemantics, proposeQuerySemantics,
  type SourceSemanticProposalRevision,
  type SourceSemanticCorrespondenceRequest, type SourceSemanticQueryRequest
} from "@do-soul/alaya-soul";
import { createSemanticProviderHttpExtractor, isCompleteSemanticFinish,
  STEP_SEMANTIC_REQUEST_PROFILE } from "../compile-seed/http/semantic-provider-http.js";
import type { BenchSignalExtractor, CompileSeedExtractionConfig } from "../compile-seed/compile-seed-types.js";
import { assertAttemptInputWithinReceiptLimit } from "../extraction/authority/receipt-limits.js";
import { acquireExtractionCacheWriteLease, type ExtractionCacheWriteLease } from "../extraction/fill/manifest/fill-root-guard.js";
import { canonicalExtractionTargetRoot } from "../extraction/authority/target-root-binding.js";
import {
  readProviderRawAttempt, providerRawSuccessEvidenceState
} from "../extraction/fill/provider-raw-attempt.js";
import {
  executeProviderRequestLine, replayExistingProviderRequestRaws,
  type ProviderRequestAttemptClass, type ProviderRequestDecoded,
  type ProviderRequestDispatchContext, type ProviderRequestPhysicalContext
} from "../provider-request/execution.js";
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

export type ProposalAttemptClass = ProviderRequestAttemptClass;

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
  assertRetainedProposalRevisionParents(workset, cacheRoot, maxOutputTokens, lines);
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
  assertRetainedProposalRevisionParents(input.workset, input.cacheRoot, maxOutputTokens, lines);
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
      const replayed = replayExistingProviderRequestRaws(
        proposalPhysicalRequestContext(input, line, ledger), line);
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
      const filled = await executeProviderRequestLine(
        proposalDispatchRequestContext(input, line, ledger, lease, extractor!), line);
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
  const lines = materializeSemanticProposalLines(workset, maxOutputTokens);
  assertRetainedProposalRevisionParents(workset, cacheRoot, maxOutputTokens, lines);
  return lines.map((line) => {
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

/** Revisions use the exact durable parent raw and terminal physical response, including rejected semantics. */
export function prepareRetainedSemanticProposalRevision(input: Readonly<{
  workset: SemanticProposalWorkset; parentCacheRoot: string; maxOutputTokens: number; itemIndex: number;
  reviewComments?: readonly string[]; attentionRequestSha256?: string;
}>): SourceSemanticProposalRevision {
  const item = input.workset.items[input.itemIndex];
  if (item === undefined || typeof item !== "object" || item === null || Array.isArray(item) ||
      Object.hasOwn(item, "revision")) {
    throw new AlayaError("VALIDATION", "proposal revision requires one unrevised original item");
  }
  const parent = materializeSemanticProposalLines({ ...input.workset, items: [item] }, input.maxOutputTokens)[0]!;
  const raw = completeProposalParentRaw(input.workset, input.parentCacheRoot, input.maxOutputTokens, parent);
  return prepareSourceSemanticProposalRevision({ kind: input.workset.kind,
    parent_request: parent.request, previous_response: raw,
    response_completion: "complete", review_comments: input.reviewComments,
    attention_request_sha256: input.attentionRequestSha256 });
}

function assertRetainedProposalRevisionParents(workset: SemanticProposalWorkset, cacheRoot: string,
  maxOutputTokens: number, lines: readonly SemanticProposalLine[]): void {
  const revised = lines.some(line => line.request.revision !== undefined);
  if (revised !== (workset.revision_parent_cache_root !== undefined)) {
    throw new AlayaError("CONFLICT", "proposal revision requires one explicit physical parent root");
  }
  if (revised && canonicalExtractionTargetRoot(workset.revision_parent_cache_root!) ===
      canonicalExtractionTargetRoot(cacheRoot)) {
    throw new AlayaError("CONFLICT", "proposal revision requires an isolated child cache root");
  }
  for (const [index, line] of lines.entries()) {
    const revision = line.request.revision;
    if (revision === undefined) continue;
    const item = workset.items[index];
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new AlayaError("CONFLICT", "proposal revision lost its original workset item");
    }
    const { revision: _revision, ...baseItem } = item as Record<string, unknown>;
    const parent = materializeSemanticProposalLines({ ...workset, items: [baseItem] }, maxOutputTokens)[0]!;
    if (parent.userPrompt !== revision.parent_request_json ||
        completeProposalParentRaw(workset, workset.revision_parent_cache_root!, maxOutputTokens, parent) !== revision.previous_response) {
      throw new AlayaError("CONFLICT", "proposal revision differs from its complete retained parent");
    }
  }
}

function completeProposalParentRaw(workset: SemanticProposalWorkset, cacheRoot: string,
  maxOutputTokens: number, parent: SemanticProposalLine): string {
  const state = readSemanticProposalAttemptState(cacheRoot, parent.key,
    semanticProposalLookup(workset, parent, maxOutputTokens));
  const shard = state.shard;
  if (state.status !== "settled" || shard === undefined || !hasVerifiedProposalCompletion(shard)) {
    throw new AlayaError("CONFLICT", "proposal revision requires a settled complete physical parent");
  }
  const raw = readProviderRawAttempt(cacheRoot, parent.key, shard.attempt_ordinal);
  if (raw === undefined || raw.decoded_text !== shard.raw_json || !raw.full_replay_possible ||
      providerRawSuccessEvidenceState(raw) !== "bound" || raw.transport_failure !== undefined ||
      raw.finish_reason !== shard.finish_reason || raw.completion_witness !== "finish_reason") {
    throw new AlayaError("CONFLICT", "proposal revision parent has no complete retained response witness");
  }
  return raw.decoded_text;
}

function proposalPhysicalRequestContext(
  input: Parameters<typeof executeSemanticProposalFill>[0],
  line: SemanticProposalLine,
  ledger: ReturnType<typeof openSemanticProposalAttemptLedger>
): ProviderRequestPhysicalContext {
  const maxOutputTokens = input.authority.limits.max_output_tokens;
  return {
    cacheRoot: input.cacheRoot,
    model: input.workset.model,
    requestProfile: input.workset.request_profile,
    attemptLineageDigest: input.authority.attempt_lineage_digest,
    maxOutputTokens,
    maximumAttemptsPerKey: input.authority.limits.maximum_attempts_per_key,
    ledger,
    assertReservation: (raw) => {
      assertProposalRawReservation(
        raw, ledger.snapshot(), semanticProposalLookup(input.workset, line, maxOutputTokens), line.key);
    },
    interpretDecoded: (_ignored, decoded) => interpretProposalDecoded(line, decoded, input.workset.request_profile),
    publishArtifact: (published) => {
      writeAttempt(
        input, line, published.rawJson, published.usage, published.outcome,
        published.admitted, published.attemptOrdinal, published.finishReason);
    }
  };
}

function proposalDispatchRequestContext(
  input: Parameters<typeof executeSemanticProposalFill>[0],
  line: SemanticProposalLine,
  ledger: ReturnType<typeof openSemanticProposalAttemptLedger>,
  writeLease: ExtractionCacheWriteLease,
  extractor: BenchSignalExtractor
): ProviderRequestDispatchContext {
  return {
    ...proposalPhysicalRequestContext(input, line, ledger),
    writeLease,
    extractor,
    config: input.config,
    suppliedExtractor: input.extractor !== undefined,
    assertScope: () => {
      assertSemanticProposalExecutionScope(input.authority.execution_scope, input.cacheRoot, writeLease);
    }
  };
}

function interpretProposalDecoded(
  line: SemanticProposalLine, decoded: ProviderRequestDecoded, requestProfile: string
) {
  const received = receiveLine(line, decoded.rawJson);
  const classified = classifyProposalOutcome(received.outcome, decoded.finishReason, requestProfile);
  return {
    classified,
    admitted: classified === "interpreted" && isCoreAdmittedProposal(line, received),
    outcome: received.outcome
  };
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
      attribution_context: request.attribution_context,
      ...(request.revision === undefined ? {} : { revision: request.revision })
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
    resource_limits: request.resource_limits,
    ...(request.revision === undefined ? {} : { revision: request.revision })
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
