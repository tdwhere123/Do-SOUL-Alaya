import { createHash } from "node:crypto";
import { refuseRecallCampaignLiveExtraction } from "@do-soul/alaya-core";
import { isChatSemanticRequestProfile, AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import { prepareSourceSemanticProposalRevision, type SourceSemanticProposalRevision } from "@do-soul/alaya-soul";
import { classifyProposalOutcome, readSemanticProposalResults, assertRetainedProposalRevisionParents,
  completeProposalParentRaw, replayCachedProposalShard, receiveLine, isCoreAdmittedProposal } from "../semantic-cache/results.js";
// Compatibility for existing proposal callers; remove with the gated research deletion.
export { classifyProposalOutcome, readSemanticProposalResults } from "../semantic-cache/results.js";
import { createSemanticProviderHttpExtractor } from "../compile-seed/http/semantic-provider-http.js";
import type { BenchSignalExtractor, CompileSeedExtractionConfig } from "../compile-seed/compile-seed-types.js";
import { assertAttemptInputWithinReceiptLimit } from "../extraction/authority/receipt-limits.js";
import { acquireExtractionCacheWriteLease, withExtractionCacheWriteLease, type ExtractionCacheWriteLease } from "../extraction/fill/manifest/fill-root-guard.js";
import {
  executeProviderRequestLine, replayExistingProviderRequestRaws,
  type ProviderRequestAttemptClass, type ProviderRequestDecoded,
  type ProviderRequestDispatchContext, type ProviderRequestPhysicalContext
} from "../provider-request/execution.js";
import {
  type SemanticProposalLine, type SemanticProposalWorkset, type RetainedSemanticQueryParent,
  materializeSemanticProposalLines, semanticProposalRequestBinding, resolveSemanticProposalRevisionParent
} from "./workset.js";
import {
  type SemanticProposalAuthority, buildSemanticProposalPreflight, verifySemanticProposalAuthority,
  assertSemanticProposalExecutionRoot, inspectSemanticProposalExecutionScope
} from "./authority.js";
import { openSemanticProposalAttemptLedger, readSemanticProposalAttemptState, assertProposalRawReservation,
  semanticProposalLookup } from "./attempt.js";
import {
  writeSemanticProposalShard, SEMANTIC_PROPOSAL_CACHE_CONTRACT, SemanticProposalIdentityError
} from "./artifact.js";

import { captureQueryRevisionObserverView, type QueryRevisionObserverView } from "./query-revision-observer-view.js";

import { captureCorrespondenceGenerationContext, type CorrespondenceGenerationContext } from "./correspondence-generation-context.js";

export type ProposalAttemptClass = ProviderRequestAttemptClass;

export function prepareSemanticProposal(
  workset: SemanticProposalWorkset, cacheRoot: string, maxOutputTokens: number, maxAttemptsPerKey?: number,
  queryRevisionObserverView?: QueryRevisionObserverView, correspondenceGenerationContext?: CorrespondenceGenerationContext
) {
  const lines = materializeSemanticProposalLines(workset, maxOutputTokens, undefined, queryRevisionObserverView, correspondenceGenerationContext);
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
  queryRevisionObserverView?: QueryRevisionObserverView;
  correspondenceGenerationContext?: CorrespondenceGenerationContext;
}>) {
  refuseRecallCampaignLiveExtraction("extraction_write");
  const authority = verifySemanticProposalAuthority(input.authority);
  assertSemanticProposalExecutionRoot(authority.execution_scope, input.cacheRoot);
  input = { ...input, authority, cacheRoot: authority.execution_scope.execution_root_path,
    ...(input.correspondenceGenerationContext === undefined ? {} : {
      correspondenceGenerationContext: captureCorrespondenceGenerationContext(input.correspondenceGenerationContext)
    }),
    ...(input.queryRevisionObserverView === undefined ? {} : {
      queryRevisionObserverView: captureQueryRevisionObserverView(input.queryRevisionObserverView)
    }) };
  if (authority.kind !== input.workset.kind || authority.model !== input.workset.model ||
      authority.request_profile !== input.workset.request_profile) {
    throw new AlayaError("CONFLICT", "semantic proposal authority does not bind this workset");
  }
  const maxOutputTokens = authority.limits.max_output_tokens;
  const lines = materializeSemanticProposalLines(input.workset, maxOutputTokens, undefined, input.queryRevisionObserverView, input.correspondenceGenerationContext);
  assertRetainedProposalRevisionParents(input.workset, input.cacheRoot, maxOutputTokens, lines);
  assertAuthorizedProposalRequest(input, lines, maxOutputTokens);
  const authorized = new Set(authority.keys);
  const dispatch: SemanticProposalLine[] = [];
  const retainedLines: SemanticProposalLine[] = [];
  let cacheHits = 0;
  for (const line of lines) {
    const state = readSemanticProposalAttemptState(
      input.cacheRoot, line.key, semanticProposalLookup(input.workset, line, maxOutputTokens)
    );
    const existing = state.shard;
    if ((input.queryRevisionObserverView !== undefined || input.correspondenceGenerationContext !== undefined) && authority.keys.length > 0 && !authorized.has(line.key)) {
      throw new AlayaError("CONFLICT", "query revision observer view differs from authorized request keys");
    }
    if (existing !== undefined) {
      const prior = replayCachedProposalShard(line, existing).classified;
      if (isChatSemanticRequestProfile(input.workset.request_profile) &&
          prior !== "interpreted" && prior !== "abstained" && state.status !== "pending") {
        throw new AlayaError("CONFLICT", `native chat proposal fill stopped after retained ${prior} for ${line.key}`);
      }
      cacheHits += 1;
      if (authorized.has(line.key)) retainedLines.push(line);
      continue;
    }
    if (!authorized.has(line.key)) {
      if (input.queryRevisionObserverView !== undefined || input.correspondenceGenerationContext !== undefined) {
        throw new AlayaError("CONFLICT", "query revision observer view differs from authorized request keys");
      }
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
  return withExtractionCacheWriteLease(lease, async () => {
    input = { ...input, cacheRoot: lease.stableRootPath };
    // The ledger owner checks source compatibility once, before this operation can mutate it.
    const ledger = openSemanticProposalAttemptLedger({
      cacheRoot: input.cacheRoot, authority, kind: input.workset.kind, writeLease: lease
    });
    for (const line of retainedLines) {
      if (!ledger.snapshot().pendingKeys.includes(line.key) &&
          !ledger.snapshot().unresolvedAttempts.some((item) => item.cacheKey === line.key)) continue;
      const replayed = replayExistingProviderRequestRaws(
        proposalPhysicalRequestContext(input, line, ledger), line);
      if (isChatSemanticRequestProfile(input.workset.request_profile) && replayed.done &&
          replayed.classified !== "interpreted" && replayed.classified !== "abstained") {
        throw new AlayaError("CONFLICT", `native chat proposal fill stopped after retained ${replayed.classified} for ${line.key}`);
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
      if (isChatSemanticRequestProfile(input.workset.request_profile) &&
          filled.classified !== "interpreted" && filled.classified !== "abstained") {
        throw new AlayaError("CONFLICT", `native chat proposal fill stopped after ${filled.classified} for ${line.key}`);
      }
      if (filled.admitted) {
        newlyAdmitted += 1;
      }
    }
    return summarize(input, cacheHits, newlyAdmitted, attempts);
  });
}

function summarize(
  input: Parameters<typeof executeSemanticProposalFill>[0], cacheHits: number, newlyAdmitted: number, attempts: number
) {
  const rows = readSemanticProposalResults(input.workset, input.cacheRoot, input.authority.limits.max_output_tokens,
    undefined, input.queryRevisionObserverView, input.correspondenceGenerationContext);
  const count = (...statuses: readonly string[]) => rows.filter(row => statuses.includes(row.status)).length;
  return {
    requested: rows.length, cache_hits: cacheHits, newly_admitted: newlyAdmitted,
    terminal_failures: count("transport_failure", "accounting_invalid"), resource_exhausted: count("resource_exhausted"),
    accounting_invalid: count("accounting_invalid"),
    attempts, interpreted: count("interpreted"),
    abstained: count("abstained"), cached_invalid: rows.filter(row => row.shard !== undefined &&
      ["invalid", "core_rejected", "incomplete", "transport_failure", "accounting_invalid"].includes(row.status)).length,
    unattempted: count("unattempted"), unknown: count("unknown"), pending: count("pending"),
    incomplete: count("incomplete"), rejected: count("invalid", "core_rejected", "accounting_invalid")
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

/** Revisions use the exact durable parent raw and terminal physical response, including rejected semantics. */
export function prepareRetainedSemanticProposalRevision(input: Readonly<{
  workset: SemanticProposalWorkset; parentCacheRoot: string; maxOutputTokens: number; itemIndex: number;
  reviewComments?: readonly string[]; attentionRequestSha256?: string;
  retainedParent?: RetainedSemanticQueryParent;
}>): SourceSemanticProposalRevision {
  const item = input.workset.items[input.itemIndex];
  if (item === undefined || typeof item !== "object" || item === null || Array.isArray(item) ||
      Object.hasOwn(item, "revision") || Object.hasOwn(item, "retained_parent")) {
    throw new AlayaError("VALIDATION", "proposal revision requires one unrevised original item");
  }
  const parent = resolveSemanticProposalRevisionParent(input.workset,
    { ...item, ...(input.retainedParent === undefined ? {} : { retained_parent: input.retainedParent }) },
    input.maxOutputTokens);
  const raw = completeProposalParentRaw(input.workset, input.parentCacheRoot, input.maxOutputTokens, parent);
  return prepareSourceSemanticProposalRevision({ kind: input.workset.kind,
    parent_request: parent.request, previous_response: raw,
    response_completion: "complete", review_comments: input.reviewComments,
    attention_request_sha256: input.attentionRequestSha256 });
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
      assertSemanticProposalExecutionRoot(input.authority.execution_scope, input.cacheRoot, writeLease);
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
