import { inspectExtractionAttemptLedger, openExtractionAttemptLedger } from "../extraction/authority/attempt-ledger.js";
import { isExtractionRequestProfile } from "../extraction/request-profile.js";
import { isChatSemanticRequestProfile, AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import { inspectSemanticProposalShard, hasAdmittedProposalOutcome } from "../semantic-cache/artifact.js";
import { assertProposalRawReservation, assertProposalShardRaw } from "../semantic-cache/attempt.js";
import { assertSemanticProposalExecutionScope, verifySemanticProposalAuthority, type SemanticProposalAuthority } from "./authority.js";
import type { ExtractionCacheWriteLease } from "../extraction/fill/manifest/fill-root-guard.js";
import type { SemanticProposalKind } from "../semantic-cache/workset.js";
import { readProviderRawAttempt } from "../extraction/fill/provider-raw-attempt.js";
import { baseReportedUsage } from "../extraction/authority/step-quote.js";
import { settledAttemptUsageDigest } from "../extraction/authority/attempt-ledger/outcome.js";

// Compatibility for existing proposal fill callers; remove with the gated research deletion.
export * from "../semantic-cache/attempt.js";

export function openSemanticProposalAttemptLedger(input: Readonly<{
  cacheRoot: string;
  authority: SemanticProposalAuthority;
  kind: SemanticProposalKind;
  writeLease?: ExtractionCacheWriteLease;
}>) {
  const authority = verifySemanticProposalAuthority(input.authority);
  assertSemanticProposalExecutionScope(authority.execution_scope, input.cacheRoot, input.writeLease);
  if (authority.kind !== input.kind) throw new AlayaError("CONFLICT", "semantic proposal attempt ledger kind differs from authority");
  if (!isExtractionRequestProfile(input.authority.request_profile)) {
    throw new AlayaError("VALIDATION", "semantic proposal attempt ledger requires an extraction request profile");
  }
  if (input.authority.limits.maximum_attempts < 1) {
    throw new AlayaError("CONFLICT", "semantic proposal authority has no remaining provider attempt capacity");
  }
  const lineage = input.authority.attempt_lineage_digest;
  return openExtractionAttemptLedger({
    cacheRoot: input.cacheRoot,
    publicationTemporaryDirectory: input.cacheRoot,
    lineageDigest: lineage,
    requireSingleLineageForCacheIdentity: true,
    cacheIdentity: { model: input.authority.model, requestProfile: input.authority.request_profile },
    startingMissing: input.authority.limits.starting_missing,
    maximumAttempts: input.authority.limits.maximum_attempts,
    ...(isChatSemanticRequestProfile(input.authority.request_profile)
      ? { maximumAttemptsPerKey: input.authority.limits.maximum_attempts_per_key } : {}),
    successfulShardCeiling: input.authority.limits.successful_shard_ceiling,
    inspectProviderShard: (cacheRoot, cacheKey, identity) => {
      const shard = inspectSemanticProposalShard(cacheRoot, cacheKey, {
        kind: input.kind, model: identity.model, request_profile: identity.requestProfile,
        attempt_lineage_digest: lineage
      });
      if (shard === undefined || !hasAdmittedProposalOutcome(shard) ||
          shard.transport_provenance === undefined || shard.raw_digest === undefined) return undefined;
      if (canonicalJson(shard.transport_provenance) !== canonicalJson(authority.transport_provenance)) {
        throw new AlayaError("CONFLICT", "proposal success differs from authorized physical transport");
      }
      const raw = readProviderRawAttempt(cacheRoot, cacheKey, shard.attempt_ordinal);
      if (raw === undefined) throw new AlayaError("CONFLICT", "proposal success lacks its reserved raw attempt");
      assertProposalRawReservation(raw, inspectExtractionAttemptLedger({ cacheRoot, lineageDigest: lineage,
        cacheIdentity: identity }), { kind: input.kind, model: identity.model, request_profile: identity.requestProfile,
        request_digest: shard.request_digest, attempt_lineage_digest: lineage,
        max_output_tokens: authority.limits.max_output_tokens }, cacheKey);
      assertProposalShardRaw(shard, raw);
      return { cacheKey, rawJsonSha256: shard.raw_digest, successKind: "provider" as const,
        transportProvenance: shard.transport_provenance, attemptOrdinal: shard.attempt_ordinal,
        authorityLineageDigest: shard.attempt_lineage_digest,
        usageSha256: settledAttemptUsageDigest(baseReportedUsage(raw.usage)) };
    }
  });
}
