import { resolve } from "node:path";
import { z } from "zod";
import {
  OpenSemanticFactorFormationCaptureSchema,
  QueryOsfSemanticCompletenessReceiptSchema
} from "@do-soul/alaya-protocol";
import {
  OPEN_SEMANTIC_FACTOR_QUERY_REQUEST_TEMPLATE,
  OPEN_SEMANTIC_FACTOR_QUERY_SYSTEM_PROMPT
} from "@do-soul/alaya-soul";
import { readRegularFileNoFollow, sha256Buffer } from
  "../../snapshot/bound-file.js";
import type { ExtractionTransportProvenance } from
  "../../extraction/transport-route.js";
import {
  QuerySemanticFactorCacheIdentitySchema,
  assertCurrentQuerySemanticFactorCacheIdentity,
  assertQuerySemanticFactorCacheMatchesRequest,
  currentQueryCacheRequestProfile,
  inspectQuerySemanticFactorCacheIdentity,
  queryCachePrefixedSha256,
  type QuerySemanticFactorCacheBinding
} from "../query-semantic-factor-cache-identity.js";
import {
  assertQueryCacheSourceSet,
  compareQueryCacheCodeUnits,
  queryCacheSourceSetDigest,
  resolveQueryCacheRequestSourceTexts
} from "./source-set.js";
import { assertQuerySemanticFactorCacheEntries } from
  "../query-semantic-factor-cache-certification.js";

const QuerySemanticFactorCacheEntrySchema = z.object({
  source_text: z.string().min(1),
  source_sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  capture: OpenSemanticFactorFormationCaptureSchema,
  receipt: QueryOsfSemanticCompletenessReceiptSchema.nullable()
}).strict();

const TransportProvenanceSchema = z.object({
  provider_url_sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  model: z.string().min(1)
}).strict();

export const QuerySemanticFactorCacheSchema = QuerySemanticFactorCacheIdentitySchema
  .omit({ entry_count: true })
  .extend({
    entries: z.array(QuerySemanticFactorCacheEntrySchema).min(1)
  })
  .strict();

export type QuerySemanticFactorCache = z.infer<typeof QuerySemanticFactorCacheSchema>;

export type BoundQuerySemanticFactorCacheFile = Readonly<{
  binding: QuerySemanticFactorCacheBinding;
  cache: QuerySemanticFactorCache;
  file_sha256: string;
}>;

export function bindCurrentQuerySemanticFactorCache(
  raw: unknown,
  requiredSourceTexts: readonly string[]
): QuerySemanticFactorCacheBinding {
  const cache = parseCurrentQuerySemanticFactorCache(raw);
  assertQuerySemanticFactorCacheSelfSeal(cache);
  assertQueryCacheSourceSet(cache, requiredSourceTexts);
  return toBinding(cache);
}

export async function bindQuerySemanticFactorCacheFileToRequest(
  path: string,
  request: Readonly<{
    readonly requestProfile: string;
    readonly model: string;
    readonly providerRoute: string;
    readonly snapshotPath?: string;
    readonly requiredSourceTexts?: readonly string[];
  }>
): Promise<BoundQuerySemanticFactorCacheFile> {
  const required = resolveQueryCacheRequestSourceTexts(request);
  let bytes: Buffer;
  try {
    bytes = readRegularFileNoFollow(resolve(path));
  } catch {
    throw new Error("query semantic factor cache is missing or unreadable");
  }
  const raw = JSON.parse(bytes.toString("utf8")) as unknown;
  const cache = parseCurrentQuerySemanticFactorCache(raw);
  assertQuerySemanticFactorCacheSelfSeal(cache);
  assertQueryCacheSourceSet(cache, required);
  const binding = toBinding(cache);
  assertQuerySemanticFactorCacheMatchesRequest(binding, request);
  await assertQuerySemanticFactorCacheEntries(cache.entries);
  return { binding, cache, file_sha256: sha256Buffer(bytes) };
}

export function assertBoundQuerySemanticFactorCacheFileDigest(
  path: string,
  fileSha256: string
): void {
  const bytes = readRegularFileNoFollow(resolve(path));
  if (sha256Buffer(bytes) !== fileSha256) {
    throw new Error("query semantic factor cache file digest drifted after bind");
  }
}

export async function assertQuerySemanticFactorCacheFileMatchesRequest(
  path: string,
  request: Readonly<{
    readonly requestProfile: string;
    readonly model: string;
    readonly providerRoute: string;
    readonly snapshotPath?: string;
    readonly requiredSourceTexts?: readonly string[];
  }>
): Promise<QuerySemanticFactorCacheBinding> {
  return (await bindQuerySemanticFactorCacheFileToRequest(path, request)).binding;
}

function parseCurrentQuerySemanticFactorCache(raw: unknown): QuerySemanticFactorCache {
  assertCurrentQuerySemanticFactorCacheIdentity(
    inspectQuerySemanticFactorCacheIdentity(raw)
  );
  return QuerySemanticFactorCacheSchema.parse(raw);
}

export function assertQuerySemanticFactorCacheSelfSeal(
  cache: QuerySemanticFactorCache
): void {
  currentQueryCacheRequestProfile(cache.request_profile);
  if (cache.system_prompt_sha256 !==
        queryCachePrefixedSha256(OPEN_SEMANTIC_FACTOR_QUERY_SYSTEM_PROMPT)) {
    throw new Error("query semantic factor cache prompt identity does not match this runtime");
  }
  if (cache.request_template_sha256 !==
        queryCachePrefixedSha256(OPEN_SEMANTIC_FACTOR_QUERY_REQUEST_TEMPLATE)) {
    throw new Error("query semantic factor cache request template does not match this runtime");
  }
  const sources = new Set<string>();
  for (const entry of cache.entries) {
    if (sources.has(entry.source_text) ||
        entry.source_sha256 !== queryCachePrefixedSha256(entry.source_text)) {
      throw new Error("query semantic factor cache has duplicate or unbound source entries");
    }
    sources.add(entry.source_text);
  }
  if (cache.source_set_sha256 !== queryCacheSourceSetDigest([...sources])) {
    throw new Error("query semantic factor cache source set digest mismatch");
  }
  if (queryCacheStableJson(cache.transport_routes) !==
        queryCacheStableJson(normalizeTransportProvenance(cache.transport_routes))) {
    throw new Error("query semantic factor cache transport provenance is not canonical");
  }
  const { cache_content_sha256: _, ...withoutDigest } = cache;
  if (cache.cache_content_sha256 !== queryCachePrefixedSha256(queryCacheStableJson(withoutDigest))) {
    throw new Error("query semantic factor cache content digest mismatch");
  }
}

export function toBinding(cache: QuerySemanticFactorCache): QuerySemanticFactorCacheBinding {
  return {
    schema_version: cache.schema_version,
    cache_content_sha256: cache.cache_content_sha256,
    compiler_operator_id: cache.compiler_operator_id,
    request_profile: currentQueryCacheRequestProfile(cache.request_profile),
    system_prompt_sha256: cache.system_prompt_sha256,
    request_template_sha256: cache.request_template_sha256,
    model_id: cache.model_id,
    provider_url_sha256: cache.provider_url_sha256,
    source_set_sha256: cache.source_set_sha256,
    entry_count: cache.entries.length,
    transport_routes: cache.transport_routes.map((route) => ({ ...route }))
  };
}

export function normalizeTransportProvenance(
  routes: readonly ExtractionTransportProvenance[]
): readonly ExtractionTransportProvenance[] {
  const unique = new Map(routes.map((route) => [
    `${route.provider_url_sha256}\0${route.model}`,
    TransportProvenanceSchema.parse(route)
  ]));
  return [...unique.values()].sort((left, right) =>
    compareQueryCacheCodeUnits(left.provider_url_sha256, right.provider_url_sha256) ||
    compareQueryCacheCodeUnits(left.model, right.model));
}

export function queryCacheStableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => queryCacheStableJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort(compareQueryCacheCodeUnits).map((key) =>
    `${JSON.stringify(key)}:${queryCacheStableJson(record[key])}`).join(",")}}`;
}
