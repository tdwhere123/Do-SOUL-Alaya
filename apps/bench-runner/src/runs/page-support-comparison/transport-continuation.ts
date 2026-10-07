import { z } from "zod";
import { AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import { refuseRecallCampaignLiveExtraction } from "@do-soul/alaya-core";
import type { CompileSeedExtractionConfig } from "../compile-seed/compile-seed-types.js";
import { createSemanticProviderHttpExtractor } from "../compile-seed/http/semantic-provider-http.js";
import { inspectExtractionAttemptLedger, openExtractionAttemptLedger, ensureForkedExtractionAttemptLedger,
  listExtractionAttemptLedgerRecords, type ExtractionAttemptLedgerSnapshot } from "../extraction/authority/attempt-ledger.js";
import { assertMonotonicExtractionAttemptLedgerFork } from "../extraction/authority/attempt-ledger/fork-contract.js";
import { settledAttemptUsageDigest } from "../extraction/authority/attempt-ledger/outcome.js";
import { claimAttemptLedgerContinuationChild, continuationChildClaimPath } from "../extraction/authority/continuation/child-claim.js";
import { boundedArtifactEntryExists, readBoundedCanonicalUtf8Artifact } from "../extraction/cache-audit/bounded-artifact-reader.js";
import { acquireExtractionCacheWriteLease, type ExtractionCacheWriteLease } from "../extraction/fill/manifest/fill-root-guard.js";
import { listProviderRawAttempts, readProviderRawAttempt } from "../extraction/fill/provider-raw-attempt.js";
import { isExtractionRequestProfile } from "../extraction/request-profile.js";
import { baseReportedUsage } from "../extraction/authority/step-quote.js";
import { executeProviderRequestLine, replayExistingProviderRequestRaws,
  type ProviderRequestPhysicalContext } from "../provider-request/execution.js";
import { PAGE_SUPPORT_COMPARISON_SCHEMA_NAME } from "../provider-request/request-binding.js";
import { assertAuthorizedComparisonRequest, pageSupportComparisonResultFromShard, toProviderLine,
  type PageSupportComparisonResultRow } from "./execute.js";
import { interpretPageSupportComparisonDecoded } from "./assess.js";
import { assertPageSupportComparisonExecutionScope } from "./authority.js";
import type { PageSupportComparisonWorkset } from "./input.js";
import { assertComparisonRawReservation, assertComparisonShardRaw, buildPageSupportComparisonShard,
  hasAdmittedComparisonOutcome, inspectPageSupportComparisonContinuationShard,
  pageSupportComparisonLookup, writePageSupportComparisonContinuationShard } from "./persist.js";
import { assertComparisonTransportContinuationBinding, digestComparisonContinuationMaterial,
  verifyPageSupportComparisonTransportContinuationAuthority,
  type PageSupportComparisonTransportContinuationAuthority } from "./transport-continuation-authority.js";

// This is the native comparison entry used by the preparation and execution callers.
export { preparePageSupportComparisonTransportContinuation, quotePageSupportComparisonTransportContinuation,
  pinPageSupportComparisonTransportContinuationAuthority, verifyPageSupportComparisonTransportContinuationAuthority
} from "./transport-continuation-authority.js";
export type { PageSupportComparisonTransportContinuationAuthority,
  PageSupportComparisonTransportContinuationPreflight } from "./transport-continuation-authority.js";

const Digest = z.string().regex(/^[0-9a-f]{64}$/u);
const ClaimSchema = z.object({ kind: z.literal("page-support-comparison-transport-continuation-child-v1"),
  predecessor_lineage_digest: Digest, predecessor_authority_digest: Digest,
  successor_lineage_digest: Digest, successor_authority_digest: Digest, claim_digest: Digest }).strict();

export async function executePageSupportComparisonTransportContinuationFill(input: {
  workset: PageSupportComparisonWorkset; cacheRoot: string;
  authority: PageSupportComparisonTransportContinuationAuthority; config: CompileSeedExtractionConfig;
  mode?: "execute" | "recover"; extractor?: ReturnType<typeof createSemanticProviderHttpExtractor>;
}) {
  refuseRecallCampaignLiveExtraction("extraction_write");
  const authority = verifyPageSupportComparisonTransportContinuationAuthority(input.authority);
  assertPageSupportComparisonExecutionScope(authority.execution_scope, input.cacheRoot);
  const retained = assertComparisonTransportContinuationBinding(authority, input.workset, input.cacheRoot);
  assertAuthorizedComparisonRequest({ workset: input.workset, config: input.config,
    authority: retained.authority }, [retained.line], authority.max_output_tokens);
  const lease = acquireExtractionCacheWriteLease(input.cacheRoot);
  try {
    assertPageSupportComparisonExecutionScope(authority.execution_scope, input.cacheRoot, lease);
    const cacheRoot = lease.stableRootPath;
    assertComparisonTransportContinuationBinding(authority, input.workset, cacheRoot, lease);
    assertLedgerInventory(authority, cacheRoot);
    const claim = continuationClaim(authority);
    claimAttemptLedgerContinuationChild({ cacheRoot, predecessorLineageDigest: retained.authority.attempt_lineage_digest,
      claim, readExisting: readClaim });
    let snapshot = inspectChildLedger(authority, cacheRoot);
    if (snapshot === undefined) snapshot = ensureForkedExtractionAttemptLedger({ cacheRoot, publicationTemporaryDirectory: cacheRoot,
      predecessorLineageDigest: retained.authority.attempt_lineage_digest,
      predecessorLedgerSha256: authority.predecessor.ledger_sha256,
      predecessorRawLedgerSha256: authority.predecessor.ledger_raw_sha256,
      successorLineageDigest: authority.attempt_lineage_digest, successorMaximumAttempts: 2,
      cacheIdentity: ledgerIdentity(authority) });
    assertChildHistory(authority, retained.ledger, snapshot);
    const ledger = openExtractionAttemptLedger({ cacheRoot, lineageDigest: authority.attempt_lineage_digest,
      cacheIdentity: ledgerIdentity(authority), startingMissing: 1, maximumAttempts: 2,
      maximumAttemptsPerKey: 2, successfulShardCeiling: 1, publicationTemporaryDirectory: cacheRoot,
      inspectProviderShard: () => inspectChildSuccess(authority, input.workset, cacheRoot, lease) });
    const before = ledger.snapshot().attempts;
    const context = physicalContext(authority, retained.line, input.workset, cacheRoot, ledger);
    if (input.mode === "recover") replayExistingProviderRequestRaws(context, toProviderLine(retained.line));
    else await executeProviderRequestLine({ ...context, writeLease: lease, config: input.config,
      suppliedExtractor: input.extractor !== undefined,
      extractor: input.extractor ?? createSemanticProviderHttpExtractor(input.config, PAGE_SUPPORT_COMPARISON_SCHEMA_NAME),
      assertScope: () => {
        assertPageSupportComparisonExecutionScope(authority.execution_scope, cacheRoot, lease);
        assertComparisonTransportContinuationBinding(authority, input.workset, cacheRoot, lease);
        assertClaim(authority, cacheRoot);
      } }, toProviderLine(retained.line));
    const row = readPageSupportComparisonTransportContinuationResults({ workset: input.workset, cacheRoot, authority, writeLease: lease })[0]!;
    return { requested: 1, attempts: ledger.snapshot().attempts - before,
      cumulative_attempts: ledger.snapshot().attempts, assessed: row.status === "assessed" ? 1 : 0,
      newly_admitted: row.status === "assessed" && before < 2 ? 1 : 0,
      terminal_failures: row.status === "transport_failure" ? 1 : 0,
      status: row.status, row };
  } finally { lease.release(); }
}

export function readPageSupportComparisonTransportContinuationResults(input: {
  workset: PageSupportComparisonWorkset; cacheRoot: string; authority: PageSupportComparisonTransportContinuationAuthority;
  writeLease?: ExtractionCacheWriteLease;
}): readonly PageSupportComparisonResultRow[] {
  const authority = verifyPageSupportComparisonTransportContinuationAuthority(input.authority);
  const retained = assertComparisonTransportContinuationBinding(authority, input.workset, input.cacheRoot, input.writeLease);
  assertLedgerInventory(authority, input.cacheRoot);
  const ledger = inspectChildLedger(authority, input.cacheRoot);
  const raws = listProviderRawAttempts(input.cacheRoot, authority.keys[0], authority.attempt_lineage_digest);
  const shard = inspectPageSupportComparisonContinuationShard(input.cacheRoot, authority.keys[0],
    childLookup(authority, input.workset, retained.line));
  const claimed = boundedArtifactEntryExists(continuationChildClaimPath(input.cacheRoot,
    authority.predecessor.authority.attempt_lineage_digest));
  if (!claimed) {
    if (ledger !== undefined || raws.length !== 0 || shard !== undefined) throw new AlayaError("CONFLICT", "comparison continuation lacks its child claim");
    return [{ line: retained.line, status: "unattempted" }];
  }
  assertClaim(authority, input.cacheRoot);
  if (ledger === undefined) {
    if (raws.length !== 0 || shard !== undefined) throw new AlayaError("CONFLICT", "comparison continuation lacks its reserved ledger");
    return [{ line: retained.line, status: "pending" }];
  }
  assertChildHistory(authority, retained.ledger, ledger);
  for (const raw of raws) assertComparisonRawReservation(raw, ledger,
    childLookup(authority, input.workset, retained.line), retained.line.key);
  if (raws.length > 1 || raws.some(raw => raw.attempt_ordinal !== 2)) throw new AlayaError("CONFLICT", "comparison continuation has an unauthorized ordinal");
  const raw = raws[0];
  if (shard !== undefined) {
    if (raw === undefined || shard.attempt_ordinal !== 2) throw new AlayaError("CONFLICT", "comparison continuation result lacks ordinal two raw");
    assertComparisonShardRaw(shard, raw);
  }
  if (ledger.unresolvedAttempts.length !== 0) return [{ line: retained.line, shard, status: raw === undefined ? "unknown" : "pending" }];
  if (ledger.pendingKeys.length !== 0 || shard === undefined && raw !== undefined) return [{ line: retained.line, shard, status: "pending" }];
  if (shard === undefined) return [{ line: retained.line, status: ledger.attempts === 1 ? "unattempted" : "incomplete" }];
  if (hasAdmittedComparisonOutcome(shard)) {
    const success = ledger.successfulEntries[0];
    if (raw === undefined || success?.successKind !== "provider" || success.cacheKey !== retained.line.key || success.attemptOrdinal !== 2 ||
        success.authorityLineageDigest !== authority.attempt_lineage_digest || success.rawJsonSha256 !== shard.raw_digest ||
        success.usageSha256 !== settledAttemptUsageDigest(baseReportedUsage(raw.usage)) ||
        canonicalJson(success.transportProvenance) !== canonicalJson(retained.line.transportProvenance)) {
      throw new AlayaError("CONFLICT", "comparison continuation result lacks durable successful admission");
    }
  }
  return [pageSupportComparisonResultFromShard(retained.line, shard, authority.request_profile)];
}

function physicalContext(authority: PageSupportComparisonTransportContinuationAuthority,
  line: ReturnType<typeof assertComparisonTransportContinuationBinding>["line"], workset: PageSupportComparisonWorkset,
  cacheRoot: string, ledger: ReturnType<typeof openExtractionAttemptLedger>): ProviderRequestPhysicalContext {
  return { cacheRoot, model: authority.model, requestProfile: authority.request_profile,
    attemptLineageDigest: authority.attempt_lineage_digest, continuationLineageDigest: authority.attempt_lineage_digest,
    maxOutputTokens: authority.max_output_tokens, maximumAttemptsPerKey: 2,
    settledPredecessorAttemptOrdinals: new Set([1]), ledger,
    assertReservation: raw => {
      if (raw.attempt_ordinal !== 2) throw new AlayaError("CONFLICT", "comparison continuation requires ordinal two");
      assertComparisonRawReservation(raw, ledger.snapshot(), childLookup(authority, workset, line), line.key);
    },
    interpretDecoded: (_providerLine, decoded) => interpretPageSupportComparisonDecoded(line, decoded, authority.request_profile),
    publishArtifact: published => {
      if (published.attemptOrdinal !== 2) throw new AlayaError("CONFLICT", "comparison continuation cannot publish another ordinal");
      writePageSupportComparisonContinuationShard(cacheRoot, buildPageSupportComparisonShard({ line, published,
        model: authority.model, requestProfile: authority.request_profile, maxOutputTokens: authority.max_output_tokens,
        attemptLineageDigest: authority.attempt_lineage_digest }));
    } };
}

function inspectChildSuccess(authority: PageSupportComparisonTransportContinuationAuthority,
  workset: PageSupportComparisonWorkset, cacheRoot: string, writeLease: ExtractionCacheWriteLease) {
  const retained = assertComparisonTransportContinuationBinding(authority, workset, cacheRoot, writeLease);
  const shard = inspectPageSupportComparisonContinuationShard(cacheRoot, authority.keys[0], childLookup(authority, workset, retained.line));
  if (shard === undefined || !hasAdmittedComparisonOutcome(shard)) return undefined;
  const raw = readProviderRawAttempt(cacheRoot, authority.keys[0], 2, authority.attempt_lineage_digest);
  if (raw === undefined || shard.attempt_ordinal !== 2 || shard.raw_digest === undefined) throw new AlayaError("CONFLICT", "comparison continuation success lacks its raw");
  assertComparisonRawReservation(raw, inspectChildLedger(authority, cacheRoot), childLookup(authority, workset, retained.line), retained.line.key);
  assertComparisonShardRaw(shard, raw);
  pageSupportComparisonResultFromShard(retained.line, shard, authority.request_profile);
  return { cacheKey: retained.line.key, rawJsonSha256: shard.raw_digest, successKind: "provider" as const,
    transportProvenance: shard.transport_provenance, attemptOrdinal: 2,
    authorityLineageDigest: authority.attempt_lineage_digest, usageSha256: settledAttemptUsageDigest(baseReportedUsage(raw.usage)) };
}

function ledgerIdentity(authority: PageSupportComparisonTransportContinuationAuthority) {
  const requestProfile = authority.request_profile;
  if (!isExtractionRequestProfile(requestProfile)) throw new AlayaError("VALIDATION", "comparison profile is unsupported");
  return { model: authority.model, requestProfile };
}

function inspectChildLedger(authority: PageSupportComparisonTransportContinuationAuthority, cacheRoot: string) {
  return inspectExtractionAttemptLedger({ cacheRoot, lineageDigest: authority.attempt_lineage_digest, cacheIdentity: ledgerIdentity(authority) });
}

function childLookup(authority: PageSupportComparisonTransportContinuationAuthority, workset: PageSupportComparisonWorkset,
  line: ReturnType<typeof assertComparisonTransportContinuationBinding>["line"]) {
  return { ...pageSupportComparisonLookup(workset, line, authority.max_output_tokens), attempt_lineage_digest: authority.attempt_lineage_digest };
}

function assertChildHistory(authority: PageSupportComparisonTransportContinuationAuthority,
  predecessor: ExtractionAttemptLedgerSnapshot, successor: ExtractionAttemptLedgerSnapshot): void {
  assertMonotonicExtractionAttemptLedgerFork({ predecessor, successor,
    successorLineageDigest: authority.attempt_lineage_digest, allowInFlightSuccessor: true });
  const reservations = [...successor.settledAttempts, ...successor.unresolvedAttempts, ...successor.transportFailures];
  if (!successor.historyComplete || successor.maximumAttempts !== 2 || successor.attempts > 2 ||
      reservations.some(item => item.cacheKey !== authority.keys[0] || ![1, 2].includes(item.attemptOrdinal)) ||
      successor.successfulEntries.some(item => item.successKind !== "provider" || item.attemptOrdinal !== 2 || item.authorityLineageDigest !== authority.attempt_lineage_digest)) {
    throw new AlayaError("CONFLICT", "comparison continuation ledger exceeds its inherited finite scope");
  }
}

function assertLedgerInventory(authority: PageSupportComparisonTransportContinuationAuthority, cacheRoot: string): void {
  const identity = ledgerIdentity(authority);
  if (listExtractionAttemptLedgerRecords(cacheRoot).some(record => canonicalJson(record.cache_identity) === canonicalJson(identity) &&
      ![authority.predecessor.authority.attempt_lineage_digest, authority.attempt_lineage_digest].includes(record.lineage_digest))) {
    throw new AlayaError("CONFLICT", "comparison continuation root contains an unrelated lineage");
  }
}

function continuationClaim(authority: PageSupportComparisonTransportContinuationAuthority) {
  const body = { kind: "page-support-comparison-transport-continuation-child-v1" as const,
    predecessor_lineage_digest: authority.predecessor.authority.attempt_lineage_digest,
    predecessor_authority_digest: authority.predecessor.authority.identity_digest,
    successor_lineage_digest: authority.attempt_lineage_digest, successor_authority_digest: authority.identity_digest };
  return { ...body, claim_digest: digestComparisonContinuationMaterial(body) };
}

function readClaim(path: string) {
  const claim = ClaimSchema.parse(JSON.parse(readBoundedCanonicalUtf8Artifact({ path, maxBytes: 32_768, label: "comparison continuation child claim" })));
  const { claim_digest, ...body } = claim;
  if (claim_digest !== digestComparisonContinuationMaterial(body)) throw new AlayaError("CONFLICT", "comparison continuation child claim digest differs");
  return claim;
}

function assertClaim(authority: PageSupportComparisonTransportContinuationAuthority, cacheRoot: string): void {
  const actual = readClaim(continuationChildClaimPath(cacheRoot, authority.predecessor.authority.attempt_lineage_digest));
  if (canonicalJson(actual) !== canonicalJson(continuationClaim(authority))) throw new AlayaError("CONFLICT", "comparison predecessor already belongs to another continuation child");
}
