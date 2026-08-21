import { isDeepStrictEqual } from "node:util";
import { resolve } from "node:path";
import { readRegularFileNoFollow, sha256Buffer } from "../snapshot/bound-file.js";
import {
  assertQuerySemanticFactorCacheSelfSeal,
  QuerySemanticFactorCacheSchema,
  type QuerySemanticFactorCache
} from "../query-factors/cache/document.js";
import type {
  DiagnosticQueryFactorCacheIdentity
} from "../query-factors/query-semantic-factor-cache-identity.js";
import type { ResolvedDiagnosticLoopIdentity } from "./authority/identity.js";

export async function assertGate7QueryWindowCompatibility(
  prior: ResolvedDiagnosticLoopIdentity,
  current: ResolvedDiagnosticLoopIdentity
): Promise<void> {
  const priorCache = loadVerifiedQueryCache(prior.query_factor_cache, "3Q token");
  const currentCache = loadVerifiedQueryCache(current.query_factor_cache, "current request");
  if (priorCache.model_id !== currentCache.model_id ||
      priorCache.compiler_operator_id !== currentCache.compiler_operator_id ||
      priorCache.request_profile !== currentCache.request_profile ||
      priorCache.system_prompt_sha256 !== currentCache.system_prompt_sha256 ||
      priorCache.request_template_sha256 !== currentCache.request_template_sha256 ||
      priorCache.schema_version !== currentCache.schema_version) {
    throw new Error("gate7 unlock query cache identity does not match the current request");
  }
  if (!isDeepStrictEqual(
    windowEntries(priorCache),
    matchingWindowEntries(currentCache, priorCache)
  )) {
    throw new Error("gate7 unlock query window canary entries do not match the current cache");
  }
}

function loadVerifiedQueryCache(
  identity: DiagnosticQueryFactorCacheIdentity | undefined,
  label: string
): QuerySemanticFactorCache {
  if (identity === undefined || identity.path.trim().length === 0) {
    throw new Error(`gate7 unlock ${label} is missing a bound query cache file`);
  }
  let bytes: Buffer;
  try {
    bytes = readRegularFileNoFollow(resolve(identity.path));
  } catch {
    throw new Error(`gate7 unlock ${label} query cache is missing or unreadable`);
  }
  if (sha256Buffer(bytes) !== identity.file_sha256) {
    throw new Error(`gate7 unlock ${label} query cache file digest does not match identity`);
  }
  const cache = QuerySemanticFactorCacheSchema.parse(JSON.parse(bytes.toString("utf8")));
  assertQuerySemanticFactorCacheSelfSeal(cache);
  if (cache.cache_content_sha256 !== identity.cache_content_sha256 ||
      cache.source_set_sha256 !== identity.source_set_sha256 ||
      cache.model_id !== identity.model_id) {
    throw new Error(`gate7 unlock ${label} query cache identity drifted from the file`);
  }
  return cache;
}

function windowEntries(cache: QuerySemanticFactorCache) {
  return [...cache.entries]
    .map((entry) => ({ source_text: entry.source_text, entry }))
    .sort((left, right) => left.source_text < right.source_text ? -1
      : left.source_text > right.source_text ? 1 : 0);
}

function matchingWindowEntries(
  current: QuerySemanticFactorCache,
  prior: QuerySemanticFactorCache
) {
  const byText = new Map(current.entries.map((entry) => [entry.source_text, entry]));
  return windowEntries(prior).map(({ source_text }) => {
    const entry = byText.get(source_text);
    if (entry === undefined) {
      throw new Error("gate7 unlock current query cache is missing a 3Q window entry");
    }
    return { source_text, entry };
  });
}
