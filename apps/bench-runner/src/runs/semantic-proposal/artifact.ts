import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { canonicalJson } from "@do-soul/alaya-protocol";
import { publishBytesExclusiveDurable } from "../extraction/fill/manifest/durable-exclusive-publication.js";
import { proposalCacheKey, type SemanticProposalKind } from "./workset.js";
import { isCompleteSemanticFinish } from "../compile-seed/http/semantic-provider-http.js";
import { ExtractionTransportProvenanceSchema, type ExtractionTransportProvenance } from "../extraction/transport-route.js";
import { readBoundedCanonicalUtf8Artifact } from "../extraction/cache-audit/bounded-artifact-reader.js";

export const SEMANTIC_PROPOSAL_CACHE_CONTRACT = "source-semantic-proposal-cache-v3" as const;
export const SEMANTIC_PROPOSAL_SHARD_MAX_BYTES = 32 * 1024 * 1024;

export class SemanticProposalIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SemanticProposalIdentityError";
  }
}

const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative()
}).strict();

const ShardSchema = z.object({
  contract: z.literal(SEMANTIC_PROPOSAL_CACHE_CONTRACT),
  kind: z.enum(["query", "semantic_correspondence"]),
  cache_key: z.string().regex(/^[0-9a-f]{64}$/u),
  model: z.string().min(1),
  request_profile: z.string().min(1),
  original_query: z.string().min(1),
  system_prompt: z.string().min(1),
  user_prompt: z.string().min(1),
  raw_json: z.string(),
  outcome: z.unknown(),
  admitted: z.boolean(),
  attempt_ordinal: z.number().int().positive(),
  attempt_lineage_digest: z.string().regex(/^[0-9a-f]{64}$/u),
  request_digest: z.string().regex(/^[0-9a-f]{64}$/u),
  extracted_at: z.string().min(1),
  usage: UsageSchema.optional(),
  finish_reason: z.string().nullable().optional(),
  completion_witness: z.literal("finish_reason").nullable().optional(),
  raw_digest: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  max_output_tokens: z.number().int().positive().optional(),
  transport_provenance: ExtractionTransportProvenanceSchema
}).strict();

export type SemanticProposalShard = z.infer<typeof ShardSchema>;

export type SemanticProposalLookup = Readonly<{
  kind: SemanticProposalKind;
  model: string;
  request_profile: string;
  system_prompt?: string;
  user_prompt?: string;
  schema?: object;
  max_output_tokens?: number;
  provider_url?: string;
  request_digest?: string;
  transport_provenance?: ExtractionTransportProvenance;
  attempt_lineage_digest?: string;
}>;

export function semanticProposalShardPath(cacheRoot: string, key: string): string {
  return join(cacheRoot, key.slice(0, 2), `${key}.json`);
}

export function readSemanticProposalShard(cacheRoot: string, key: string): SemanticProposalShard | undefined {
  const path = semanticProposalShardPath(cacheRoot, key);
  if (!existsSync(path)) return undefined;
  return ShardSchema.parse(JSON.parse(readBoundedCanonicalUtf8Artifact({ path,
    maxBytes: SEMANTIC_PROPOSAL_SHARD_MAX_BYTES, label: "semantic proposal shard" })));
}

export function inspectSemanticProposalShard(
  cacheRoot: string, key: string, expected: SemanticProposalLookup
): SemanticProposalShard | undefined {
  const path = semanticProposalShardPath(cacheRoot, key);
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readBoundedCanonicalUtf8Artifact({ path,
      maxBytes: SEMANTIC_PROPOSAL_SHARD_MAX_BYTES, label: "semantic proposal shard" }));
  } catch {
    throw new SemanticProposalIdentityError(`semantic proposal cache is malformed: ${key}`);
  }
  const shard = ShardSchema.safeParse(parsed);
  if (!shard.success) {
    throw new SemanticProposalIdentityError(`semantic proposal cache is malformed: ${key}`);
  }
  if (shard.data.cache_key !== key || shard.data.kind !== expected.kind ||
      shard.data.model !== expected.model || shard.data.request_profile !== expected.request_profile ||
      expected.attempt_lineage_digest !== undefined && shard.data.attempt_lineage_digest !== expected.attempt_lineage_digest) {
    throw new SemanticProposalIdentityError(`semantic proposal cache identity mismatch: ${key}`);
  }
  const digest = createHash("sha256").update(shard.data.raw_json, "utf8").digest("hex");
  if (shard.data.raw_digest !== undefined && shard.data.raw_digest !== digest) {
    throw new SemanticProposalIdentityError(`semantic proposal cache identity mismatch: ${key}`);
  }
  const bind = requestBind(expected);
  if (bind !== undefined) {
    if (shard.data.raw_digest !== digest ||
        shard.data.system_prompt !== bind.system_prompt || shard.data.user_prompt !== bind.user_prompt ||
        shard.data.max_output_tokens !== bind.max_output_tokens || shard.data.request_digest !== bind.request_digest ||
        canonicalJson(shard.data.transport_provenance) !== canonicalJson(bind.transport_provenance)) {
      throw new SemanticProposalIdentityError(`semantic proposal cache identity mismatch: ${key}`);
    }
    const derived = proposalCacheKey(
      shard.data.model, shard.data.request_profile,
      shard.data.system_prompt, shard.data.user_prompt, bind.schema, bind.max_output_tokens, bind.provider_url
    );
    if (derived !== key || derived !== shard.data.cache_key) {
      throw new SemanticProposalIdentityError(`semantic proposal cache identity mismatch: ${key}`);
    }
  }
  return shard.data;
}

function requestBind(expected: SemanticProposalLookup): Readonly<{
  system_prompt: string;
  user_prompt: string;
  schema: object;
  max_output_tokens: number;
  provider_url: string;
  request_digest: string;
  transport_provenance: ExtractionTransportProvenance;
}> | undefined {
  const { system_prompt, user_prompt, schema, max_output_tokens, provider_url, request_digest, transport_provenance } = expected;
  const bound = system_prompt !== undefined && user_prompt !== undefined &&
    schema !== undefined && max_output_tokens !== undefined && provider_url !== undefined &&
    request_digest !== undefined && transport_provenance !== undefined;
  const absent = system_prompt === undefined && user_prompt === undefined &&
    schema === undefined && max_output_tokens === undefined && provider_url === undefined &&
    request_digest === undefined && transport_provenance === undefined;
  if (!bound && !absent) {
    throw new SemanticProposalIdentityError("semantic proposal cache lookup is incomplete");
  }
  if (system_prompt === undefined || user_prompt === undefined ||
      schema === undefined || max_output_tokens === undefined || provider_url === undefined ||
      request_digest === undefined || transport_provenance === undefined) {
    return undefined;
  }
  return { system_prompt, user_prompt, schema, max_output_tokens, provider_url, request_digest, transport_provenance };
}

export function writeSemanticProposalShard(cacheRoot: string, shard: SemanticProposalShard): void {
  const parsed = ShardSchema.parse(shard);
  const path = semanticProposalShardPath(cacheRoot, parsed.cache_key);
  mkdirSync(dirname(path), { recursive: true });
  const existing = readSemanticProposalShard(cacheRoot, parsed.cache_key);
  if (existing !== undefined) {
    // Recovery may revisit publication after a crash before reservation settlement.
    // The timestamp is publication bookkeeping; every semantic/attempt field must match.
    if (canonicalJson({ ...existing, extracted_at: "" }) !== canonicalJson({ ...parsed, extracted_at: "" })) {
      throw new SemanticProposalIdentityError(`immutable semantic proposal conflict: ${parsed.cache_key}`);
    }
    return;
  }
  try {
    const bytes = Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    if (bytes.length > SEMANTIC_PROPOSAL_SHARD_MAX_BYTES) {
      throw new SemanticProposalIdentityError(`semantic proposal shard exceeds supported byte bound: ${parsed.cache_key}`);
    }
    publishBytesExclusiveDurable({ destination: path,
      bytes,
      ownerIdentity: `${parsed.cache_key}:${parsed.attempt_ordinal}`, temporaryDirectory: dirname(path) });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    const winner = readSemanticProposalShard(cacheRoot, parsed.cache_key);
    if (winner === undefined || canonicalJson({ ...winner, extracted_at: "" }) !==
        canonicalJson({ ...parsed, extracted_at: "" })) {
      throw new SemanticProposalIdentityError(`immutable semantic proposal conflict: ${parsed.cache_key}`);
    }
  }
}

export function proposalOutcomeStatus(shard: SemanticProposalShard): string {
  if (typeof shard.outcome !== "object" || shard.outcome === null || Array.isArray(shard.outcome)) {
    return "invalid";
  }
  const status = (shard.outcome as { readonly status?: unknown }).status;
  return typeof status === "string" ? status : "invalid";
}

export function hasVerifiedProposalCompletion(shard: SemanticProposalShard): boolean {
  return isCompleteSemanticFinish(shard.request_profile, shard.finish_reason) &&
    shard.completion_witness === "finish_reason";
}

/** Local outcome shape only; executable reads also require durable attempt/raw closure. */
export function hasAdmittedProposalOutcome(shard: SemanticProposalShard): boolean {
  return shard.admitted === true && proposalOutcomeStatus(shard) === "interpreted" &&
    hasVerifiedProposalCompletion(shard);
}

export function listSemanticProposalKeys(cacheRoot: string, kind: SemanticProposalKind): ReadonlySet<string> {
  const keys = new Set<string>();
  if (!existsSync(cacheRoot)) return keys;
  for (const bucket of readdirSync(cacheRoot, { withFileTypes: true })) {
    if (!bucket.isDirectory() || !/^[0-9a-f]{2}$/u.test(bucket.name)) continue;
    for (const file of readdirSync(join(cacheRoot, bucket.name))) {
      if (!/^[0-9a-f]{64}\.json$/u.test(file)) continue;
      const key = file.slice(0, 64);
      if (bucket.name !== key.slice(0, 2)) {
        throw new SemanticProposalIdentityError(`semantic proposal cache identity mismatch: ${key}`);
      }
      const shard = ShardSchema.safeParse(JSON.parse(readBoundedCanonicalUtf8Artifact({
        path: join(cacheRoot, bucket.name, file), maxBytes: SEMANTIC_PROPOSAL_SHARD_MAX_BYTES,
        label: "semantic proposal shard inventory" })));
      if (!shard.success || shard.data.cache_key !== key) {
        throw new SemanticProposalIdentityError(`semantic proposal cache identity mismatch: ${key}`);
      }
      if (shard.data.kind === kind) keys.add(shard.data.cache_key);
    }
  }
  return keys;
}
