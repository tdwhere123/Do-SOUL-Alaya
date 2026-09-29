import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { canonicalJson } from "@do-soul/alaya-protocol";
import { publishBytesExclusiveDurable } from "../extraction/fill/manifest/durable-exclusive-publication.js";
import { isCompleteSemanticFinish } from "../compile-seed/http/semantic-provider-http.js";
import { ExtractionTransportProvenanceSchema, type ExtractionTransportProvenance } from "../extraction/transport-route.js";
import { readBoundedCanonicalUtf8Artifact } from "../extraction/cache-audit/bounded-artifact-reader.js";
import { evidenceSelectionCacheKey, EVIDENCE_SELECTION_KIND } from "./input.js";

export const EVIDENCE_SELECTION_CACHE_CONTRACT = "source-evidence-selection-cache-v1" as const;
export const EVIDENCE_SELECTION_SHARD_MAX_BYTES = 32 * 1024 * 1024;

export class EvidenceSelectionIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceSelectionIdentityError";
  }
}

const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative()
}).strict();

const ShardSchema = z.object({
  contract: z.literal(EVIDENCE_SELECTION_CACHE_CONTRACT),
  kind: z.literal(EVIDENCE_SELECTION_KIND),
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
  sources_digest: z.string().regex(/^[0-9a-f]{64}$/u),
  extracted_at: z.string().min(1),
  usage: UsageSchema.optional(),
  finish_reason: z.string().nullable().optional(),
  completion_witness: z.literal("finish_reason").nullable().optional(),
  raw_digest: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  max_output_tokens: z.number().int().positive().optional(),
  transport_provenance: ExtractionTransportProvenanceSchema
}).strict();

export type EvidenceSelectionShard = z.infer<typeof ShardSchema>;

export type EvidenceSelectionLookup = Readonly<{
  model: string;
  request_profile: string;
  system_prompt?: string;
  user_prompt?: string;
  schema?: object;
  max_output_tokens?: number;
  provider_url?: string;
  request_digest?: string;
  sources_digest?: string;
  transport_provenance?: ExtractionTransportProvenance;
  attempt_lineage_digest?: string;
}>;

export function evidenceSelectionShardPath(cacheRoot: string, key: string): string {
  return join(cacheRoot, key.slice(0, 2), `${key}.json`);
}

export function readEvidenceSelectionShard(cacheRoot: string, key: string): EvidenceSelectionShard | undefined {
  const path = evidenceSelectionShardPath(cacheRoot, key);
  if (!existsSync(path)) return undefined;
  return ShardSchema.parse(JSON.parse(readBoundedCanonicalUtf8Artifact({
    path, maxBytes: EVIDENCE_SELECTION_SHARD_MAX_BYTES, label: "evidence selection shard"
  })));
}

export function inspectEvidenceSelectionShard(
  cacheRoot: string, key: string, expected: EvidenceSelectionLookup
): EvidenceSelectionShard | undefined {
  const path = evidenceSelectionShardPath(cacheRoot, key);
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readBoundedCanonicalUtf8Artifact({
      path, maxBytes: EVIDENCE_SELECTION_SHARD_MAX_BYTES, label: "evidence selection shard"
    }));
  } catch {
    throw new EvidenceSelectionIdentityError(`evidence selection cache is malformed: ${key}`);
  }
  const shard = ShardSchema.safeParse(parsed);
  if (!shard.success) {
    throw new EvidenceSelectionIdentityError(`evidence selection cache is malformed: ${key}`);
  }
  if (shard.data.cache_key !== key || shard.data.kind !== EVIDENCE_SELECTION_KIND ||
      shard.data.model !== expected.model || shard.data.request_profile !== expected.request_profile ||
      expected.attempt_lineage_digest !== undefined &&
        shard.data.attempt_lineage_digest !== expected.attempt_lineage_digest ||
      expected.sources_digest !== undefined && shard.data.sources_digest !== expected.sources_digest) {
    throw new EvidenceSelectionIdentityError(`evidence selection cache identity mismatch: ${key}`);
  }
  const digest = createHash("sha256").update(shard.data.raw_json, "utf8").digest("hex");
  if (shard.data.raw_digest !== undefined && shard.data.raw_digest !== digest) {
    throw new EvidenceSelectionIdentityError(`evidence selection cache identity mismatch: ${key}`);
  }
  const bind = requestBind(expected);
  if (bind !== undefined) {
    if (shard.data.raw_digest !== digest ||
        shard.data.system_prompt !== bind.system_prompt || shard.data.user_prompt !== bind.user_prompt ||
        shard.data.max_output_tokens !== bind.max_output_tokens || shard.data.request_digest !== bind.request_digest ||
        canonicalJson(shard.data.transport_provenance) !== canonicalJson(bind.transport_provenance)) {
      throw new EvidenceSelectionIdentityError(`evidence selection cache identity mismatch: ${key}`);
    }
    const derived = evidenceSelectionCacheKey({
      model: shard.data.model,
      requestProfile: shard.data.request_profile,
      systemPrompt: shard.data.system_prompt,
      userPrompt: shard.data.user_prompt,
      schema: bind.schema,
      maxOutputTokens: bind.max_output_tokens,
      providerUrl: bind.provider_url
    });
    if (derived !== key || derived !== shard.data.cache_key) {
      throw new EvidenceSelectionIdentityError(`evidence selection cache identity mismatch: ${key}`);
    }
  }
  return shard.data;
}

export function writeEvidenceSelectionShard(cacheRoot: string, shard: EvidenceSelectionShard): void {
  const parsed = ShardSchema.parse(shard);
  const path = evidenceSelectionShardPath(cacheRoot, parsed.cache_key);
  mkdirSync(dirname(path), { recursive: true });
  const existing = readEvidenceSelectionShard(cacheRoot, parsed.cache_key);
  if (existing !== undefined) {
    if (canonicalJson({ ...existing, extracted_at: "" }) !== canonicalJson({ ...parsed, extracted_at: "" })) {
      throw new EvidenceSelectionIdentityError(`immutable evidence selection conflict: ${parsed.cache_key}`);
    }
    return;
  }
  try {
    const bytes = Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    if (bytes.length > EVIDENCE_SELECTION_SHARD_MAX_BYTES) {
      throw new EvidenceSelectionIdentityError(
        `evidence selection shard exceeds supported byte bound: ${parsed.cache_key}`
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
    const winner = readEvidenceSelectionShard(cacheRoot, parsed.cache_key);
    if (winner === undefined || canonicalJson({ ...winner, extracted_at: "" }) !==
        canonicalJson({ ...parsed, extracted_at: "" })) {
      throw new EvidenceSelectionIdentityError(`immutable evidence selection conflict: ${parsed.cache_key}`);
    }
  }
}

export function selectionOutcomeStatus(shard: EvidenceSelectionShard): string {
  if (typeof shard.outcome !== "object" || shard.outcome === null || Array.isArray(shard.outcome)) {
    return "invalid";
  }
  const status = (shard.outcome as { readonly status?: unknown }).status;
  return typeof status === "string" ? status : "invalid";
}

export function hasVerifiedSelectionCompletion(shard: EvidenceSelectionShard): boolean {
  return isCompleteSemanticFinish(shard.request_profile, shard.finish_reason) &&
    shard.completion_witness === "finish_reason";
}

export function hasAdmittedSelectionOutcome(shard: EvidenceSelectionShard): boolean {
  return shard.admitted === true && selectionOutcomeStatus(shard) === "interpreted" &&
    hasVerifiedSelectionCompletion(shard);
}

function requestBind(expected: EvidenceSelectionLookup): Readonly<{
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
    throw new EvidenceSelectionIdentityError("evidence selection cache lookup is incomplete");
  }
  if (system_prompt === undefined || user_prompt === undefined ||
      schema === undefined || max_output_tokens === undefined || provider_url === undefined ||
      request_digest === undefined || transport_provenance === undefined) {
    return undefined;
  }
  return { system_prompt, user_prompt, schema, max_output_tokens, provider_url, request_digest, transport_provenance };
}
