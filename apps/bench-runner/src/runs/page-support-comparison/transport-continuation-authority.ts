import { createHash } from "node:crypto";
import { z } from "zod";
import { AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import { boundedArtifactEntryExists } from "../extraction/cache-audit/bounded-artifact-reader.js";
import { continuationChildClaimPath } from "../extraction/authority/continuation/child-claim.js";
import { isExtractionRequestProfile } from "../extraction/request-profile.js";
import { listExtractionAttemptLedgerRecords } from "../extraction/authority/attempt-ledger.js";
import type { ExtractionCacheWriteLease } from "../extraction/fill/manifest/fill-root-guard.js";
import { StepQuoteBasisSchema, assertStepQuoteRates } from "../extraction/authority/step-quote.js";
import { hasProviderRawContinuationAttempts, listProviderRawAttempts, readProviderRawAttemptWithFileWitness } from "../extraction/fill/provider-raw-attempt.js";
import { assertAuthorizedComparisonRequest } from "./execute.js";
import { materializePageSupportComparisonLines, PageSupportComparisonWorksetSchema,
  PAGE_SUPPORT_COMPARISON_KIND, type PageSupportComparisonWorkset } from "./input.js";
import { PageSupportComparisonAuthoritySchema, assertPageSupportComparisonExecutionRoot,
  inspectPageSupportComparisonExecutionScope,
  quotePageSupportComparison, verifyPageSupportComparisonAuthority,
  type PageSupportComparisonAuthority } from "./authority.js";
import { comparisonOutcomeStatus, inspectPageSupportComparisonShardWitness,
  hasPageSupportComparisonContinuationResults, pageSupportComparisonLookup, readPageSupportComparisonAttemptState } from "./persist.js";

const Digest = z.string().regex(/^[0-9a-f]{64}$/u);
const PREFLIGHT_CONTRACT = "page-support-comparison-transport-continuation-preflight-v1";
const AUTHORITY_CONTRACT = "page-support-comparison-transport-continuation-authority-v1";
const PredecessorSchema = z.object({
  authority: PageSupportComparisonAuthoritySchema,
  ledger_sha256: Digest, ledger_raw_sha256: Digest,
  raw_file_sha256: Digest, shard_file_sha256: Digest
}).strict();
const PreflightSchema = z.object({
  contract: z.literal(PREFLIGHT_CONTRACT), kind: z.literal(PAGE_SUPPORT_COMPARISON_KIND),
  workset: PageSupportComparisonWorksetSchema,
  model: z.string().min(1), request_profile: z.string().min(1),
  key: Digest, request_digest: Digest, material_digest: Digest,
  predecessor: PredecessorSchema,
  execution_scope: PageSupportComparisonAuthoritySchema.shape.execution_scope,
  attempt_lineage_digest: Digest,
  provider_calls: z.literal(0), maximum_attempts: z.literal(1),
  cumulative_maximum_attempts: z.literal(2), next_attempt_ordinal: z.literal(2),
  max_output_tokens: z.number().int().positive(),
  maximum_input_tokens_per_attempt: z.number().int().nonnegative(),
  quote_basis: StepQuoteBasisSchema.optional()
}).strict();
const QuoteSchema = z.object({
  incremental_upper_usd: z.number().nonnegative(), predecessor_risk_upper_usd: z.number().nonnegative(),
  cumulative_risk_upper_usd: z.number().nonnegative(),
  incremental_maximum_attempts: z.literal(1), cumulative_maximum_attempts: z.literal(2),
  next_attempt_ordinal: z.literal(2), provider_currency: z.literal("CNY").optional(),
  incremental_upper_cny: z.number().nonnegative().optional(),
  predecessor_risk_upper_cny: z.number().nonnegative().optional(),
  cumulative_risk_upper_cny: z.number().nonnegative().optional(), policy_usd_per_cny: z.number().positive().optional()
}).strict();
const AuthoritySchema = PreflightSchema.omit({ provider_calls: true, key: true,
  maximum_attempts: true, cumulative_maximum_attempts: true }).extend({
  contract: z.literal(AUTHORITY_CONTRACT), action: z.literal("fill"),
  generated_at: z.string().min(1), identity_digest: Digest, keys: z.tuple([Digest]),
  limits: z.object({ starting_missing: z.literal(1), maximum_attempts: z.literal(2),
    maximum_attempts_per_key: z.literal(2), incremental_maximum_attempts: z.literal(1),
    successful_shard_ceiling: z.literal(1), next_attempt_ordinal: z.literal(2), max_concurrency: z.literal(1),
    max_output_tokens: z.number().int().positive(), output_token_field: z.enum(["maxOutputTokens", "max_tokens"])
  }).strict(),
  price: z.object({ input_usd_per_million: z.number().nonnegative(), output_usd_per_million: z.number().nonnegative(),
    estimated_upper_usd: z.number().nonnegative(), quote: QuoteSchema }).strict()
}).strict();

export type PageSupportComparisonTransportContinuationPreflight = z.infer<typeof PreflightSchema>;
export type PageSupportComparisonTransportContinuationAuthority = z.infer<typeof AuthoritySchema>;

/** Reads complete settled ancestry only. It never renews the predecessor's execution scope. */
export function readComparisonTransportPredecessor(input: {
  workset: PageSupportComparisonWorkset; cacheRoot: string; predecessorAuthority: PageSupportComparisonAuthority;
  writeLease?: ExtractionCacheWriteLease;
}) {
  const authority = verifyPageSupportComparisonAuthority(input.predecessorAuthority);
  assertPageSupportComparisonExecutionRoot(authority.execution_scope, input.cacheRoot, input.writeLease);
  if (authority.keys.length !== 1 || authority.limits.maximum_attempts !== 1) {
    throw new AlayaError("CONFLICT", "transport continuation requires an initial one-key comparison authority");
  }
  const lines = materializePageSupportComparisonLines(input.workset, authority.limits.max_output_tokens);
  if (lines.length !== 1 || lines[0]!.key !== authority.keys[0]) {
    throw new AlayaError("CONFLICT", "transport continuation changed the original comparison key");
  }
  const line = lines[0]!;
  const profile = input.workset.request_profile;
  if (!isExtractionRequestProfile(profile)) throw new AlayaError("VALIDATION", "comparison profile is unsupported");
  assertAuthorizedComparisonRequest({ workset: input.workset, authority,
    config: { model: input.workset.model, providerUrl: input.workset.provider_url,
      requestProfile: profile, apiKey: null }
  }, lines, authority.limits.max_output_tokens);
  const lookup = pageSupportComparisonLookup(input.workset, line, authority.limits.max_output_tokens);
  const state = readPageSupportComparisonAttemptState(input.cacheRoot, line.key, lookup);
  const shard = inspectPageSupportComparisonShardWitness(input.cacheRoot, line.key, lookup);
  const physical = readProviderRawAttemptWithFileWitness(input.cacheRoot, line.key, 1);
  const ledger = state.ledger;
  if (state.status !== "settled" || shard === undefined || physical === undefined || ledger === undefined ||
      !ledger.historyComplete || ledger.attempts !== 1 || ledger.maximumAttempts !== 1 ||
      ledger.startingMissing !== 1 || ledger.successfulShardCeiling !== 1 || ledger.successfulShards !== 0 ||
      ledger.pendingKeys.length !== 0 || ledger.unresolvedAttempts.length !== 0 ||
      ledger.settledAttempts.length !== 1 || ledger.transportFailures.length !== 1 ||
      listProviderRawAttempts(input.cacheRoot, line.key).length !== 1 ||
      comparisonOutcomeStatus(shard.shard) !== "transport_failure" || shard.shard.admitted ||
      physical.raw.failure_retryable !== true || physical.raw.transport_failure === undefined ||
      canonicalJson(shard.shard.outcome) !== canonicalJson({ status: "transport_failure", failure: physical.raw.transport_failure }) ||
      physical.raw.decoded_text !== "" || physical.raw.finish_reason !== null ||
      ["response_parse", "response_schema"].includes(physical.raw.transport_failure.phase) ||
      physical.raw.transport_failure.httpStatus !== null && physical.raw.transport_failure.httpStatus >= 200 &&
        physical.raw.transport_failure.httpStatus < 300) {
    throw new AlayaError("CONFLICT", "transport continuation requires a complete settled retryable transport failure");
  }
  if (authority.price.maximum_input_tokens_per_attempt !== line.inputByteUpper) {
    throw new AlayaError("CONFLICT", "transport continuation predecessor input bound differs from the same request");
  }
  if (!boundedArtifactEntryExists(continuationChildClaimPath(input.cacheRoot, authority.attempt_lineage_digest)) &&
      (listExtractionAttemptLedgerRecords(input.cacheRoot).some(record =>
        record.cache_identity.model === authority.model && record.cache_identity.requestProfile === authority.request_profile &&
        record.lineage_digest !== authority.attempt_lineage_digest) ||
       hasProviderRawContinuationAttempts(input.cacheRoot, line.key) ||
       hasPageSupportComparisonContinuationResults(input.cacheRoot, line.key))) {
    throw new AlayaError("CONFLICT", "comparison continuation evidence exists without its child claim");
  }
  return { authority, line, ledger, raw: physical.raw, shard: shard.shard,
    binding: { authority, ledger_sha256: ledger.ledgerSha256, ledger_raw_sha256: ledger.rawLedgerSha256,
      raw_file_sha256: physical.fileSha256, shard_file_sha256: shard.fileSha256 } };
}

export function preparePageSupportComparisonTransportContinuation(input: {
  workset: PageSupportComparisonWorkset; cacheRoot: string; predecessorAuthority: PageSupportComparisonAuthority;
}): PageSupportComparisonTransportContinuationPreflight {
  const retained = readComparisonTransportPredecessor(input);
  if (boundedArtifactEntryExists(continuationChildClaimPath(input.cacheRoot, retained.authority.attempt_lineage_digest))) {
    throw new AlayaError("CONFLICT", "comparison predecessor already has its one continuation child");
  }
  const scope = inspectPageSupportComparisonExecutionScope(input.cacheRoot);
  const body = { contract: PREFLIGHT_CONTRACT, kind: PAGE_SUPPORT_COMPARISON_KIND, workset: input.workset,
    model: input.workset.model, request_profile: input.workset.request_profile,
    key: retained.line.key, request_digest: retained.line.requestDigest, material_digest: retained.line.materialDigest,
    predecessor: retained.binding, execution_scope: scope, provider_calls: 0,
    maximum_attempts: 1, cumulative_maximum_attempts: 2, next_attempt_ordinal: 2,
    max_output_tokens: retained.authority.limits.max_output_tokens,
    maximum_input_tokens_per_attempt: retained.line.inputByteUpper,
    ...(retained.authority.price.quote_basis === undefined ? {} : { quote_basis: retained.authority.price.quote_basis })
  };
  return PreflightSchema.parse({ ...body, attempt_lineage_digest: continuationLineage(body) });
}

export function quotePageSupportComparisonTransportContinuation(
  value: PageSupportComparisonTransportContinuationPreflight, inputUsdPerMillion: number, outputUsdPerMillion: number
) {
  const preflight = PreflightSchema.parse(value);
  assertPreflightIdentity(preflight);
  const previous = preflight.predecessor.authority.price;
  assertStepQuoteRates(preflight.request_profile, inputUsdPerMillion, outputUsdPerMillion, preflight.quote_basis);
  if (inputUsdPerMillion !== previous.input_usd_per_million || outputUsdPerMillion !== previous.output_usd_per_million) {
    throw new AlayaError("CONFLICT", "transport continuation changed the original quote rates");
  }
  const incremental = quotePageSupportComparison(preflight, inputUsdPerMillion, outputUsdPerMillion);
  const basis = preflight.quote_basis;
  const cny = basis === undefined ? 0 : (
    preflight.maximum_input_tokens_per_attempt * basis.input_cny_per_million +
    preflight.max_output_tokens * basis.output_cny_per_million) / 1_000_000;
  return QuoteSchema.parse({ incremental_upper_usd: incremental,
    predecessor_risk_upper_usd: previous.estimated_upper_usd,
    cumulative_risk_upper_usd: previous.estimated_upper_usd + incremental,
    incremental_maximum_attempts: 1, cumulative_maximum_attempts: 2, next_attempt_ordinal: 2,
    ...(basis === undefined ? {} : { provider_currency: "CNY", incremental_upper_cny: cny,
      predecessor_risk_upper_cny: cny, cumulative_risk_upper_cny: cny + cny, policy_usd_per_cny: basis.policy_usd_per_cny })
  });
}

export function pinPageSupportComparisonTransportContinuationAuthority(input: {
  preflight: PageSupportComparisonTransportContinuationPreflight; inputUsdPerMillion: number; outputUsdPerMillion: number;
}): PageSupportComparisonTransportContinuationAuthority {
  const preflight = PreflightSchema.parse(input.preflight);
  const refreshed = preparePageSupportComparisonTransportContinuation({ workset: preflight.workset,
    cacheRoot: preflight.execution_scope.execution_root_path, predecessorAuthority: preflight.predecessor.authority });
  if (canonicalJson(preflight) !== canonicalJson(refreshed)) {
    throw new AlayaError("CONFLICT", "comparison transport continuation preflight ancestry or executable changed");
  }
  const quote = quotePageSupportComparisonTransportContinuation(preflight, input.inputUsdPerMillion, input.outputUsdPerMillion);
  const { provider_calls: _calls, key, maximum_attempts: _attempts, cumulative_maximum_attempts: _cumulative, ...retained } = preflight;
  const body = { ...retained, contract: AUTHORITY_CONTRACT, action: "fill", generated_at: new Date().toISOString(), keys: [key],
    limits: { starting_missing: 1, maximum_attempts: 2, maximum_attempts_per_key: 2, incremental_maximum_attempts: 1,
      successful_shard_ceiling: 1, next_attempt_ordinal: 2, max_concurrency: 1, max_output_tokens: preflight.max_output_tokens,
      output_token_field: preflight.predecessor.authority.limits.output_token_field },
    price: { input_usd_per_million: input.inputUsdPerMillion, output_usd_per_million: input.outputUsdPerMillion,
      estimated_upper_usd: quote.incremental_upper_usd, quote } };
  return verifyPageSupportComparisonTransportContinuationAuthority({ ...body, identity_digest: digest(body) });
}

export function verifyPageSupportComparisonTransportContinuationAuthority(value: unknown): PageSupportComparisonTransportContinuationAuthority {
  const authority = AuthoritySchema.parse(value);
  const { identity_digest, ...body } = authority;
  const preflight = continuationAuthorityPreflight(authority);
  const expected = quotePageSupportComparisonTransportContinuation(preflight,
    authority.price.input_usd_per_million, authority.price.output_usd_per_million);
  if (digest(body) !== identity_digest || canonicalJson(authority.price.quote) !== canonicalJson(expected) ||
      authority.price.estimated_upper_usd !== expected.incremental_upper_usd ||
      authority.limits.max_output_tokens !== preflight.max_output_tokens ||
      authority.limits.output_token_field !== preflight.predecessor.authority.limits.output_token_field) {
    throw new AlayaError("CONFLICT", "comparison transport continuation authority identity or price differs");
  }
  return authority;
}

export function assertComparisonTransportContinuationBinding(authority: PageSupportComparisonTransportContinuationAuthority,
  workset: PageSupportComparisonWorkset, cacheRoot: string, writeLease?: ExtractionCacheWriteLease) {
  assertPageSupportComparisonExecutionRoot(authority.execution_scope, cacheRoot, writeLease);
  const retained = readComparisonTransportPredecessor({ workset, cacheRoot, writeLease, predecessorAuthority: authority.predecessor.authority });
  if (canonicalJson(workset) !== canonicalJson(authority.workset) ||
      canonicalJson(retained.binding) !== canonicalJson(authority.predecessor)) {
    throw new AlayaError("CONFLICT", "comparison transport continuation predecessor evidence changed");
  }
  return retained;
}

function continuationAuthorityPreflight(authority: PageSupportComparisonTransportContinuationAuthority) {
  const { action: _action, generated_at: _date, identity_digest: _digest, keys, limits: _limits, price: _price, ...body } = authority;
  return PreflightSchema.parse({ ...body, contract: PREFLIGHT_CONTRACT, key: keys[0], provider_calls: 0,
    maximum_attempts: 1, cumulative_maximum_attempts: 2 });
}

function assertPreflightIdentity(preflight: PageSupportComparisonTransportContinuationPreflight): void {
  const previous = verifyPageSupportComparisonAuthority(preflight.predecessor.authority);
  const line = materializePageSupportComparisonLines(preflight.workset, preflight.max_output_tokens)[0];
  if (line === undefined || preflight.workset.items.length !== 1 || previous.keys.length !== 1 || previous.limits.maximum_attempts !== 1 ||
      preflight.key !== previous.keys[0] || preflight.key !== line.key || preflight.request_digest !== line.requestDigest ||
      preflight.material_digest !== line.materialDigest || preflight.model !== previous.model ||
      preflight.request_profile !== previous.request_profile || preflight.model !== preflight.workset.model ||
      preflight.request_profile !== preflight.workset.request_profile ||
      preflight.max_output_tokens !== previous.limits.max_output_tokens || preflight.maximum_input_tokens_per_attempt !== line.inputByteUpper ||
      previous.price.maximum_input_tokens_per_attempt !== line.inputByteUpper ||
      canonicalJson(preflight.quote_basis ?? null) !== canonicalJson(previous.price.quote_basis ?? null) ||
      canonicalJson(preflight.execution_scope.execution_root_binding) !== canonicalJson(previous.execution_scope.execution_root_binding) ||
      preflight.execution_scope.execution_root_path !== previous.execution_scope.execution_root_path ||
      preflight.attempt_lineage_digest !== continuationLineage(preflight)) {
    throw new AlayaError("CONFLICT", "comparison transport continuation changed the original request or ancestry");
  }
}

function continuationLineage(input: { predecessor: unknown; key: string; request_digest: string; material_digest: string; execution_scope: unknown }): string {
  return digest({ contract: "page-support-comparison-transport-continuation-lineage-v1", predecessor: input.predecessor,
    key: input.key, request_digest: input.request_digest, material_digest: input.material_digest, execution_scope: input.execution_scope });
}

export function digestComparisonContinuationMaterial(value: unknown): string { return digest(value); }
function digest(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
