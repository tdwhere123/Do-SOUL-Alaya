import { AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import {
  inspectExtractionAttemptLedger, openExtractionAttemptLedger
} from "../extraction/authority/attempt-ledger.js";
import { settledAttemptUsageDigest } from "../extraction/authority/attempt-ledger/outcome.js";
import { isExtractionRequestProfile } from "../extraction/request-profile.js";
import { baseReportedUsage } from "../extraction/authority/step-quote.js";
import type { ExtractionCacheWriteLease } from "../extraction/fill/manifest/fill-root-guard.js";
import {
  bindProviderRawAttempt, listProviderRawAttempts,
  providerRawSuccessEvidenceState, readProviderRawAttempt, verifyProviderRawReservation,
  type ProviderRawAttempt
} from "../extraction/fill/provider-raw-attempt.js";
import {
  assertEvidenceSelectionExecutionScope, evidenceSelectionAttemptLineage,
  verifyEvidenceSelectionAuthority, type EvidenceSelectionAuthority
} from "./authority.js";
import {
  EvidenceSelectionIdentityError, hasAdmittedSelectionOutcome, inspectEvidenceSelectionShard,
  type EvidenceSelectionLookup, type EvidenceSelectionShard
} from "./artifact.js";
import { EVIDENCE_SELECTION_KIND, type EvidenceSelectionLine, type EvidenceSelectionWorkset } from "./input.js";

export function evidenceSelectionLookup(
  workset: EvidenceSelectionWorkset, line: EvidenceSelectionLine, maxOutputTokens: number
): EvidenceSelectionLookup {
  return {
    model: workset.model,
    request_profile: workset.request_profile,
    system_prompt: line.systemPrompt,
    user_prompt: line.userPrompt,
    schema: line.responseJsonSchema,
    max_output_tokens: maxOutputTokens,
    provider_url: workset.provider_url,
    request_digest: line.requestDigest,
    sources_digest: line.sourcesDigest,
    transport_provenance: line.transportProvenance,
    attempt_lineage_digest: evidenceSelectionAttemptLineage({
      model: workset.model,
      request_profile: workset.request_profile,
      transport_provenance: line.transportProvenance
    })
  };
}

export function readEvidenceSelectionAttemptState(
  cacheRoot: string, cacheKey: string, expected: EvidenceSelectionLookup
) {
  if (expected.attempt_lineage_digest === undefined) {
    throw new EvidenceSelectionIdentityError("evidence selection lookup lacks attempt lineage");
  }
  if (!isExtractionRequestProfile(expected.request_profile)) {
    throw new EvidenceSelectionIdentityError("evidence selection lookup has unsupported profile");
  }
  const ledger = inspectExtractionAttemptLedger({
    cacheRoot,
    lineageDigest: expected.attempt_lineage_digest,
    cacheIdentity: { model: expected.model, requestProfile: expected.request_profile }
  });
  const shard = inspectEvidenceSelectionShard(cacheRoot, cacheKey, expected);
  const raws = listProviderRawAttempts(cacheRoot, cacheKey);
  for (const raw of raws) assertSelectionRawReservation(raw, ledger, expected, cacheKey);
  if (shard !== undefined) {
    const raw = raws.find((item) => item.attempt_ordinal === shard.attempt_ordinal);
    if (raw === undefined) throw new EvidenceSelectionIdentityError("evidence selection shard lacks its reserved raw attempt");
    assertSelectionShardRaw(shard, raw);
  }
  const unresolved = ledger?.unresolvedAttempts.filter((attempt) => attempt.cacheKey === cacheKey) ?? [];
  const settled = [...(ledger?.settledAttempts ?? []), ...(ledger?.transportFailures ?? [])]
    .filter((attempt) => attempt.cacheKey === cacheKey)
    .sort((left, right) => right.attemptOrdinal - left.attemptOrdinal)[0];
  let status: "unknown" | "pending" | "transport_failure" | "incomplete" | "settled" = "settled";
  if (ledger !== undefined && !ledger.historyComplete) status = "incomplete";
  else if (unresolved.some((attempt) => !raws.some((raw) => raw.attempt_ordinal === attempt.attemptOrdinal))) {
    status = "unknown";
  } else if (unresolved.length > 0 || shard === undefined && raws.length > 0) status = "pending";
  else if (shard === undefined && settled !== undefined) {
    status = ledger?.transportFailures.some((attempt) => attempt.attemptOrdinal === settled.attemptOrdinal)
      ? "transport_failure" : "incomplete";
  } else if (ledger?.pendingKeys.includes(cacheKey)) status = "pending";
  if (shard !== undefined && hasAdmittedSelectionOutcome(shard) && status === "settled") {
    const success = ledger?.successfulEntries.find((entry) => entry.cacheKey === cacheKey);
    if (success?.successKind !== "provider" || success.rawJsonSha256 !== shard.raw_digest ||
        success.attemptOrdinal !== shard.attempt_ordinal ||
        success.authorityLineageDigest !== shard.attempt_lineage_digest ||
        canonicalJson(success.transportProvenance) !== canonicalJson(shard.transport_provenance)) {
      throw new EvidenceSelectionIdentityError("evidence selection shard lacks durable successful admission");
    }
  }
  return { shard, ledger, status };
}

export function assertSelectionRawReservation(
  raw: ProviderRawAttempt,
  ledger: ReturnType<typeof inspectExtractionAttemptLedger>,
  expected: EvidenceSelectionLookup,
  cacheKey: string
): void {
  if (expected.attempt_lineage_digest === undefined) {
    throw new EvidenceSelectionIdentityError("evidence selection lookup lacks attempt lineage");
  }
  bindProviderRawAttempt(raw, {
    cacheKey,
    kind: EVIDENCE_SELECTION_KIND,
    model: expected.model,
    requestProfile: expected.request_profile,
    requestDigest: expected.request_digest ?? raw.request_digest,
    attemptLineageDigest: expected.attempt_lineage_digest
  });
  verifyProviderRawReservation(raw, ledger);
}

function assertSelectionShardRaw(shard: EvidenceSelectionShard, raw: ProviderRawAttempt): void {
  if (raw.kind !== EVIDENCE_SELECTION_KIND || raw.attempt_ordinal !== shard.attempt_ordinal ||
      raw.attempt_lineage_digest !== shard.attempt_lineage_digest ||
      raw.request_digest !== shard.request_digest ||
      raw.decoded_text !== shard.raw_json || raw.finish_reason !== shard.finish_reason ||
      raw.completion_witness !== shard.completion_witness ||
      canonicalJson(baseReportedUsage(raw.usage) ?? null) !== canonicalJson(shard.usage ?? null) ||
      hasAdmittedSelectionOutcome(shard) && (!raw.full_replay_possible || raw.decoded_text_digest !== shard.raw_digest ||
        raw.transport_failure !== undefined || providerRawSuccessEvidenceState(raw) !== "bound")) {
    throw new EvidenceSelectionIdentityError("evidence selection success differs from its reserved raw attempt");
  }
}

export function openEvidenceSelectionAttemptLedger(input: Readonly<{
  cacheRoot: string;
  authority: EvidenceSelectionAuthority;
  writeLease?: ExtractionCacheWriteLease;
}>) {
  const authority = verifyEvidenceSelectionAuthority(input.authority);
  assertEvidenceSelectionExecutionScope(authority.execution_scope, input.cacheRoot, input.writeLease);
  if (!isExtractionRequestProfile(authority.request_profile)) {
    throw new AlayaError("VALIDATION", "evidence selection attempt ledger requires an extraction request profile");
  }
  if (authority.limits.maximum_attempts < 1) {
    throw new AlayaError("CONFLICT", "evidence selection authority has no remaining provider attempt capacity");
  }
  const lineage = authority.attempt_lineage_digest;
  return openExtractionAttemptLedger({
    cacheRoot: input.cacheRoot,
    publicationTemporaryDirectory: input.cacheRoot,
    lineageDigest: lineage,
    requireSingleLineageForCacheIdentity: true,
    cacheIdentity: {
      model: authority.model,
      requestProfile: authority.request_profile
    },
    startingMissing: authority.limits.starting_missing,
    maximumAttempts: authority.limits.maximum_attempts,
    maximumAttemptsPerKey: authority.limits.maximum_attempts_per_key,
    successfulShardCeiling: authority.limits.successful_shard_ceiling,
    inspectProviderShard: (cacheRoot, cacheKey, identity) => {
      const shard = inspectEvidenceSelectionShard(cacheRoot, cacheKey, {
        model: identity.model,
        request_profile: identity.requestProfile,
        attempt_lineage_digest: lineage
      });
      if (shard === undefined || !hasAdmittedSelectionOutcome(shard) ||
          shard.transport_provenance === undefined || shard.raw_digest === undefined) {
        return undefined;
      }
      if (canonicalJson(shard.transport_provenance) !== canonicalJson(authority.transport_provenance)) {
        throw new AlayaError("CONFLICT", "evidence selection success differs from authorized physical transport");
      }
      const raw = readProviderRawAttempt(cacheRoot, cacheKey, shard.attempt_ordinal);
      if (raw === undefined) throw new AlayaError("CONFLICT", "evidence selection success lacks its reserved raw attempt");
      assertSelectionRawReservation(raw, inspectExtractionAttemptLedger({
        cacheRoot, lineageDigest: lineage, cacheIdentity: identity
      }), {
        model: identity.model,
        request_profile: identity.requestProfile,
        request_digest: shard.request_digest,
        attempt_lineage_digest: lineage
      }, cacheKey);
      assertSelectionShardRaw(shard, raw);
      return {
        cacheKey,
        rawJsonSha256: shard.raw_digest,
        successKind: "provider" as const,
        transportProvenance: shard.transport_provenance,
        attemptOrdinal: shard.attempt_ordinal,
        authorityLineageDigest: shard.attempt_lineage_digest,
        usageSha256: settledAttemptUsageDigest(baseReportedUsage(raw.usage))
      };
    }
  });
}
