import { openExtractionAttemptLedger } from "../extraction/authority/attempt-ledger.js";
import { isExtractionRequestProfile } from "../extraction/request-profile.js";
import { inspectSemanticProposalShard, isExecutableProposalShard } from "./artifact.js";
import type { SemanticProposalAuthority } from "./authority.js";
import type { SemanticProposalKind } from "./workset.js";

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
  return openExtractionAttemptLedger({
    cacheRoot: input.cacheRoot,
    lineageDigest: input.authority.identity_digest,
    cacheIdentity: {
      model: input.authority.model,
      requestProfile: input.authority.request_profile
    },
    startingMissing: input.authority.limits.starting_missing,
    maximumAttempts: input.authority.limits.maximum_attempts,
    successfulShardCeiling: input.authority.limits.successful_shard_ceiling,
    inspectProviderShard: (cacheRoot, cacheKey, identity) => {
      const shard = inspectSemanticProposalShard(cacheRoot, cacheKey, {
        kind: input.kind, model: identity.model, request_profile: identity.requestProfile
      });
      if (shard === undefined || !isExecutableProposalShard(shard) ||
          shard.transport_provenance === undefined || shard.raw_digest === undefined) {
        return undefined;
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
