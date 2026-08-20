import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import {
  OpenSemanticFactorFormationCaptureSchema,
  QueryOsfSemanticCompletenessReceiptSchema,
  type CertifiedQueryOsfGraph,
  type OpenSemanticFactorFormationCapture,
  type QueryFactFrameOsfObligation,
  type QueryOsfSemanticCompletenessReceipt
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

const QUERY_SEMANTIC_FACTOR_CACHE_SCHEMA_VERSION = 3 as const;

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
const QuerySemanticFactorCacheBaseSchema = z.object({
  compiler_operator_id: z.literal(OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID),
  system_prompt_sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  request_template_sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  model_id: z.string().min(1),
  provider_url_sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  source_set_sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  entries: z.array(QuerySemanticFactorCacheEntrySchema).min(1),
  cache_content_sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u)
}).strict();
const QuerySemanticFactorCacheSchema = QuerySemanticFactorCacheBaseSchema.extend({
  schema_version: z.literal(QUERY_SEMANTIC_FACTOR_CACHE_SCHEMA_VERSION),
  transport_routes: z.array(TransportProvenanceSchema).min(1)
}).strict();

export type QuerySemanticFactorCache = z.infer<typeof QuerySemanticFactorCacheSchema>;

export type QuerySemanticFactorCacheBinding = Readonly<{
  schema_version: 3;
  cache_content_sha256: string;
  compiler_operator_id: typeof OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID;
  system_prompt_sha256: string;
  request_template_sha256: string;
  model_id: string;
  provider_url_sha256: string;
  source_set_sha256: string;
  entry_count: number;
  transport_routes?: readonly ExtractionTransportProvenance[];
}>;

export type LoadedQuerySemanticFactorCache = Readonly<{
  binding: QuerySemanticFactorCacheBinding;
  captures_by_source_text: ReadonlyMap<string, Readonly<OpenSemanticFactorFormationCapture>>;
  receipts_by_source_text: ReadonlyMap<string, Readonly<QueryOsfSemanticCompletenessReceipt>>;
}>;

type FillQuerySemanticFactorSourcesInput = Readonly<{
  source_texts: readonly string[];
  output_path: string;
  model_id: string;
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
  const sourceTexts = [...new Set(readSnapshotSidecar(input.snapshot_db_path)
    .questions.map((question) => question.question))].sort((left, right) =>
      left.localeCompare(right));
  if (sourceTexts.length === 0) {
    throw new Error("query semantic factor cache fill requires at least one snapshot question");
  }
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
    schema_version: 2 as const,
    compiler_operator_id: OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID,
    system_prompt_sha256: prefixedSha256(OPEN_SEMANTIC_FACTOR_QUERY_SYSTEM_PROMPT),
    request_template_sha256: prefixedSha256(
      OPEN_SEMANTIC_FACTOR_QUERY_REQUEST_TEMPLATE
    ),
    model_id: input.model_id,
    provider_url_sha256: prefixedSha256(input.provider_url),
    source_set_sha256: sourceSetSha256(sourceTexts)
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
        source_sha256: prefixedSha256(sourceText),
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
  readonly provider_url: string;
  readonly transport_routes?: readonly ExtractionTransportProvenance[];
  readonly entries: readonly Readonly<{
    readonly source_text: string;
    readonly source_sha256: string;
    readonly capture: Readonly<OpenSemanticFactorFormationCapture>;
    readonly receipt: Readonly<QueryOsfSemanticCompletenessReceipt> | null;
  }>[];
}>): QuerySemanticFactorCache {
  const entries = [...input.entries]
    .map((entry) => ({
      source_text: entry.source_text,
      source_sha256: entry.source_sha256,
      capture: entry.capture,
      receipt: entry.receipt
    }))
    .sort((left, right) => left.source_text.localeCompare(right.source_text));
  const withoutDigest = {
    schema_version: QUERY_SEMANTIC_FACTOR_CACHE_SCHEMA_VERSION,
    compiler_operator_id: OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID,
    system_prompt_sha256: prefixedSha256(OPEN_SEMANTIC_FACTOR_QUERY_SYSTEM_PROMPT),
    request_template_sha256: prefixedSha256(
      OPEN_SEMANTIC_FACTOR_QUERY_REQUEST_TEMPLATE
    ),
    model_id: input.model_id,
    provider_url_sha256: prefixedSha256(input.provider_url),
    transport_routes: normalizeTransportProvenance(input.transport_routes ?? [{
      provider_url_sha256: prefixedSha256(input.provider_url),
      model: input.model_id
    }]),
    source_set_sha256: sourceSetSha256(entries.map((entry) => entry.source_text)),
    entries
  };
  return QuerySemanticFactorCacheSchema.parse({
    ...withoutDigest,
    cache_content_sha256: prefixedSha256(stableJson(withoutDigest))
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
  }>
): Promise<LoadedQuerySemanticFactorCache> {
  const raw = JSON.parse(await readFile(resolve(input.path), "utf8")) as unknown;
  const cache = QuerySemanticFactorCacheSchema.parse(raw);
  await assertQuerySemanticFactorCache(cache);
  const capturesBySourceText = new Map<string, Readonly<OpenSemanticFactorFormationCapture>>();
  const receiptsBySourceText = new Map<
    string, Readonly<QueryOsfSemanticCompletenessReceipt>
  >();
  for (const entry of cache.entries) {
    capturesBySourceText.set(entry.source_text, entry.capture);
    if (entry.receipt !== null) receiptsBySourceText.set(entry.source_text, entry.receipt);
  }
  for (const sourceText of input.required_source_texts) {
    if (!capturesBySourceText.has(sourceText)) {
      throw new Error("query semantic factor cache is missing a required query source");
    }
  }
  return {
    binding: toBinding(cache),
    captures_by_source_text: capturesBySourceText,
    receipts_by_source_text: receiptsBySourceText
  };
}

async function assertQuerySemanticFactorCache(cache: QuerySemanticFactorCache): Promise<void> {
  const expectedPrompt = prefixedSha256(OPEN_SEMANTIC_FACTOR_QUERY_SYSTEM_PROMPT);
  if (cache.system_prompt_sha256 !== expectedPrompt) {
    throw new Error("query semantic factor cache prompt identity does not match this runtime");
  }
  const expectedRequestTemplate = prefixedSha256(
    OPEN_SEMANTIC_FACTOR_QUERY_REQUEST_TEMPLATE
  );
  if (cache.request_template_sha256 !== expectedRequestTemplate) {
    throw new Error("query semantic factor cache request template does not match this runtime");
  }
  const sources = new Set<string>();
  for (const entry of cache.entries) {
    if (sources.has(entry.source_text) || entry.source_sha256 !== prefixedSha256(entry.source_text)) {
      throw new Error("query semantic factor cache has duplicate or unbound source entries");
    }
    sources.add(entry.source_text);
    await verifyQuerySemanticFactorCacheEntry(entry.source_text, {
      capture: entry.capture, receipt: entry.receipt
    });
  }
  if (cache.source_set_sha256 !== sourceSetSha256([...sources])) {
    throw new Error("query semantic factor cache source set digest mismatch");
  }
  if (stableJson(cache.transport_routes) !==
        stableJson(normalizeTransportProvenance(cache.transport_routes))) {
    throw new Error("query semantic factor cache transport provenance is not canonical");
  }
  const { cache_content_sha256: _, ...withoutDigest } = cache;
  if (cache.cache_content_sha256 !== prefixedSha256(stableJson(withoutDigest))) {
    throw new Error("query semantic factor cache content digest mismatch");
  }
}

function toBinding(cache: QuerySemanticFactorCache): QuerySemanticFactorCacheBinding {
  return {
    schema_version: cache.schema_version,
    cache_content_sha256: cache.cache_content_sha256,
    compiler_operator_id: cache.compiler_operator_id,
    system_prompt_sha256: cache.system_prompt_sha256,
    request_template_sha256: cache.request_template_sha256,
    model_id: cache.model_id,
    provider_url_sha256: cache.provider_url_sha256,
    source_set_sha256: cache.source_set_sha256,
    entry_count: cache.entries.length,
    transport_routes: cache.transport_routes.map((route) => ({ ...route }))
  };
}

function normalizedSourceTexts(sourceTexts: readonly string[]): readonly string[] {
  if (sourceTexts.length === 0 || sourceTexts.some((sourceText) => sourceText.length === 0)) {
    throw new Error("query semantic factor cache fill requires non-empty sources");
  }
  return [...new Set(sourceTexts)].sort((left, right) => left.localeCompare(right));
}

function transportProvenance(
  route: ExtractionTransportRoute
): ExtractionTransportProvenance {
  return buildExtractionTransportProvenance({
    model: route.model,
    providerUrl: route.providerUrl
  });
}

function normalizeTransportProvenance(
  routes: readonly ExtractionTransportProvenance[]
): readonly ExtractionTransportProvenance[] {
  const unique = new Map(routes.map((route) => [
    `${route.provider_url_sha256}\0${route.model}`,
    TransportProvenanceSchema.parse(route)
  ]));
  return [...unique.values()].sort((left, right) =>
    left.provider_url_sha256.localeCompare(right.provider_url_sha256) ||
    left.model.localeCompare(right.model));
}

function sourceSetSha256(sourceTexts: readonly string[]): string {
  return prefixedSha256([...sourceTexts]
    .map((sourceText) => prefixedSha256(sourceText))
    .sort()
    .join("\n"));
}

function prefixedSha256(value: string): string {
  return `sha256:${sha256(value)}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}
