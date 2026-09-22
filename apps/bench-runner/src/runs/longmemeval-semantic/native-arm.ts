import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  SOURCE_SEMANTIC_CACHE_CONTRACT, SOURCE_SEMANTIC_PACKET_CONTRACT, SOURCE_SEMANTIC_QUERY_CONTRACT,
  SOURCE_SEMANTIC_CORRESPONDENCE_CONTRACT, SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION,
  SOURCE_SEMANTIC_LIBRARY_PROTOCOL_VERSION, SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET,
  SOURCE_SEMANTIC_LIBRARY_OCCUPANCY, SOURCE_SEMANTIC_LIBRARY_TIE_POLICY
} from "@do-soul/alaya-protocol";
import { cacheFilePath } from "../compile-seed/cache/cache-shard.js";
import { listRetainedSourceSemanticKeys } from "../snapshot/source-records/publish.js";
import { hashRegularFileNoFollow } from "../snapshot/bound-file.js";
import { chainIdentity } from "../semantic-chain/contract.js";

/** Bench pins the public owner, never selects candidates or supplies a proof policy. */
export const NATIVE_SEMANTIC_ROUTE = {
  surface: "soul.interpretation", operation: "recall", protocol_version: SOURCE_SEMANTIC_LIBRARY_PROTOCOL_VERSION,
  result_version: SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION, page_budget: SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET,
  occupancy: SOURCE_SEMANTIC_LIBRARY_OCCUPANCY, tie_policy: SOURCE_SEMANTIC_LIBRARY_TIE_POLICY,
  source_interpretation: SOURCE_SEMANTIC_PACKET_CONTRACT, source_cache: SOURCE_SEMANTIC_CACHE_CONTRACT,
  query_semantics: SOURCE_SEMANTIC_QUERY_CONTRACT, semantic_correspondence: SOURCE_SEMANTIC_CORRESPONDENCE_CONTRACT,
  pair_allocation: "per_query_native_prefix", global_spend: "semantic_proposal_authority_attempt_ledger",
  payload: "native_bounded_encoding"
} as const;
export const NativeSemanticRouteSchema = z.custom<typeof NATIVE_SEMANTIC_ROUTE>((value) =>
  value !== undefined && chainIdentity(value) === chainIdentity(NATIVE_SEMANTIC_ROUTE), "native route contract changed");
const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const SourceCacheFreezeSchema = z.object({ root: z.string(), manifest_sha256: Digest.nullable(),
  shards: z.array(z.object({ key: Digest, sha256: Digest }).strict()) }).strict();

/** Freeze retained bytes, including invalid shards; admission remains publication's responsibility. */
export function freezeSourceCaches(roots: readonly string[]) {
  if (new Set(roots.map((root) => resolve(root))).size !== roots.length) throw new Error("source cache roots repeat");
  return roots.map((root) => ({ root: resolve(root),
    manifest_sha256: existsSync(join(root, "manifest.json")) ? hashRegularFileNoFollow(join(root, "manifest.json")) : null,
    shards: listRetainedSourceSemanticKeys(root).map((key) => ({ key, sha256: hashRegularFileNoFollow(cacheFilePath(root, key)) })) }));
}

export function assertSourceCaches(caches: z.infer<typeof SourceCacheFreezeSchema>[]): void {
  if (chainIdentity(freezeSourceCaches(caches.map((cache) => cache.root))) !== chainIdentity(caches)) {
    throw new Error("frozen source interpretation cache changed; use a new experiment freeze");
  }
}
