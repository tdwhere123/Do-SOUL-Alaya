import { inspectExtractionAttemptLedger,
  listExtractionAttemptLedgerRecords, openExtractionAttemptLedger,
  type ExtractionAttemptLedgerSnapshot } from "../extraction/authority/attempt-ledger.js";
import { isExtractionRequestProfile } from "../extraction/request-profile.js";
import { canonicalJson } from "@do-soul/alaya-protocol";
import { inspectSemanticProposalShard, hasAdmittedProposalOutcome, SemanticProposalIdentityError,
  type SemanticProposalLookup, type SemanticProposalShard } from "./artifact.js";
import type { SemanticProposalAuthority } from "./authority.js";
import type { SemanticProposalKind } from "./workset.js";
import { readProviderRawAttempt, bindProviderRawAttempt, assertProviderRawReservation, listProviderRawAttempts,
  type ProviderRawAttempt } from "../extraction/fill/provider-raw-attempt.js";

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
  const unresolved = ledger?.unresolvedAttempts.filter(attempt => attempt.cacheKey === cacheKey) ?? [];
  const settled = [...(ledger?.settledAttempts ?? []), ...(ledger?.transportFailures ?? [])]
    .filter(attempt => attempt.cacheKey === cacheKey).sort((left, right) => right.attemptOrdinal - left.attemptOrdinal)[0];
  let status: "unknown" | "pending" | "transport_failure" | "incomplete" | "settled" = "settled";
  if (unresolved.some(attempt => !raws.some(raw => raw.attempt_ordinal === attempt.attemptOrdinal))) status = "unknown";
  else if (unresolved.length > 0 || shard === undefined && raws.length > 0) status = "pending";
  else if (shard === undefined && settled !== undefined) {
    status = ledger?.transportFailures.some(attempt => attempt.attemptOrdinal === settled.attemptOrdinal)
      ? "transport_failure" : "incomplete";
  } else if (ledger?.pendingKeys.includes(cacheKey)) status = "pending";
  if (shard !== undefined && hasAdmittedProposalOutcome(shard) && status === "settled") {
    const success = ledger?.successfulEntries.find(entry => entry.cacheKey === cacheKey);
    if (success?.successKind !== "provider" || success.rawJsonSha256 !== shard.raw_digest ||
        canonicalJson(success.transportProvenance) !== canonicalJson(shard.transport_provenance)) {
      throw new SemanticProposalIdentityError("proposal shard lacks durable successful admission");
    }
  }
  return { shard, ledger, status };
}

export function assertProposalRawReservation(
  raw: ProviderRawAttempt, ledger: ExtractionAttemptLedgerSnapshot | undefined,
  expected: SemanticProposalLookup, cacheKey: string
): void {
  if (expected.attempt_lineage_digest === undefined) throw new SemanticProposalIdentityError("proposal lookup lacks attempt lineage");
  bindProviderRawAttempt(raw, { cacheKey, kind: expected.kind, model: expected.model,
    requestProfile: expected.request_profile, requestDigest: expected.request_digest ?? raw.request_digest,
    attemptLineageDigest: expected.attempt_lineage_digest });
  assertProviderRawReservation(raw, ledger);
}

function assertProposalShardRaw(shard: SemanticProposalShard, raw: ProviderRawAttempt): void {
  if (raw.decoded_text !== shard.raw_json || raw.finish_reason !== shard.finish_reason ||
      raw.completion_witness !== shard.completion_witness ||
      canonicalJson(raw.usage) !== canonicalJson(shard.usage ?? null) ||
      hasAdmittedProposalOutcome(shard) && (!raw.full_replay_possible || raw.decoded_text_digest !== shard.raw_digest ||
        raw.transport_failure !== undefined)) {
    throw new SemanticProposalIdentityError("proposal success differs from its reserved raw attempt");
  }
}

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
      if (shard === undefined || !hasAdmittedProposalOutcome(shard) ||
          shard.transport_provenance === undefined || shard.raw_digest === undefined) {
        return undefined;
      }
      const raw = readProviderRawAttempt(cacheRoot, cacheKey, shard.attempt_ordinal);
      if (raw === undefined) throw new Error("proposal success lacks its reserved raw attempt");
      assertProposalRawReservation(raw, inspectExtractionAttemptLedger({ cacheRoot, lineageDigest: lineage,
        cacheIdentity: identity }), { kind: input.kind, model: identity.model, request_profile: identity.requestProfile,
        request_digest: shard.request_digest, attempt_lineage_digest: lineage }, cacheKey);
      assertProposalShardRaw(shard, raw);
      return {
        cacheKey,
        rawJsonSha256: shard.raw_digest,
        successKind: "provider" as const,
        transportProvenance: shard.transport_provenance
      };
    }
  });
}
