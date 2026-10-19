import { classifyRetainedExtractionAttemptState, inspectExtractionAttemptLedger, ledgerPath,
  type ExtractionAttemptLedgerSnapshot } from "../extraction/authority/attempt-ledger.js";
import { isExtractionRequestProfile } from "../extraction/request-profile.js";
import { canonicalJson } from "@do-soul/alaya-protocol";
import { inspectSemanticProposalShard, hasAdmittedProposalOutcome, semanticProposalShardPath, SemanticProposalIdentityError,
  type SemanticProposalLookup, type SemanticProposalShard } from "./artifact.js";
import { proposalAttemptLineage } from "./identity.js";
import { materializeSemanticProposalLines, resolveSemanticProposalRevisionParent, type SemanticProposalLine,
  type SemanticProposalWorkset } from "./workset.js";
import { bindProviderRawAttempt, verifyProviderRawReservation, listProviderRawAttempts,
  providerRawAttemptInputPaths, providerRawSuccessEvidenceState,
  providerRawArtifactUsageMatches,
  type ProviderRawAttempt } from "../extraction/fill/provider-raw-attempt.js";
import { dirname } from "node:path";

export function semanticProposalLookup(
  workset: SemanticProposalWorkset, line: SemanticProposalLine, maxOutputTokens: number
): SemanticProposalLookup {
  return {
    kind: workset.kind, model: workset.model, request_profile: workset.request_profile,
    system_prompt: line.systemPrompt, user_prompt: line.userPrompt,
    schema: line.responseJsonSchema, max_output_tokens: maxOutputTokens,
    provider_url: workset.provider_url, request_digest: line.requestDigest, transport_provenance: line.transportProvenance,
    attempt_lineage_digest: proposalAttemptLineage({ ...workset, transport_provenance: line.transportProvenance })
  };
}

/** Physical inputs of the proposal reader, retained independently of their semantic admission. */
export function semanticProposalCacheInputPaths(
  workset: SemanticProposalWorkset, cacheRoot: string, maxOutputTokens: number, noFollowDirectories = false
): readonly string[] {
  const paths = [cacheRoot];
  for (const item of workset.items) {
    // A malformed sibling request must not erase independently readable cache paths.
    let line: SemanticProposalLine;
    try { line = materializeSemanticProposalLines({ ...workset, items: [item] }, maxOutputTokens)[0]!; }
    catch { continue; }
    const shard = semanticProposalShardPath(cacheRoot, line.key);
    paths.push(dirname(shard), shard, ledgerPath(cacheRoot,
      semanticProposalLookup(workset, line, maxOutputTokens).attempt_lineage_digest!),
      ...providerRawAttemptInputPaths(cacheRoot, line.key, noFollowDirectories));
    if (line.request.revision !== undefined && workset.revision_parent_cache_root !== undefined) {
      const parent = resolveSemanticProposalRevisionParent(workset, item, maxOutputTokens);
      const parentRoot = workset.revision_parent_cache_root;
      const parentShard = semanticProposalShardPath(parentRoot, parent.key);
      paths.push(parentRoot, dirname(parentShard), parentShard,
        ledgerPath(parentRoot, semanticProposalLookup(workset, parent, maxOutputTokens).attempt_lineage_digest!),
        ...providerRawAttemptInputPaths(parentRoot, parent.key, noFollowDirectories));
    }
  }
  return paths;
}

export function readSemanticProposalAttemptState(
  cacheRoot: string, cacheKey: string, expected: SemanticProposalLookup
) {
  if (expected.attempt_lineage_digest === undefined) throw new SemanticProposalIdentityError("proposal lookup lacks attempt lineage");
  if (!isExtractionRequestProfile(expected.request_profile)) throw new SemanticProposalIdentityError("proposal lookup has unsupported profile");
  const ledger = inspectExtractionAttemptLedger({ cacheRoot, lineageDigest: expected.attempt_lineage_digest,
    cacheIdentity: { model: expected.model, requestProfile: expected.request_profile } });
  const shard = inspectSemanticProposalShard(cacheRoot, cacheKey, expected);
  const raws = listProviderRawAttempts(cacheRoot, cacheKey);
  for (const raw of raws) assertProposalRawReservation(raw, ledger, expected, cacheKey);
  if (shard !== undefined) {
    const raw = raws.find(item => item.attempt_ordinal === shard.attempt_ordinal);
    if (raw === undefined) throw new SemanticProposalIdentityError("proposal shard lacks its reserved raw attempt");
    assertProposalShardRaw(shard, raw);
  }
  let status: ReturnType<typeof classifyRetainedExtractionAttemptState> | "accounting_invalid" =
    classifyRetainedExtractionAttemptState(ledger, cacheKey, raws.map(raw => raw.attempt_ordinal), shard !== undefined);
  if (!ledger?.unresolvedAttempts.some(attempt => attempt.cacheKey === cacheKey) && ledger?.settledAttempts.some(attempt =>
    attempt.cacheKey === cacheKey && attempt.usageAccounting === "invalid")) status = "accounting_invalid";
  if (shard !== undefined && hasAdmittedProposalOutcome(shard) && status === "settled") {
    const success = ledger?.successfulEntries.find(entry => entry.cacheKey === cacheKey);
    if (success?.successKind !== "provider" || success.rawJsonSha256 !== shard.raw_digest ||
        success.attemptOrdinal !== shard.attempt_ordinal ||
        success.authorityLineageDigest !== shard.attempt_lineage_digest ||
        canonicalJson(success.transportProvenance) !== canonicalJson(shard.transport_provenance)) {
      throw new SemanticProposalIdentityError("proposal shard lacks durable successful admission");
    }
  }
  return { shard, ledger, status };
}

function assertProposalRawReservation(
  raw: ProviderRawAttempt, ledger: ExtractionAttemptLedgerSnapshot | undefined,
  expected: SemanticProposalLookup, cacheKey: string
): void {
  if (expected.attempt_lineage_digest === undefined) throw new SemanticProposalIdentityError("proposal lookup lacks attempt lineage");
  bindProviderRawAttempt(raw, { cacheKey, kind: expected.kind, model: expected.model,
    requestProfile: expected.request_profile, requestDigest: expected.request_digest ?? raw.request_digest,
    attemptLineageDigest: expected.attempt_lineage_digest });
  verifyProviderRawReservation(raw, ledger, "executable", expected.max_output_tokens);
}

function assertProposalShardRaw(shard: SemanticProposalShard, raw: ProviderRawAttempt): void {
  if (raw.kind === "source_semantic" || raw.attempt_ordinal !== shard.attempt_ordinal ||
      raw.attempt_lineage_digest !== shard.attempt_lineage_digest ||
      raw.request_digest !== shard.request_digest ||
      raw.decoded_text !== shard.raw_json || raw.finish_reason !== shard.finish_reason ||
      raw.completion_witness !== shard.completion_witness ||
      !providerRawArtifactUsageMatches(raw, shard) ||
      hasAdmittedProposalOutcome(shard) && (!raw.full_replay_possible || raw.decoded_text_digest !== shard.raw_digest ||
        raw.transport_failure !== undefined || providerRawSuccessEvidenceState(raw) !== "bound")) {
    throw new SemanticProposalIdentityError("proposal success differs from its reserved raw attempt");
  }
}

