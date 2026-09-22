import { listExtractionAttemptLedgerRecords, openExtractionAttemptLedger } from "../extraction/authority/attempt-ledger.js";
import { isExtractionRequestProfile } from "../extraction/request-profile.js";
import { inspectSemanticProposalShard, isExecutableProposalShard } from "./artifact.js";
import type { SemanticProposalAuthority } from "./authority.js";
import type { SemanticProposalKind } from "./workset.js";
import { readProviderRawAttempt, bindProviderRawAttempt } from "../extraction/fill/provider-raw-attempt.js";

export function openSemanticProposalAttemptLedger(input: Readonly<{
  cacheRoot: string;
  authority: SemanticProposalAuthority;
  kind: SemanticProposalKind;
}>) {
  if (!isExtractionRequestProfile(input.authority.request_profile)) {
    throw new Error("semantic proposal attempt ledger requires an extraction request profile");
  }
  if (input.authority.limits.maximum_attempts < 1) {
    throw new Error("semantic proposal authority has no remaining provider attempt capacity");
  }
  const lineage = input.authority.attempt_lineage_digest;
  const records = listExtractionAttemptLedgerRecords(input.cacheRoot);
  if (records.some(record => record.lineage_digest !== lineage &&
      record.cache_identity.model === input.authority.model &&
      record.cache_identity.requestProfile === input.authority.request_profile)) {
    throw new Error("proposal cache contains another execution lineage; explicit settled continuation is required");
  }
  return openExtractionAttemptLedger({
    cacheRoot: input.cacheRoot,
    lineageDigest: lineage,
    cacheIdentity: {
      model: input.authority.model,
      requestProfile: input.authority.request_profile
    },
    startingMissing: input.authority.limits.starting_missing,
    maximumAttempts: input.authority.limits.maximum_attempts,
    successfulShardCeiling: input.authority.limits.successful_shard_ceiling,
    inspectProviderShard: (cacheRoot, cacheKey, identity) => {
      const shard = inspectSemanticProposalShard(cacheRoot, cacheKey, {
        kind: input.kind, model: identity.model, request_profile: identity.requestProfile,
        attempt_lineage_digest: lineage
      });
      if (shard === undefined || !isExecutableProposalShard(shard) ||
          shard.transport_provenance === undefined || shard.raw_digest === undefined) {
        return undefined;
      }
      const raw = readProviderRawAttempt(cacheRoot, cacheKey, shard.attempt_ordinal);
      if (raw === undefined) throw new Error("proposal success lacks its reserved raw attempt");
      bindProviderRawAttempt(raw, { cacheKey, kind: input.kind, model: identity.model,
        requestProfile: identity.requestProfile, requestDigest: shard.request_digest, attemptLineageDigest: lineage });
      if (raw.decoded_text_digest !== shard.raw_digest || raw.finish_reason !== shard.finish_reason) {
        throw new Error("proposal success differs from its reserved raw attempt");
      }
      return {
        cacheKey,
        rawJsonSha256: shard.raw_digest,
        successKind: "provider" as const,
        transportProvenance: shard.transport_provenance
      };
    }
  });
}
