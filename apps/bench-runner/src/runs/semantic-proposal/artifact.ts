import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { SemanticProposalKind } from "./workset.js";

export const SEMANTIC_PROPOSAL_CACHE_CONTRACT = "source-semantic-proposal-cache-v1" as const;

const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative()
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
  usage: UsageSchema.optional()
}).strict();

export type SemanticProposalShard = z.infer<typeof ShardSchema>;

export function semanticProposalShardPath(cacheRoot: string, key: string): string {
  return join(cacheRoot, key.slice(0, 2), `${key}.json`);
}

export function readSemanticProposalShard(cacheRoot: string, key: string): SemanticProposalShard | undefined {
  const path = semanticProposalShardPath(cacheRoot, key);
  if (!existsSync(path)) return undefined;
  return ShardSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function writeSemanticProposalShard(cacheRoot: string, shard: SemanticProposalShard): void {
  const parsed = ShardSchema.parse(shard);
  const path = semanticProposalShardPath(cacheRoot, parsed.cache_key);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, { flag: "wx" });
}

export function listSemanticProposalKeys(cacheRoot: string, kind: SemanticProposalKind): ReadonlySet<string> {
  const keys = new Set<string>();
  if (!existsSync(cacheRoot)) return keys;
  for (const bucket of readdirSync(cacheRoot, { withFileTypes: true })) {
    if (!bucket.isDirectory() || !/^[0-9a-f]{2}$/u.test(bucket.name)) continue;
    for (const file of readdirSync(join(cacheRoot, bucket.name))) {
      if (!/^[0-9a-f]{64}\.json$/u.test(file)) continue;
      const shard = ShardSchema.safeParse(JSON.parse(readFileSync(join(cacheRoot, bucket.name, file), "utf8")));
      if (shard.success && shard.data.kind === kind) keys.add(shard.data.cache_key);
    }
  }
  return keys;
}
