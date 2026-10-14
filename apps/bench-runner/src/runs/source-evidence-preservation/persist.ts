import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import { publishBytesExclusiveDurable } from "../extraction/fill/manifest/durable-exclusive-publication.js";
import { isCompleteSemanticFinish } from "../compile-seed/http/semantic-provider-http.js";
import { ExtractionTransportProvenanceSchema, type ExtractionTransportProvenance } from "../extraction/transport-route.js";
import { readBoundedCanonicalUtf8Artifact } from "../extraction/cache-audit/bounded-artifact-reader.js";
import {
  classifyRetainedExtractionAttemptState, inspectExtractionAttemptLedger, openExtractionAttemptLedger
} from "../extraction/authority/attempt-ledger.js";
import { settledAttemptUsageDigest } from "../extraction/authority/attempt-ledger/outcome.js";
import { isExtractionRequestProfile } from "../extraction/request-profile.js";
import { baseReportedUsage } from "../extraction/authority/step-quote.js";
import type { ExtractionCacheWriteLease } from "../extraction/fill/manifest/fill-root-guard.js";
import {
  bindProviderRawAttempt, listProviderRawAttempts,
  providerRawSuccessEvidenceState, readProviderRawAttempt, verifyProviderRawReservation, providerRawArtifactUsageMatches,
  type ProviderRawAttempt
} from "../extraction/fill/provider-raw-attempt.js";
import {
  sourceEvidencePreservationCacheKey, SOURCE_EVIDENCE_PRESERVATION_KIND,
  type SourceEvidencePreservationLine, type SourceEvidencePreservationWorkset
} from "./input.js";
import {
  assertSourceEvidencePreservationExecutionScope, sourceEvidencePreservationAttemptLineage,
  verifySourceEvidencePreservationAuthority, type SourceEvidencePreservationAuthority
} from "./authority.js";

export const SOURCE_EVIDENCE_PRESERVATION_CACHE_CONTRACT = "source-evidence-preservation-cache-v1" as const;
export const SOURCE_EVIDENCE_PRESERVATION_SHARD_MAX_BYTES = 32 * 1024 * 1024;

export class SourceEvidencePreservationIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceEvidencePreservationIdentityError";
  }
}

const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative()
}).strict();

const ShardSchema = z.object({
  contract: z.literal(SOURCE_EVIDENCE_PRESERVATION_CACHE_CONTRACT),
  kind: z.literal(SOURCE_EVIDENCE_PRESERVATION_KIND),
  cache_key: z.string().regex(/^[0-9a-f]{64}$/u),
  model: z.string().min(1),
  request_profile: z.string().min(1),
  original_question: z.string().min(1),
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

export type SourceEvidencePreservationShard = z.infer<typeof ShardSchema>;

export type SourceEvidencePreservationLookup = Readonly<{
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

export function sourceEvidencePreservationShardPath(cacheRoot: string, key: string): string {
  return join(cacheRoot, key.slice(0, 2), `${key}.json`);
}

export function readSourceEvidencePreservationShard(
  cacheRoot: string, key: string
): SourceEvidencePreservationShard | undefined {
  const path = sourceEvidencePreservationShardPath(cacheRoot, key);
  if (!existsSync(path)) return undefined;
  return ShardSchema.parse(JSON.parse(readBoundedCanonicalUtf8Artifact({
    path, maxBytes: SOURCE_EVIDENCE_PRESERVATION_SHARD_MAX_BYTES, label: "evidence preservation shard"
  })));
}

export function inspectSourceEvidencePreservationShard(
  cacheRoot: string, key: string, expected: SourceEvidencePreservationLookup
): SourceEvidencePreservationShard | undefined {
  const path = sourceEvidencePreservationShardPath(cacheRoot, key);
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readBoundedCanonicalUtf8Artifact({
      path, maxBytes: SOURCE_EVIDENCE_PRESERVATION_SHARD_MAX_BYTES, label: "evidence preservation shard"
    }));
  } catch {
    throw new SourceEvidencePreservationIdentityError(`evidence preservation cache is malformed: ${key}`);
  }
  const shard = ShardSchema.safeParse(parsed);
  if (!shard.success) {
    throw new SourceEvidencePreservationIdentityError(`evidence preservation cache is malformed: ${key}`);
  }
  if (shard.data.cache_key !== key || shard.data.kind !== SOURCE_EVIDENCE_PRESERVATION_KIND ||
      shard.data.model !== expected.model || shard.data.request_profile !== expected.request_profile ||
      expected.attempt_lineage_digest !== undefined &&
        shard.data.attempt_lineage_digest !== expected.attempt_lineage_digest ||
      expected.material_digest !== undefined && shard.data.material_digest !== expected.material_digest) {
    throw new SourceEvidencePreservationIdentityError(`evidence preservation cache identity mismatch: ${key}`);
  }
  const digest = createHash("sha256").update(shard.data.raw_json, "utf8").digest("hex");
  if (shard.data.raw_digest !== undefined && shard.data.raw_digest !== digest) {
    throw new SourceEvidencePreservationIdentityError(`evidence preservation cache identity mismatch: ${key}`);
  }
  const bind = requestBind(expected);
  if (bind !== undefined) {
    if (shard.data.raw_digest !== digest ||
        shard.data.system_prompt !== bind.system_prompt || shard.data.user_prompt !== bind.user_prompt ||
        shard.data.max_output_tokens !== bind.max_output_tokens || shard.data.request_digest !== bind.request_digest ||
        canonicalJson(shard.data.transport_provenance) !== canonicalJson(bind.transport_provenance)) {
      throw new SourceEvidencePreservationIdentityError(`evidence preservation cache identity mismatch: ${key}`);
    }
    const derived = sourceEvidencePreservationCacheKey({
      model: shard.data.model,
      requestProfile: shard.data.request_profile,
      systemPrompt: shard.data.system_prompt,
      userPrompt: shard.data.user_prompt,
      schema: bind.schema,
      maxOutputTokens: bind.max_output_tokens,
      providerUrl: bind.provider_url
    });
    if (derived !== key || derived !== shard.data.cache_key) {
      throw new SourceEvidencePreservationIdentityError(`evidence preservation cache identity mismatch: ${key}`);
    }
  }
  return shard.data;
}

export function writeSourceEvidencePreservationShard(
  cacheRoot: string, shard: SourceEvidencePreservationShard
): void {
  const parsed = ShardSchema.parse(shard);
  const path = sourceEvidencePreservationShardPath(cacheRoot, parsed.cache_key);
  mkdirSync(dirname(path), { recursive: true });
  const existing = readSourceEvidencePreservationShard(cacheRoot, parsed.cache_key);
  if (existing !== undefined) {
    if (canonicalJson({ ...existing, extracted_at: "" }) !== canonicalJson({ ...parsed, extracted_at: "" })) {
      throw new SourceEvidencePreservationIdentityError(`immutable evidence preservation conflict: ${parsed.cache_key}`);
    }
    return;
  }
  try {
    const bytes = Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    if (bytes.length > SOURCE_EVIDENCE_PRESERVATION_SHARD_MAX_BYTES) {
      throw new SourceEvidencePreservationIdentityError(
        `evidence preservation shard exceeds supported byte bound: ${parsed.cache_key}`
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
    const winner = readSourceEvidencePreservationShard(cacheRoot, parsed.cache_key);
    if (winner === undefined || canonicalJson({ ...winner, extracted_at: "" }) !==
        canonicalJson({ ...parsed, extracted_at: "" })) {
      throw new SourceEvidencePreservationIdentityError(`immutable evidence preservation conflict: ${parsed.cache_key}`);
    }
  }
}

export function preservationOutcomeStatus(shard: SourceEvidencePreservationShard): string {
  if (typeof shard.outcome !== "object" || shard.outcome === null || Array.isArray(shard.outcome)) {
    return "invalid";
  }
  const status = (shard.outcome as { readonly status?: unknown }).status;
  return typeof status === "string" ? status : "invalid";
}

export function hasVerifiedPreservationCompletion(shard: SourceEvidencePreservationShard): boolean {
  return isCompleteSemanticFinish(shard.request_profile, shard.finish_reason) &&
    shard.completion_witness === "finish_reason";
}

export function hasAdmittedPreservationOutcome(shard: SourceEvidencePreservationShard): boolean {
  const status = preservationOutcomeStatus(shard);
  return shard.admitted === true &&
    (status === "preserved" || status === "lost" || status === "unresolved") &&
    hasVerifiedPreservationCompletion(shard);
}

export function sourceEvidencePreservationLookup(
  workset: SourceEvidencePreservationWorkset, line: SourceEvidencePreservationLine, maxOutputTokens: number
): SourceEvidencePreservationLookup {
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
    attempt_lineage_digest: sourceEvidencePreservationAttemptLineage({
      model: workset.model,
      request_profile: workset.request_profile,
      transport_provenance: line.transportProvenance
    })
  };
}

export function readSourceEvidencePreservationAttemptState(
  cacheRoot: string, cacheKey: string, expected: SourceEvidencePreservationLookup
) {
  if (expected.attempt_lineage_digest === undefined) {
    throw new SourceEvidencePreservationIdentityError("evidence preservation lookup lacks attempt lineage");
  }
  if (!isExtractionRequestProfile(expected.request_profile)) {
    throw new SourceEvidencePreservationIdentityError("evidence preservation lookup has unsupported profile");
  }
  const ledger = inspectExtractionAttemptLedger({
    cacheRoot,
    lineageDigest: expected.attempt_lineage_digest,
    cacheIdentity: { model: expected.model, requestProfile: expected.request_profile }
  });
  const shard = inspectSourceEvidencePreservationShard(cacheRoot, cacheKey, expected);
  const raws = listProviderRawAttempts(cacheRoot, cacheKey);
  for (const raw of raws) assertPreservationRawReservation(raw, ledger, expected, cacheKey);
  if (shard !== undefined) {
    const raw = raws.find((item) => item.attempt_ordinal === shard.attempt_ordinal);
    if (raw === undefined) {
      throw new SourceEvidencePreservationIdentityError("evidence preservation shard lacks its reserved raw attempt");
    }
    assertPreservationShardRaw(shard, raw);
  }
  const status = classifyRetainedExtractionAttemptState(
    ledger, cacheKey, raws.map(raw => raw.attempt_ordinal), shard !== undefined);
  if (shard !== undefined && hasAdmittedPreservationOutcome(shard) && status === "settled") {
    const success = ledger?.successfulEntries.find((entry) => entry.cacheKey === cacheKey);
    if (success?.successKind !== "provider" || success.rawJsonSha256 !== shard.raw_digest ||
        success.attemptOrdinal !== shard.attempt_ordinal ||
        success.authorityLineageDigest !== shard.attempt_lineage_digest ||
        canonicalJson(success.transportProvenance) !== canonicalJson(shard.transport_provenance)) {
      throw new SourceEvidencePreservationIdentityError("evidence preservation shard lacks durable successful admission");
    }
  }
  return { shard, ledger, status };
}

export function assertPreservationRawReservation(
  raw: ProviderRawAttempt,
  ledger: ReturnType<typeof inspectExtractionAttemptLedger>,
  expected: SourceEvidencePreservationLookup,
  cacheKey: string
): void {
  if (expected.attempt_lineage_digest === undefined) {
    throw new SourceEvidencePreservationIdentityError("evidence preservation lookup lacks attempt lineage");
  }
  bindProviderRawAttempt(raw, {
    cacheKey,
    kind: SOURCE_EVIDENCE_PRESERVATION_KIND,
    model: expected.model,
    requestProfile: expected.request_profile,
    requestDigest: expected.request_digest ?? raw.request_digest,
    attemptLineageDigest: expected.attempt_lineage_digest
  });
  verifyProviderRawReservation(raw, ledger, "executable", expected.max_output_tokens);
}

export function openSourceEvidencePreservationAttemptLedger(input: Readonly<{
  cacheRoot: string;
  authority: SourceEvidencePreservationAuthority;
  writeLease?: ExtractionCacheWriteLease;
}>) {
  const authority = verifySourceEvidencePreservationAuthority(input.authority);
  assertSourceEvidencePreservationExecutionScope(authority.execution_scope, input.cacheRoot, input.writeLease);
  if (!isExtractionRequestProfile(authority.request_profile)) {
    throw new AlayaError("VALIDATION", "evidence preservation attempt ledger requires an extraction request profile");
  }
  if (authority.limits.maximum_attempts < 1) {
    throw new AlayaError("CONFLICT", "evidence preservation authority has no remaining provider attempt capacity");
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
      const shard = inspectSourceEvidencePreservationShard(cacheRoot, cacheKey, {
        model: identity.model,
        request_profile: identity.requestProfile,
        attempt_lineage_digest: lineage
      });
      if (shard === undefined || !hasAdmittedPreservationOutcome(shard) ||
          shard.transport_provenance === undefined || shard.raw_digest === undefined) {
        return undefined;
      }
      if (canonicalJson(shard.transport_provenance) !== canonicalJson(authority.transport_provenance)) {
        throw new AlayaError("CONFLICT", "evidence preservation success differs from authorized physical transport");
      }
      const raw = readProviderRawAttempt(cacheRoot, cacheKey, shard.attempt_ordinal);
      if (raw === undefined) {
        throw new AlayaError("CONFLICT", "evidence preservation success lacks its reserved raw attempt");
      }
      assertPreservationRawReservation(raw, inspectExtractionAttemptLedger({
        cacheRoot, lineageDigest: lineage, cacheIdentity: identity
      }), {
        model: identity.model,
        request_profile: identity.requestProfile,
        request_digest: shard.request_digest,
        attempt_lineage_digest: lineage, max_output_tokens: authority.limits.max_output_tokens
      }, cacheKey);
      assertPreservationShardRaw(shard, raw);
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

function assertPreservationShardRaw(
  shard: SourceEvidencePreservationShard, raw: ProviderRawAttempt
): void {
  if (raw.kind !== SOURCE_EVIDENCE_PRESERVATION_KIND || raw.attempt_ordinal !== shard.attempt_ordinal ||
      raw.attempt_lineage_digest !== shard.attempt_lineage_digest ||
      raw.request_digest !== shard.request_digest ||
      raw.decoded_text !== shard.raw_json || raw.finish_reason !== shard.finish_reason ||
      raw.completion_witness !== shard.completion_witness ||
      !providerRawArtifactUsageMatches(raw, shard) ||
      hasAdmittedPreservationOutcome(shard) && (!raw.full_replay_possible || raw.decoded_text_digest !== shard.raw_digest ||
        raw.transport_failure !== undefined || providerRawSuccessEvidenceState(raw) !== "bound")) {
    throw new SourceEvidencePreservationIdentityError(
      "evidence preservation success differs from its reserved raw attempt"
    );
  }
}

function requestBind(expected: SourceEvidencePreservationLookup): Readonly<{
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
    throw new SourceEvidencePreservationIdentityError("evidence preservation cache lookup is incomplete");
  }
  if (system_prompt === undefined || user_prompt === undefined ||
      schema === undefined || max_output_tokens === undefined || provider_url === undefined ||
      request_digest === undefined || transport_provenance === undefined) {
    return undefined;
  }
  return { system_prompt, user_prompt, schema, max_output_tokens, provider_url, request_digest, transport_provenance };
}
