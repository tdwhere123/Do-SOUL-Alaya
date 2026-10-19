import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalJson } from "@do-soul/alaya-protocol";
import { publishBytesExclusiveDurable } from "../extraction/fill/manifest/durable-exclusive-publication.js";
import { SemanticProposalShardSchema, semanticProposalShardPath, readSemanticProposalShard,
  SemanticProposalIdentityError, SEMANTIC_PROPOSAL_SHARD_MAX_BYTES,
  type SemanticProposalShard } from "../semantic-cache/artifact.js";

// Compatibility for existing proposal fill callers; remove with the gated research deletion.
export * from "../semantic-cache/artifact.js";

export function writeSemanticProposalShard(cacheRoot: string, shard: SemanticProposalShard): void {
  const parsed = SemanticProposalShardSchema.parse(shard);
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
