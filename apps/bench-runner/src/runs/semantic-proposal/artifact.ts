import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { proposalCacheKey, type SemanticProposalKind } from "./workset.js";

export const SEMANTIC_PROPOSAL_CACHE_CONTRACT = "source-semantic-proposal-cache-v1" as const;

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

const TransportProvenanceSchema = z.object({
  provider_url_sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  model: z.string().min(1)
}).strict();

const ShardSchema = z.object({
  contract: z.literal(SEMANTIC_PROPOSAL_CACHE_CONTRACT),
  kind: z.enum(["query", "alignment"]),
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
  extracted_at: z.string().min(1),
  usage: UsageSchema.optional(),
  finish_reason: z.string().nullable().optional(),
  completion_witness: z.literal("finish_reason").nullable().optional(),
  raw_digest: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  max_output_tokens: z.number().int().positive().optional(),
  transport_provenance: TransportProvenanceSchema.optional()
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
}>;

export function semanticProposalShardPath(cacheRoot: string, key: string): string {
  return join(cacheRoot, key.slice(0, 2), `${key}.json`);
}

export function readSemanticProposalShard(cacheRoot: string, key: string): SemanticProposalShard | undefined {
  const path = semanticProposalShardPath(cacheRoot, key);
  if (!existsSync(path)) return undefined;
  return ShardSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function inspectSemanticProposalShard(
  cacheRoot: string, key: string, expected: SemanticProposalLookup
): SemanticProposalShard | undefined {
  const path = semanticProposalShardPath(cacheRoot, key);
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new SemanticProposalIdentityError(`semantic proposal cache is malformed: ${key}`);
  }
  const shard = ShardSchema.safeParse(parsed);
  if (!shard.success) {
    throw new SemanticProposalIdentityError(`semantic proposal cache is malformed: ${key}`);
  }
  if (shard.data.cache_key !== key || shard.data.kind !== expected.kind ||
      shard.data.model !== expected.model || shard.data.request_profile !== expected.request_profile) {
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
        shard.data.max_output_tokens !== bind.max_output_tokens) {
      throw new SemanticProposalIdentityError(`semantic proposal cache identity mismatch: ${key}`);
    }
    const derived = proposalCacheKey(
      shard.data.model, shard.data.request_profile,
      shard.data.system_prompt, shard.data.user_prompt, bind.schema, bind.max_output_tokens
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
}> | undefined {
  const { system_prompt, user_prompt, schema, max_output_tokens } = expected;
  const bound = system_prompt !== undefined && user_prompt !== undefined &&
    schema !== undefined && max_output_tokens !== undefined;
  const absent = system_prompt === undefined && user_prompt === undefined &&
    schema === undefined && max_output_tokens === undefined;
  if (!bound && !absent) {
    throw new SemanticProposalIdentityError("semantic proposal cache lookup is incomplete");
  }
  if (system_prompt === undefined || user_prompt === undefined ||
      schema === undefined || max_output_tokens === undefined) {
    return undefined;
  }
  return { system_prompt, user_prompt, schema, max_output_tokens };
}

export function writeSemanticProposalShard(cacheRoot: string, shard: SemanticProposalShard): void {
  const parsed = ShardSchema.parse(shard);
  const path = semanticProposalShardPath(cacheRoot, parsed.cache_key);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, { flag: "wx" });
}

export function proposalOutcomeStatus(shard: SemanticProposalShard): string {
  if (typeof shard.outcome !== "object" || shard.outcome === null || Array.isArray(shard.outcome)) {
    return "invalid";
  }
  const status = (shard.outcome as { readonly status?: unknown }).status;
  return typeof status === "string" ? status : "invalid";
}

export function isExecutableProposalShard(shard: SemanticProposalShard): boolean {
  return shard.admitted === true && proposalOutcomeStatus(shard) === "interpreted" &&
    (shard.finish_reason === undefined || shard.finish_reason === "STOP");
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
      const shard = ShardSchema.safeParse(JSON.parse(readFileSync(join(cacheRoot, bucket.name, file), "utf8")));
      if (!shard.success || shard.data.cache_key !== key) {
        throw new SemanticProposalIdentityError(`semantic proposal cache identity mismatch: ${key}`);
      }
      if (shard.data.kind === kind) keys.add(shard.data.cache_key);
    }
  }
  return keys;
}
