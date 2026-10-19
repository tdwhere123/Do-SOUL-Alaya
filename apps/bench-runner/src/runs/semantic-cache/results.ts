import { admitSourceSemanticCorrespondence, admitSourceSemanticQuery } from "@do-soul/alaya-core";
import { AlayaError, canonicalJson, type SourceSemanticResourceLedger } from "@do-soul/alaya-protocol";
import { proposeCorrespondenceSemantics, proposeQuerySemantics, sourceSemanticQueryPresentation,
  type SourceSemanticCorrespondenceRequest, type SourceSemanticQueryRequest } from "@do-soul/alaya-soul";
import { isCompleteSemanticFinish } from "../compile-seed/http/semantic-provider-http.js";
import { withBoundedArtifactReadMeter } from "../extraction/cache-audit/bounded-artifact-reader.js";
import { canonicalExtractionTargetRoot } from "../extraction/authority/target-root-binding.js";
import { readProviderRawAttempt, providerRawSuccessEvidenceState } from "../extraction/fill/provider-raw-attempt.js";
import type { ProviderRequestAttemptClass } from "../provider-request/execution.js";
import { materializeSemanticProposalLines, resolveSemanticProposalRevisionParent,
  type SemanticProposalLine, type SemanticProposalWorkset } from "./workset.js";
import { readSemanticProposalAttemptState, semanticProposalLookup } from "./attempt.js";
import { hasAdmittedProposalOutcome, hasVerifiedProposalCompletion, proposalOutcomeStatus,
  SemanticProposalIdentityError, type SemanticProposalShard } from "./artifact.js";
import type { QueryRevisionObserverView } from "./query-revision-observer-view.js";
import type { CorrespondenceGenerationContext } from "./correspondence-generation-context.js";

export function classifyProposalOutcome(
  outcome: Readonly<{ status: string; reason?: string }>, finishReason?: string | null,
  requestProfile = "gemini-2.5-nonthinking-v1"
): ProviderRequestAttemptClass {
  if (finishReason !== undefined && !isCompleteSemanticFinish(requestProfile, finishReason)) return "incomplete";
  if (outcome.status === "interpreted") return "interpreted";
  if (outcome.status === "abstained") return "abstained";
  if (outcome.status === "transport_failure") return "retryable";
  if (outcome.status === "invalid" && outcome.reason === "malformed_json") return "retryable";
  return "terminal";
}

/** Offline consumers use the same exact-request lookup, receiver and Core admission as fill. */
export function readSemanticProposalResults(workset: SemanticProposalWorkset, cacheRoot: string, maxOutputTokens: number,
  meter?: SourceSemanticResourceLedger, queryRevisionObserverView?: QueryRevisionObserverView, correspondenceGenerationContext?: CorrespondenceGenerationContext) {
  if (meter !== undefined) return withBoundedArtifactReadMeter(meter,
    () => readMeteredSemanticProposalResults(workset, cacheRoot, maxOutputTokens, meter, queryRevisionObserverView, correspondenceGenerationContext));
  return readMeteredSemanticProposalResults(workset, cacheRoot, maxOutputTokens, undefined, queryRevisionObserverView, correspondenceGenerationContext);
}

function readMeteredSemanticProposalResults(workset: SemanticProposalWorkset, cacheRoot: string, maxOutputTokens: number,
  meter?: SourceSemanticResourceLedger, queryRevisionObserverView?: QueryRevisionObserverView, correspondenceGenerationContext?: CorrespondenceGenerationContext) {
  const lines = materializeSemanticProposalLines(workset, maxOutputTokens, meter, queryRevisionObserverView, correspondenceGenerationContext);
  assertRetainedProposalRevisionParents(workset, cacheRoot, maxOutputTokens, lines);
  return lines.map((line) => {
    const state = readSemanticProposalAttemptState(cacheRoot, line.key, semanticProposalLookup(workset, line, maxOutputTokens));
    meter?.retain(state, "semantic proposal cache/ledger decode");
    const shard = state.shard;
    if (state.status !== "settled") return { line, shard, status: state.status };
    if (shard === undefined) return { line, status: "unattempted" as const };
    const replay = replayCachedProposalShard(line, shard, meter);
    meter?.retain(replay, "semantic proposal receiver and Core admission");
    if (!hasAdmittedProposalOutcome(shard)) {
      const outcome = proposalOutcomeStatus(shard);
      // A non-complete finish cannot hide the original transport failure.
      if (typeof shard.finish_reason === "string" && shard.finish_reason.length > 0 &&
          !isCompleteSemanticFinish(shard.request_profile, shard.finish_reason)) {
        const raw = readProviderRawAttempt(cacheRoot, line.key, shard.attempt_ordinal);
        if (raw !== undefined && raw.transport_failure === undefined && raw.full_replay_possible &&
            providerRawSuccessEvidenceState(raw) === "bound") return { line, shard, status: "incomplete" as const };
      }
      // Missing decoded text is not valid-empty semantic output.
      const status = outcome === "transport_failure" ? outcome : !hasVerifiedProposalCompletion(shard) ||
        typeof shard.outcome === "object" && shard.outcome !== null &&
        "reason" in shard.outcome && ["truncated_raw", "missing_response_body", "truncated_response_body",
          "unsupported_response_body"].includes(String(shard.outcome.reason)) ? "incomplete"
        : outcome !== "interpreted" ? outcome
        : hasVerifiedProposalCompletion(shard) ? "core_rejected" : "incomplete";
      return { line, shard, status };
    }
    if (replay.state !== "parsed" || !isCoreAdmittedProposal(line, replay.received)) {
      throw new SemanticProposalIdentityError("cached proposal no longer admits");
    }
    return { line, shard, received: replay.received, status: "interpreted" as const };
  });
}

export function assertRetainedProposalRevisionParents(workset: SemanticProposalWorkset, cacheRoot: string,
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
    const parent = resolveSemanticProposalRevisionParent(workset, workset.items[index], maxOutputTokens);
    if (JSON.stringify(parent.request) !== revision.parent_request_json ||
        completeProposalParentRaw(workset, workset.revision_parent_cache_root!, maxOutputTokens, parent) !== revision.previous_response) {
      throw new AlayaError("CONFLICT", "proposal revision differs from its complete retained parent");
    }
  }
}

export function completeProposalParentRaw(workset: SemanticProposalWorkset, cacheRoot: string,
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

type CachedProposalReplay =
  | Readonly<{ state: "unparsed"; classified: "terminal" | "incomplete" | "empty" }>
  | Readonly<{ state: "parsed"; classified: ProviderRequestAttemptClass; received: ReturnType<typeof receiveLine> }>;

export function replayCachedProposalShard(
  line: SemanticProposalLine, shard: SemanticProposalShard, meter?: SourceSemanticResourceLedger
): CachedProposalReplay {
  // Accounting rejection must not be reinterpreted as admitted output or abstention.
  if (typeof shard.outcome === "object" && shard.outcome !== null && "reason" in shard.outcome &&
      "status" in shard.outcome && shard.outcome.status === "invalid" &&
      shard.outcome.reason === "invalid_usage") return { state: "unparsed", classified: "terminal" };
  if (typeof shard.outcome === "object" && shard.outcome !== null && "reason" in shard.outcome &&
      ["missing_response_body", "truncated_response_body", "unsupported_response_body"]
        .includes(String(shard.outcome.reason))) return { state: "unparsed", classified: "incomplete" };
  if (typeof shard.finish_reason === "string" && shard.finish_reason.length > 0 &&
      !isCompleteSemanticFinish(shard.request_profile, shard.finish_reason)) {
    if (shard.admitted) throw new SemanticProposalIdentityError(`semantic proposal cache identity mismatch: ${shard.cache_key}`);
    return { state: "unparsed", classified: "incomplete" };
  }
  if (shard.raw_json.length === 0) {
    if (shard.admitted || proposalOutcomeStatus(shard) === "interpreted") {
      throw new SemanticProposalIdentityError(`semantic proposal cache identity mismatch: ${shard.cache_key}`);
    }
    return { state: "unparsed", classified: "empty" };
  }
  const received = receiveLine(line, shard.raw_json, meter), receivedOutcome = received.outcome;
  const recordedStatus = proposalOutcomeStatus(shard);
  if ((recordedStatus === "resource_exhausted" || receivedOutcome.status === "resource_exhausted") &&
      recordedStatus !== receivedOutcome.status) {
    throw new SemanticProposalIdentityError(`semantic proposal resource outcome mismatch: ${shard.cache_key}`);
  }
  const classified = classifyProposalOutcome(receivedOutcome, shard.finish_reason, shard.request_profile);
  if (classified === "incomplete") {
    if (shard.admitted) throw new SemanticProposalIdentityError(`semantic proposal cache identity mismatch: ${shard.cache_key}`);
    return { state: "parsed", classified, received };
  }
  if (shard.admitted || proposalOutcomeStatus(shard) === "interpreted") {
    if (classified !== "interpreted") throw new SemanticProposalIdentityError(`semantic proposal cache identity mismatch: ${shard.cache_key}`);
    return { state: "parsed", classified, received };
  }
  if (proposalOutcomeStatus(shard) === "abstained" && classified !== "abstained") {
    throw new SemanticProposalIdentityError(`semantic proposal cache identity mismatch: ${shard.cache_key}`);
  }
  return { state: "parsed", classified, received };
}

export function receiveLine(line: SemanticProposalLine, rawJson: string, meter?: SourceSemanticResourceLedger) {
  if (line.kind === "query") {
    const request = line.request as SourceSemanticQueryRequest;
    const received = proposeQuerySemantics({
      original_query: request.original_query,
      producer_id: request.producer_capability.producer_id,
      producer_version: request.producer_capability.producer_version,
      resource_limits: request.resource_limits,
      generation_presentation: sourceSemanticQueryPresentation(request),
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
    ...(request.generation_policy === undefined ? {} : { generation_policy: request.generation_policy }),
    ...(request.revision === undefined ? {} : { revision: request.revision })
  }, { rawJson }, meter);
  if (canonicalJson(received.request) !== canonicalJson(request)) {
    throw new AlayaError("INTERNAL", "semantic proposal receive lost the retained request envelope");
  }
  return received;
}

export function isCoreAdmittedProposal(line: SemanticProposalLine, received: ReturnType<typeof receiveLine>): boolean {
  if (line.kind === "query") return admitSourceSemanticQuery(
    "query" in received ? received.query : undefined, line.original_query).kind === "admitted";
  const request = line.request as SourceSemanticCorrespondenceRequest;
  return admitSourceSemanticCorrespondence({
    semantic_correspondence: "semantic_correspondence" in received ? received.semantic_correspondence : undefined,
    source_interpretation: request.source_interpretation_descriptors[0]?.interpretation,
    query_semantics: request.admitted_query_semantics,
    original_query: line.original_query
  }).kind === "admitted";
}
