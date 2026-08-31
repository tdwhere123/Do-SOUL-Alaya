import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  CertifiedQueryOsfGraph,
  OpenSemanticFactorFormationCapture,
  QueryFactFrameOsfObligation,
  QueryOsfSemanticCompletenessReceipt
} from "@do-soul/alaya-protocol";
import {
  OFFICIAL_API_GARDEN_MODEL,
  OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID,
  OPEN_SEMANTIC_FACTOR_QUERY_REQUEST_TEMPLATE,
  OPEN_SEMANTIC_FACTOR_QUERY_SYSTEM_PROMPT,
  OfficialApiGardenProvider
} from "@do-soul/alaya-soul";
import { createGardenHttpExtractor } from "../compile-seed/compile-seed-http.js";
import { resolveCompileSeedExtractionConfig } from "../compile-seed/compile-seed-config.js";
import { readSnapshotSidecar } from "../snapshot/materialize.js";
import {
  buildExtractionTransportProvenance,
  resolveExtractionTransportRoute,
  type ExtractionTransportProvenance,
  type ExtractionTransportRoute
} from "../extraction/transport-route.js";
import {
  openQuerySemanticFactorFillStore,
  type QuerySemanticFactorFillShard
} from
  "./query-semantic-factor-fill-store.js";
import { mapQueryFactorSourcesWithFailureScope } from
  "./query-semantic-factor-fill-pool.js";
import {
  compileCertifiedQueryCacheValue,
  verifyQuerySemanticFactorCacheEntry
} from "./query-semantic-factor-cache-certification.js";
import {
  QUERY_SEMANTIC_FACTOR_CACHE_SCHEMA_VERSION,
  QUERY_SEMANTIC_FACTOR_FILL_IDENTITY_SCHEMA_VERSION,
  currentQueryCacheRequestProfile,
  queryCachePrefixedSha256,
  type QuerySemanticFactorCacheBinding
} from "./query-semantic-factor-cache-identity.js";
import type { ExtractionRequestProfile } from "../extraction/request-profile.js";
import {
  QuerySemanticFactorCacheSchema,
  bindQuerySemanticFactorCacheFileToRequest,
  normalizeTransportProvenance,
  queryCacheStableJson,
  toBinding,
  type BoundQuerySemanticFactorCacheFile,
  type QuerySemanticFactorCache
} from "./cache/document.js";
import {
  canonicalizeQueryCacheSourceTexts,
  compareQueryCacheCodeUnits,
  queryCacheSourceSetDigest
} from "./cache/source-set.js";

export type { QuerySemanticFactorCache, QuerySemanticFactorCacheBinding };
export {
  assertBoundQuerySemanticFactorCacheFileDigest,
  assertQuerySemanticFactorCacheFileMatchesRequest,
  bindCurrentQuerySemanticFactorCache,
  bindQuerySemanticFactorCacheFileToRequest
} from "./cache/document.js";
export {
  queryCacheRequiredSourceTexts,
  querySemanticFactorCacheSourceSetSha256
} from "./cache/source-set.js";

export type LoadedQuerySemanticFactorCache = Readonly<{
  binding: QuerySemanticFactorCacheBinding;
  captures_by_source_text: ReadonlyMap<string, Readonly<OpenSemanticFactorFormationCapture>>;
  receipts_by_source_text: ReadonlyMap<string, Readonly<QueryOsfSemanticCompletenessReceipt>>;
}>;

type FillQuerySemanticFactorSourcesInput = Readonly<{
  source_texts: readonly string[];
  output_path: string;
  model_id: string;
  request_profile: ExtractionRequestProfile;
  provider_url: string;
  transport: ExtractionTransportRoute;
  concurrency?: number;
  compile: (
    sourceText: string,
    obligation: Readonly<QueryFactFrameOsfObligation>
  ) => Promise<Readonly<CertifiedQueryOsfGraph> | null>;
  log?: (message: string) => void;
}>;

export async function fillQuerySemanticFactorCache(input: Readonly<{
  readonly snapshot_db_path: string;
  readonly output_path: string;
  readonly concurrency?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly log?: (message: string) => void;
}>): Promise<QuerySemanticFactorCacheBinding> {
  const env = input.env ?? process.env;
  const config = resolveCompileSeedExtractionConfig(env);
  if (config.apiKey === null) {
    throw new Error("query semantic factor cache fill requires a resolved garden API key");
  }
  const sourceTexts = canonicalizeQueryCacheSourceTexts(
    readSnapshotSidecar(input.snapshot_db_path).questions.map((question) => question.question)
  );
  const provider = new OfficialApiGardenProvider({
    apiKey: config.apiKey,
    model: config.model,
    endpoint: config.providerUrl,
    extractor: createGardenHttpExtractor(config),
    diagnosticDir: null
  });
  return await fillQuerySemanticFactorSources({
    source_texts: sourceTexts,
    output_path: input.output_path,
    model_id: config.model || OFFICIAL_API_GARDEN_MODEL,
    request_profile: currentQueryCacheRequestProfile(config.requestProfile),
    provider_url: config.providerUrl,
    transport: resolveExtractionTransportRoute(config),
    concurrency: input.concurrency ?? 4,
    compile: async (sourceText, obligation) =>
      await provider.extractCertifiedQueryOpenSemanticFactors(sourceText, obligation),
    ...(input.log === undefined ? {} : { log: input.log })
  });
}

export async function fillQuerySemanticFactorSources(
  input: FillQuerySemanticFactorSourcesInput
): Promise<QuerySemanticFactorCacheBinding> {
  const sourceTexts = normalizedSourceTexts(input.source_texts);
  const store = await openQuerySemanticFactorFillStore({
    outputPath: input.output_path,
    identity: fillIdentity(input, sourceTexts)
  });
  const staged = await loadStagedSources(store, sourceTexts, input.log);
  await fillMissingSources({ input, sourceTexts, store, staged });
  const cache = createCacheFromStaged(input, sourceTexts, staged);
  await writeQuerySemanticFactorCache(input.output_path, cache);
  return toBinding(cache);
}

function fillIdentity(
  input: FillQuerySemanticFactorSourcesInput,
  sourceTexts: readonly string[]
) {
  return {
    schema_version: QUERY_SEMANTIC_FACTOR_FILL_IDENTITY_SCHEMA_VERSION,
    compiler_operator_id: OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID,
    request_profile: currentQueryCacheRequestProfile(input.request_profile),
    system_prompt_sha256: queryCachePrefixedSha256(OPEN_SEMANTIC_FACTOR_QUERY_SYSTEM_PROMPT),
    request_template_sha256: queryCachePrefixedSha256(
      OPEN_SEMANTIC_FACTOR_QUERY_REQUEST_TEMPLATE
    ),
    model_id: input.model_id,
    provider_url_sha256: queryCachePrefixedSha256(input.provider_url),
    source_set_sha256: queryCacheSourceSetDigest(sourceTexts)
  };
}

async function loadStagedSources(
  store: Awaited<ReturnType<typeof openQuerySemanticFactorFillStore>>,
  sourceTexts: readonly string[],
  log: ((message: string) => void) | undefined
): Promise<Map<string, QuerySemanticFactorFillShard>> {
  const staged = new Map<string, QuerySemanticFactorFillShard>();
  for (const sourceText of sourceTexts) {
    const shard = await store.load(sourceText);
    if (shard !== null) {
      await verifyQuerySemanticFactorCacheEntry(sourceText, {
        capture: shard.capture, receipt: shard.receipt
      });
      staged.set(sourceText, shard);
      log?.(`[query-factor-cache] reuse ${staged.size}/${sourceTexts.length}`);
    }
  }
  return staged;
}

async function fillMissingSources(context: Readonly<{
  input: FillQuerySemanticFactorSourcesInput;
  sourceTexts: readonly string[];
  store: Awaited<ReturnType<typeof openQuerySemanticFactorFillStore>>;
  staged: Map<string, QuerySemanticFactorFillShard>;
}>): Promise<void> {
  const { input, sourceTexts, store, staged } = context;
  const missing = sourceTexts.filter((sourceText) => !staged.has(sourceText));
  const transport = transportProvenance(input.transport);
  const sourceLocalFailures = await mapQueryFactorSourcesWithFailureScope(
    missing,
    input.concurrency ?? 4,
    async (sourceText) => {
      const certified = await compileCertifiedQueryCacheValue({
        sourceText, compile: input.compile
      });
      const shard = await store.put({
        source_text: sourceText,
        source_sha256: queryCachePrefixedSha256(sourceText),
        capture: certified.capture,
        receipt: certified.receipt,
        transport
      });
      staged.set(sourceText, shard);
      input.log?.(
        `[query-factor-cache] ${staged.size}/${sourceTexts.length} ${certified.capture.status}`
      );
    }
  );
  if (sourceLocalFailures.length > 0) {
    throw new AggregateError(
      sourceLocalFailures,
      `query semantic factor fill incomplete: ${sourceLocalFailures.length} ` +
        "source-local response-schema failure(s) remain"
    );
  }
}

function createCacheFromStaged(
  input: FillQuerySemanticFactorSourcesInput,
  sourceTexts: readonly string[],
  staged: ReadonlyMap<string, QuerySemanticFactorFillShard>
): QuerySemanticFactorCache {
  const shards = sourceTexts.map((sourceText) => staged.get(sourceText));
  if (shards.some((shard) => shard === undefined)) {
    throw new Error("query semantic factor partial cache did not close its source set");
  }
  const completeShards = shards.filter((shard) => shard !== undefined);
  return createQuerySemanticFactorCache({
    model_id: input.model_id,
    request_profile: input.request_profile,
    provider_url: input.provider_url,
    transport_routes: completeShards.map((shard) => shard.transport),
    entries: completeShards.map((shard) => ({
      source_text: shard.source_text,
      source_sha256: shard.source_sha256,
      capture: shard.capture,
      receipt: shard.receipt
    }))
  });
}

export function createQuerySemanticFactorCache(input: Readonly<{
  readonly model_id: string;
  readonly request_profile: ExtractionRequestProfile;
  readonly provider_url: string;
  readonly transport_routes?: readonly ExtractionTransportProvenance[];
  readonly entries: readonly Readonly<{
    readonly source_text: string;
    readonly source_sha256: string;
    readonly capture: Readonly<OpenSemanticFactorFormationCapture>;
    readonly receipt?: Readonly<QueryOsfSemanticCompletenessReceipt> | null;
  }>[];
}>): QuerySemanticFactorCache {
  const entries = [...input.entries]
    .map((entry) => ({
      source_text: entry.source_text,
      source_sha256: entry.source_sha256,
      capture: entry.capture,
      receipt: entry.receipt ?? null
    }))
    .sort((left, right) => compareQueryCacheCodeUnits(left.source_text, right.source_text));
  const withoutDigest = {
    schema_version: QUERY_SEMANTIC_FACTOR_CACHE_SCHEMA_VERSION,
    compiler_operator_id: OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID,
    request_profile: currentQueryCacheRequestProfile(input.request_profile),
    system_prompt_sha256: queryCachePrefixedSha256(OPEN_SEMANTIC_FACTOR_QUERY_SYSTEM_PROMPT),
    request_template_sha256: queryCachePrefixedSha256(
      OPEN_SEMANTIC_FACTOR_QUERY_REQUEST_TEMPLATE
    ),
    model_id: input.model_id,
    provider_url_sha256: queryCachePrefixedSha256(input.provider_url),
    transport_routes: normalizeTransportProvenance(input.transport_routes ?? [{
      provider_url_sha256: queryCachePrefixedSha256(input.provider_url),
      model: input.model_id
    }]),
    source_set_sha256: queryCacheSourceSetDigest(entries.map((entry) => entry.source_text)),
    entries
  };
  return QuerySemanticFactorCacheSchema.parse({
    ...withoutDigest,
    cache_content_sha256: queryCachePrefixedSha256(queryCacheStableJson(withoutDigest))
  });
}

export async function writeQuerySemanticFactorCache(
  outputPath: string,
  cache: QuerySemanticFactorCache
): Promise<void> {
  const target = resolve(outputPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(cache, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
}

export async function readQuerySemanticFactorCache(
  input: Readonly<{
    readonly path: string;
    readonly required_source_texts: readonly string[];
    readonly requestProfile: string;
    readonly model: string;
    readonly providerRoute: string;
  }>
): Promise<LoadedQuerySemanticFactorCache> {
  return loadedQuerySemanticFactorCacheFromBound(
    await bindQuerySemanticFactorCacheFileToRequest(input.path, {
      requestProfile: input.requestProfile,
      model: input.model,
      providerRoute: input.providerRoute,
      requiredSourceTexts: input.required_source_texts
    })
  );
}

export function loadedQuerySemanticFactorCacheFromBound(
  bound: BoundQuerySemanticFactorCacheFile
): LoadedQuerySemanticFactorCache {
  return {
    binding: bound.binding,
    captures_by_source_text: new Map(
      bound.cache.entries.map((entry) => [entry.source_text, entry.capture] as const)
    ),
    receipts_by_source_text: new Map(
      bound.cache.entries.flatMap((entry) =>
        entry.receipt === null ? [] : [[entry.source_text, entry.receipt] as const])
    )
  };
}

function normalizedSourceTexts(sourceTexts: readonly string[]): readonly string[] {
  return canonicalizeQueryCacheSourceTexts(sourceTexts);
}

function transportProvenance(
  route: ExtractionTransportRoute
): ExtractionTransportProvenance {
  return buildExtractionTransportProvenance({
    model: route.model,
    providerUrl: route.providerUrl
  });
}
