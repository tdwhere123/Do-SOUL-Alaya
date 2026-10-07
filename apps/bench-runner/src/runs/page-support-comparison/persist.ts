import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import { publishBytesExclusiveDurable } from "../extraction/fill/manifest/durable-exclusive-publication.js";
import { isCompleteSemanticFinish } from "../compile-seed/http/semantic-provider-http.js";
import { ExtractionTransportProvenanceSchema, type ExtractionTransportProvenance } from "../extraction/transport-route.js";
import { readBoundedCanonicalUtf8Artifact, readBoundedStableRegularFile,
  decodeCanonicalUtf8Artifact } from "../extraction/cache-audit/bounded-artifact-reader.js";
import {
  inspectExtractionAttemptLedger, openExtractionAttemptLedger
} from "../extraction/authority/attempt-ledger.js";
import { settledAttemptUsageDigest } from "../extraction/authority/attempt-ledger/outcome.js";
import { isExtractionRequestProfile } from "../extraction/request-profile.js";
import { baseReportedUsage } from "../extraction/authority/step-quote.js";
import type { ExtractionCacheWriteLease } from "../extraction/fill/manifest/fill-root-guard.js";
import type { ProviderRequestPhysicalContext } from "../provider-request/execution.js";
import {
  bindProviderRawAttempt, listProviderRawAttempts,
  providerRawSuccessEvidenceState, readProviderRawAttempt, verifyProviderRawReservation,
  type ProviderRawAttempt
} from "../extraction/fill/provider-raw-attempt.js";
import {
  pageSupportComparisonCacheKey, PAGE_SUPPORT_COMPARISON_KIND,
  type PageSupportComparisonLine, type PageSupportComparisonWorkset
} from "./input.js";
import {
  assertPageSupportComparisonExecutionScope, pageSupportComparisonAttemptLineage,
  verifyPageSupportComparisonAuthority, type PageSupportComparisonAuthority
} from "./authority.js";

export const PAGE_SUPPORT_COMPARISON_CACHE_CONTRACT = "page-support-comparison-cache-v1" as const;
export const PAGE_SUPPORT_COMPARISON_SHARD_MAX_BYTES = 32 * 1024 * 1024;

export class PageSupportComparisonIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PageSupportComparisonIdentityError";
  }
}

const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative()
}).strict();

const ShardSchema = z.object({
  contract: z.literal(PAGE_SUPPORT_COMPARISON_CACHE_CONTRACT),
  kind: z.literal(PAGE_SUPPORT_COMPARISON_KIND),
  cache_key: z.string().regex(/^[0-9a-f]{64}$/u),
  model: z.string().min(1),
  request_profile: z.string().min(1),
  question: z.string().min(1),
  system_prompt: z.string().min(1),
  user_prompt: z.string().min(1),
  raw_json: z.string(),
  outcome: z.unknown(),
  admitted: z.boolean(),
  attempt_ordinal: z.number().int().positive(),
  attempt_lineage_digest: z.string().regex(/^[0-9a-f]{64}$/u),
  request_digest: z.string().regex(/^[0-9a-f]{64}$/u),
  material_digest: z.string().regex(/^[0-9a-f]{64}$/u),
  extracted_at: z.string().min(1),
  usage: UsageSchema.optional(),
  finish_reason: z.string().nullable().optional(),
  completion_witness: z.literal("finish_reason").nullable().optional(),
  raw_digest: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  max_output_tokens: z.number().int().positive().optional(),
  transport_provenance: ExtractionTransportProvenanceSchema
}).strict();

export type PageSupportComparisonShard = z.infer<typeof ShardSchema>;

export function buildPageSupportComparisonShard(input: {
  line: PageSupportComparisonLine; model: string; requestProfile: string;
  maxOutputTokens: number; attemptLineageDigest: string;
  published: Parameters<ProviderRequestPhysicalContext["publishArtifact"]>[0];
}): PageSupportComparisonShard {
  const { line, published } = input;
  return { contract: PAGE_SUPPORT_COMPARISON_CACHE_CONTRACT, kind: PAGE_SUPPORT_COMPARISON_KIND,
    cache_key: line.key, model: input.model, request_profile: input.requestProfile, question: line.question,
    system_prompt: line.systemPrompt, user_prompt: line.userPrompt, raw_json: published.rawJson,
    outcome: published.outcome, admitted: published.admitted, attempt_ordinal: published.attemptOrdinal,
    extracted_at: new Date().toISOString(), finish_reason: published.finishReason,
    completion_witness: published.finishReason === null ? null : "finish_reason",
    raw_digest: createHash("sha256").update(published.rawJson, "utf8").digest("hex"),
    max_output_tokens: input.maxOutputTokens, transport_provenance: line.transportProvenance,
    request_digest: line.requestDigest, material_digest: line.materialDigest,
    attempt_lineage_digest: input.attemptLineageDigest,
    ...(published.usage === undefined ? {} : { usage: published.usage }) };
}

export type PageSupportComparisonLookup = Readonly<{
  model: string;
  request_profile: string;
  system_prompt?: string;
  user_prompt?: string;
  schema?: object;
  max_output_tokens?: number;
  provider_url?: string;
  request_digest?: string;
  material_digest?: string;
  transport_provenance?: ExtractionTransportProvenance;
  attempt_lineage_digest?: string;
}>;

export function pageSupportComparisonShardPath(cacheRoot: string, key: string): string {
  return join(cacheRoot, key.slice(0, 2), `${key}.json`);
}

export function readPageSupportComparisonShard(
  cacheRoot: string, key: string
): PageSupportComparisonShard | undefined {
  const path = pageSupportComparisonShardPath(cacheRoot, key);
  if (!existsSync(path)) return undefined;
  return ShardSchema.parse(JSON.parse(readBoundedCanonicalUtf8Artifact({
    path, maxBytes: PAGE_SUPPORT_COMPARISON_SHARD_MAX_BYTES, label: "page-support comparison shard"
  })));
}

export function inspectPageSupportComparisonShard(
  cacheRoot: string, key: string, expected: PageSupportComparisonLookup
): PageSupportComparisonShard | undefined {
  return inspectPageSupportComparisonShardWitness(cacheRoot, key, expected)?.shard;
}

export function pageSupportComparisonContinuationResultPath(cacheRoot: string, key: string, lineage: string): string {
  return join(cacheRoot, "comparison-continuations", z.string().regex(/^[0-9a-f]{64}$/u).parse(lineage),
    `${z.string().regex(/^[0-9a-f]{64}$/u).parse(key)}.json`);
}

export function inspectPageSupportComparisonContinuationShard(
  cacheRoot: string, key: string, expected: PageSupportComparisonLookup & { attempt_lineage_digest: string }
): PageSupportComparisonShard | undefined {
  return inspectComparisonShardFile(pageSupportComparisonContinuationResultPath(
    cacheRoot, key, expected.attempt_lineage_digest), key, expected)?.shard;
}

export function inspectPageSupportComparisonShardWitness(
  cacheRoot: string, key: string, expected: PageSupportComparisonLookup
): Readonly<{ shard: PageSupportComparisonShard; fileSha256: string }> | undefined {
  return inspectComparisonShardFile(pageSupportComparisonShardPath(cacheRoot, key), key, expected);
}

function inspectComparisonShardFile(path: string, key: string, expected: PageSupportComparisonLookup)
  : Readonly<{ shard: PageSupportComparisonShard; fileSha256: string }> | undefined {
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  let fileSha256: string;
  try {
    const file = readBoundedStableRegularFile({
      path, maxBytes: PAGE_SUPPORT_COMPARISON_SHARD_MAX_BYTES, label: "page-support comparison shard"
    });
    fileSha256 = file.identity.sha256;
    parsed = JSON.parse(decodeCanonicalUtf8Artifact(file.bytes, "page-support comparison shard"));
  } catch {
    throw new PageSupportComparisonIdentityError(`page-support comparison cache is malformed: ${key}`);
  }
  const shard = ShardSchema.safeParse(parsed);
  if (!shard.success) {
    throw new PageSupportComparisonIdentityError(`page-support comparison cache is malformed: ${key}`);
  }
  if (shard.data.cache_key !== key || shard.data.kind !== PAGE_SUPPORT_COMPARISON_KIND ||
      shard.data.model !== expected.model || shard.data.request_profile !== expected.request_profile ||
      expected.attempt_lineage_digest !== undefined &&
        shard.data.attempt_lineage_digest !== expected.attempt_lineage_digest ||
      expected.material_digest !== undefined && shard.data.material_digest !== expected.material_digest) {
    throw new PageSupportComparisonIdentityError(`page-support comparison cache identity mismatch: ${key}`);
  }
  const digest = createHash("sha256").update(shard.data.raw_json, "utf8").digest("hex");
  if (shard.data.raw_digest !== undefined && shard.data.raw_digest !== digest) {
    throw new PageSupportComparisonIdentityError(`page-support comparison cache identity mismatch: ${key}`);
  }
  const bind = requestBind(expected);
  if (bind !== undefined) {
    if (shard.data.raw_digest !== digest ||
        shard.data.system_prompt !== bind.system_prompt || shard.data.user_prompt !== bind.user_prompt ||
        shard.data.max_output_tokens !== bind.max_output_tokens || shard.data.request_digest !== bind.request_digest ||
        canonicalJson(shard.data.transport_provenance) !== canonicalJson(bind.transport_provenance)) {
      throw new PageSupportComparisonIdentityError(`page-support comparison cache identity mismatch: ${key}`);
    }
    const derived = pageSupportComparisonCacheKey({
      model: shard.data.model,
      requestProfile: shard.data.request_profile,
      systemPrompt: shard.data.system_prompt,
      userPrompt: shard.data.user_prompt,
      schema: bind.schema,
      maxOutputTokens: bind.max_output_tokens,
      providerUrl: bind.provider_url
    });
    if (derived !== key || derived !== shard.data.cache_key) {
      throw new PageSupportComparisonIdentityError(`page-support comparison cache identity mismatch: ${key}`);
    }
  }
  return { shard: shard.data, fileSha256 };
}

export function writePageSupportComparisonShard(
  cacheRoot: string, shard: PageSupportComparisonShard
): void {
  const parsed = ShardSchema.parse(shard);
  const path = pageSupportComparisonShardPath(cacheRoot, parsed.cache_key);
  writeComparisonShardFile(path, parsed);
}

export function writePageSupportComparisonContinuationShard(cacheRoot: string, shard: PageSupportComparisonShard): void {
  const parsed = ShardSchema.parse(shard);
  writeComparisonShardFile(pageSupportComparisonContinuationResultPath(
    cacheRoot, parsed.cache_key, parsed.attempt_lineage_digest), parsed);
}

function writeComparisonShardFile(path: string, parsed: PageSupportComparisonShard): void {
  mkdirSync(dirname(path), { recursive: true });
  const readExisting = () => existsSync(path) ? ShardSchema.parse(JSON.parse(readBoundedCanonicalUtf8Artifact({
    path, maxBytes: PAGE_SUPPORT_COMPARISON_SHARD_MAX_BYTES, label: "page-support comparison shard"
  }))) : undefined;
  const existing = readExisting();
  if (existing !== undefined) {
    if (canonicalJson({ ...existing, extracted_at: "" }) !== canonicalJson({ ...parsed, extracted_at: "" })) {
      throw new PageSupportComparisonIdentityError(`immutable page-support comparison conflict: ${parsed.cache_key}`);
    }
    return;
  }
  try {
    const bytes = Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    if (bytes.length > PAGE_SUPPORT_COMPARISON_SHARD_MAX_BYTES) {
      throw new PageSupportComparisonIdentityError(
        `page-support comparison shard exceeds supported byte bound: ${parsed.cache_key}`
      );
    }
    publishBytesExclusiveDurable({
      destination: path,
      bytes,
      ownerIdentity: `${parsed.cache_key}:${parsed.attempt_ordinal}`,
      temporaryDirectory: dirname(path)
    });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    const winner = readExisting();
    if (winner === undefined || canonicalJson({ ...winner, extracted_at: "" }) !==
        canonicalJson({ ...parsed, extracted_at: "" })) {
      throw new PageSupportComparisonIdentityError(`immutable page-support comparison conflict: ${parsed.cache_key}`);
    }
  }
}

export function comparisonOutcomeStatus(shard: PageSupportComparisonShard): string {
  if (typeof shard.outcome !== "object" || shard.outcome === null || Array.isArray(shard.outcome)) {
    return "invalid";
  }
  const status = (shard.outcome as { readonly status?: unknown }).status;
  return typeof status === "string" ? status : "invalid";
}

export function hasVerifiedComparisonCompletion(shard: PageSupportComparisonShard): boolean {
  return isCompleteSemanticFinish(shard.request_profile, shard.finish_reason) &&
    shard.completion_witness === "finish_reason";
}

export function hasAdmittedComparisonOutcome(shard: PageSupportComparisonShard): boolean {
  return shard.admitted === true && comparisonOutcomeStatus(shard) === "assessed" &&
    hasVerifiedComparisonCompletion(shard);
}

export function pageSupportComparisonLookup(
  workset: PageSupportComparisonWorkset, line: PageSupportComparisonLine, maxOutputTokens: number
): PageSupportComparisonLookup {
  return {
    model: workset.model,
    request_profile: workset.request_profile,
    system_prompt: line.systemPrompt,
    user_prompt: line.userPrompt,
    schema: line.responseJsonSchema,
    max_output_tokens: maxOutputTokens,
    provider_url: workset.provider_url,
    request_digest: line.requestDigest,
    material_digest: line.materialDigest,
    transport_provenance: line.transportProvenance,
    attempt_lineage_digest: pageSupportComparisonAttemptLineage({
      model: workset.model,
      request_profile: workset.request_profile,
      transport_provenance: line.transportProvenance
    })
  };
}

export function readPageSupportComparisonAttemptState(
  cacheRoot: string, cacheKey: string, expected: PageSupportComparisonLookup
) {
  if (expected.attempt_lineage_digest === undefined) {
    throw new PageSupportComparisonIdentityError("page-support comparison lookup lacks attempt lineage");
  }
  if (!isExtractionRequestProfile(expected.request_profile)) {
    throw new PageSupportComparisonIdentityError("page-support comparison lookup has unsupported profile");
  }
  const ledger = inspectExtractionAttemptLedger({
    cacheRoot,
    lineageDigest: expected.attempt_lineage_digest,
    cacheIdentity: { model: expected.model, requestProfile: expected.request_profile }
  });
  const shard = inspectPageSupportComparisonShard(cacheRoot, cacheKey, expected);
  const raws = listProviderRawAttempts(cacheRoot, cacheKey);
  for (const raw of raws) assertComparisonRawReservation(raw, ledger, expected, cacheKey);
  if (shard !== undefined) {
    const raw = raws.find((item) => item.attempt_ordinal === shard.attempt_ordinal);
    if (raw === undefined) {
      throw new PageSupportComparisonIdentityError("page-support comparison shard lacks its reserved raw attempt");
    }
    assertComparisonShardRaw(shard, raw);
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
  if (shard !== undefined && hasAdmittedComparisonOutcome(shard) && status === "settled") {
    const success = ledger?.successfulEntries.find((entry) => entry.cacheKey === cacheKey);
    if (success?.successKind !== "provider" || success.rawJsonSha256 !== shard.raw_digest ||
        success.attemptOrdinal !== shard.attempt_ordinal ||
        success.authorityLineageDigest !== shard.attempt_lineage_digest ||
        canonicalJson(success.transportProvenance) !== canonicalJson(shard.transport_provenance)) {
      throw new PageSupportComparisonIdentityError("page-support comparison shard lacks durable successful admission");
    }
  }
  return { shard, ledger, status };
}

export function assertComparisonRawReservation(
  raw: ProviderRawAttempt,
  ledger: ReturnType<typeof inspectExtractionAttemptLedger>,
  expected: PageSupportComparisonLookup,
  cacheKey: string
): void {
  if (expected.attempt_lineage_digest === undefined) {
    throw new PageSupportComparisonIdentityError("page-support comparison lookup lacks attempt lineage");
  }
  bindProviderRawAttempt(raw, {
    cacheKey,
    kind: PAGE_SUPPORT_COMPARISON_KIND,
    model: expected.model,
    requestProfile: expected.request_profile,
    requestDigest: expected.request_digest ?? raw.request_digest,
    attemptLineageDigest: expected.attempt_lineage_digest
  });
  verifyProviderRawReservation(raw, ledger);
}

export function openPageSupportComparisonAttemptLedger(input: Readonly<{
  cacheRoot: string;
  authority: PageSupportComparisonAuthority;
  writeLease?: ExtractionCacheWriteLease;
}>) {
  const authority = verifyPageSupportComparisonAuthority(input.authority);
  assertPageSupportComparisonExecutionScope(authority.execution_scope, input.cacheRoot, input.writeLease);
  if (!isExtractionRequestProfile(authority.request_profile)) {
    throw new AlayaError("VALIDATION", "page-support comparison attempt ledger requires an extraction request profile");
  }
  if (authority.limits.maximum_attempts < 1) {
    throw new AlayaError("CONFLICT", "page-support comparison authority has no remaining provider attempt capacity");
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
      const shard = inspectPageSupportComparisonShard(cacheRoot, cacheKey, {
        model: identity.model,
        request_profile: identity.requestProfile,
        attempt_lineage_digest: lineage
      });
      if (shard === undefined || !hasAdmittedComparisonOutcome(shard) ||
          shard.transport_provenance === undefined || shard.raw_digest === undefined) {
        return undefined;
      }
      if (canonicalJson(shard.transport_provenance) !== canonicalJson(authority.transport_provenance)) {
        throw new AlayaError("CONFLICT", "page-support comparison success differs from authorized physical transport");
      }
      const raw = readProviderRawAttempt(cacheRoot, cacheKey, shard.attempt_ordinal);
      if (raw === undefined) {
        throw new AlayaError("CONFLICT", "page-support comparison success lacks its reserved raw attempt");
      }
      assertComparisonRawReservation(raw, inspectExtractionAttemptLedger({
        cacheRoot, lineageDigest: lineage, cacheIdentity: identity
      }), {
        model: identity.model,
        request_profile: identity.requestProfile,
        request_digest: shard.request_digest,
        attempt_lineage_digest: lineage
      }, cacheKey);
      assertComparisonShardRaw(shard, raw);
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

export function assertComparisonShardRaw(
  shard: PageSupportComparisonShard, raw: ProviderRawAttempt
): void {
  if (raw.kind !== PAGE_SUPPORT_COMPARISON_KIND || raw.attempt_ordinal !== shard.attempt_ordinal ||
      raw.attempt_lineage_digest !== shard.attempt_lineage_digest ||
      raw.request_digest !== shard.request_digest ||
      raw.decoded_text !== shard.raw_json || raw.finish_reason !== shard.finish_reason ||
      raw.completion_witness !== shard.completion_witness ||
      canonicalJson(baseReportedUsage(raw.usage) ?? null) !== canonicalJson(shard.usage ?? null) ||
      hasAdmittedComparisonOutcome(shard) && (!raw.full_replay_possible || raw.decoded_text_digest !== shard.raw_digest ||
        raw.transport_failure !== undefined || providerRawSuccessEvidenceState(raw) !== "bound")) {
    throw new PageSupportComparisonIdentityError(
      "page-support comparison success differs from its reserved raw attempt"
    );
  }
}

function requestBind(expected: PageSupportComparisonLookup): Readonly<{
  system_prompt: string;
  user_prompt: string;
  schema: object;
  max_output_tokens: number;
  provider_url: string;
  request_digest: string;
  transport_provenance: ExtractionTransportProvenance;
}> | undefined {
  const {
    system_prompt, user_prompt, schema, max_output_tokens, provider_url, request_digest, transport_provenance
  } = expected;
  const bound = system_prompt !== undefined && user_prompt !== undefined &&
    schema !== undefined && max_output_tokens !== undefined && provider_url !== undefined &&
    request_digest !== undefined && transport_provenance !== undefined;
  const absent = system_prompt === undefined && user_prompt === undefined &&
    schema === undefined && max_output_tokens === undefined && provider_url === undefined &&
    request_digest === undefined && transport_provenance === undefined;
  if (!bound && !absent) {
    throw new PageSupportComparisonIdentityError("page-support comparison cache lookup is incomplete");
  }
  if (system_prompt === undefined || user_prompt === undefined ||
      schema === undefined || max_output_tokens === undefined || provider_url === undefined ||
      request_digest === undefined || transport_provenance === undefined) {
    return undefined;
  }
  return { system_prompt, user_prompt, schema, max_output_tokens, provider_url, request_digest, transport_provenance };
}
