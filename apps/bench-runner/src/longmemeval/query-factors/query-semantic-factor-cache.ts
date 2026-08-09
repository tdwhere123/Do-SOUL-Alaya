import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import {
  OpenSemanticFactorFormationCaptureSchema,
  openSemanticFactorFormationCapturePreimage,
  type OpenSemanticFactorFormationCapture,
  type OpenSemanticFactorGraphProposal
} from "@do-soul/alaya-protocol";
import {
  OFFICIAL_API_GARDEN_MODEL,
  OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID,
  OPEN_SEMANTIC_FACTOR_QUERY_SYSTEM_PROMPT,
  OfficialApiGardenProvider
} from "@do-soul/alaya-soul";
import { materializeOpenSemanticFactorFormation } from "@do-soul/alaya-core";
import { createGardenHttpExtractor } from "../compile-seed/compile-seed-http.js";
import { resolveCompileSeedExtractionConfig } from "../compile-seed/compile-seed-config.js";
import { readSnapshotSidecar } from "../snapshot/materialize.js";

const QUERY_SEMANTIC_FACTOR_CACHE_SCHEMA_VERSION = 1 as const;

const QuerySemanticFactorCacheEntrySchema = z.object({
  source_text: z.string().min(1),
  source_sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  capture: OpenSemanticFactorFormationCaptureSchema
}).strict();

const QuerySemanticFactorCacheSchema = z.object({
  schema_version: z.literal(QUERY_SEMANTIC_FACTOR_CACHE_SCHEMA_VERSION),
  compiler_operator_id: z.literal(OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID),
  system_prompt_sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  model_id: z.string().min(1),
  provider_url_sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  source_set_sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  entries: z.array(QuerySemanticFactorCacheEntrySchema).min(1),
  cache_content_sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u)
}).strict();

export type QuerySemanticFactorCache = z.infer<typeof QuerySemanticFactorCacheSchema>;

export type QuerySemanticFactorCacheBinding = Readonly<{
  schema_version: 1;
  cache_content_sha256: string;
  compiler_operator_id: typeof OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID;
  system_prompt_sha256: string;
  model_id: string;
  provider_url_sha256: string;
  source_set_sha256: string;
  entry_count: number;
}>;

export type LoadedQuerySemanticFactorCache = Readonly<{
  binding: QuerySemanticFactorCacheBinding;
  captures_by_source_text: ReadonlyMap<string, Readonly<OpenSemanticFactorFormationCapture>>;
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
  const entries = await mapWithConcurrency(
    sourceTexts,
    input.concurrency ?? 4,
    async (sourceText, index) => {
      const graph = await provider.extractOpenSemanticFactors("query", sourceText);
      const capture = materializeOpenSemanticFactorFormation({
        source_kind: "query",
        source_text: sourceText,
        ...(graph === null ? {} : {
          proposal: {
            schema_version: 1,
            producer_operator_id: OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID,
            source_text: sourceText,
            graph
          }
        })
      });
      if (capture.status !== "formed" && capture.status !== "unavailable") {
        throw new Error(`query semantic factor compiler emitted invalid capture at index ${index}`);
      }
      input.log?.(`[query-factor-cache] ${index + 1}/${sourceTexts.length} ${capture.status}`);
      return {
        source_text: sourceText,
        source_sha256: prefixedSha256(sourceText),
        capture
      };
    }
  );
  const cache = createQuerySemanticFactorCache({
    model_id: config.model || OFFICIAL_API_GARDEN_MODEL,
    provider_url: config.providerUrl,
    entries
  });
  await writeQuerySemanticFactorCache(input.output_path, cache);
  return toBinding(cache);
}

export function createQuerySemanticFactorCache(input: Readonly<{
  readonly model_id: string;
  readonly provider_url: string;
  readonly entries: readonly Readonly<{
    readonly source_text: string;
    readonly source_sha256: string;
    readonly capture: Readonly<OpenSemanticFactorFormationCapture>;
  }>[];
}>): QuerySemanticFactorCache {
  const entries = [...input.entries]
    .map((entry) => ({
      source_text: entry.source_text,
      source_sha256: entry.source_sha256,
      capture: entry.capture
    }))
    .sort((left, right) => left.source_text.localeCompare(right.source_text));
  const withoutDigest = {
    schema_version: QUERY_SEMANTIC_FACTOR_CACHE_SCHEMA_VERSION,
    compiler_operator_id: OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID,
    system_prompt_sha256: prefixedSha256(OPEN_SEMANTIC_FACTOR_QUERY_SYSTEM_PROMPT),
    model_id: input.model_id,
    provider_url_sha256: prefixedSha256(input.provider_url),
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
  assertQuerySemanticFactorCache(cache);
  const capturesBySourceText = new Map<string, Readonly<OpenSemanticFactorFormationCapture>>();
  for (const entry of cache.entries) {
    capturesBySourceText.set(entry.source_text, entry.capture);
  }
  for (const sourceText of input.required_source_texts) {
    if (!capturesBySourceText.has(sourceText)) {
      throw new Error("query semantic factor cache is missing a required query source");
    }
  }
  return {
    binding: toBinding(cache),
    captures_by_source_text: capturesBySourceText
  };
}

function assertQuerySemanticFactorCache(cache: QuerySemanticFactorCache): void {
  const expectedPrompt = prefixedSha256(OPEN_SEMANTIC_FACTOR_QUERY_SYSTEM_PROMPT);
  if (cache.system_prompt_sha256 !== expectedPrompt) {
    throw new Error("query semantic factor cache prompt identity does not match this runtime");
  }
  const sources = new Set<string>();
  for (const entry of cache.entries) {
    if (sources.has(entry.source_text) || entry.source_sha256 !== prefixedSha256(entry.source_text)) {
      throw new Error("query semantic factor cache has duplicate or unbound source entries");
    }
    sources.add(entry.source_text);
    assertCaptureIntegrity(entry.source_text, entry.capture);
  }
  if (cache.source_set_sha256 !== sourceSetSha256([...sources])) {
    throw new Error("query semantic factor cache source set digest mismatch");
  }
  const { cache_content_sha256: _, ...withoutDigest } = cache;
  if (cache.cache_content_sha256 !== prefixedSha256(stableJson(withoutDigest))) {
    throw new Error("query semantic factor cache content digest mismatch");
  }
}

function assertCaptureIntegrity(
  sourceText: string,
  capture: Readonly<OpenSemanticFactorFormationCapture>
): void {
  if (capture.status !== "formed" && capture.status !== "unavailable") {
    throw new Error("query semantic factor cache contains an unsupported capture state");
  }
  if (capture.status === "formed" &&
      (capture.graph === null || capture.graph.source_kind !== "query" ||
       capture.producer_operator_id !== OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID)) {
    throw new Error("query semantic factor cache formed capture is invalid");
  }
  if (capture.status === "unavailable" &&
      (capture.graph !== null || capture.producer_operator_id !== null)) {
    throw new Error("query semantic factor cache unavailable capture is invalid");
  }
  const body = {
    schema_version: capture.schema_version,
    operator_id: capture.operator_id,
    status: capture.status,
    producer_operator_id: capture.producer_operator_id,
    source_sha256: capture.source_sha256,
    graph: capture.graph
  };
  if (capture.source_sha256 !== prefixedSha256(sourceText) ||
      capture.capture_digest !== prefixedSha256(openSemanticFactorFormationCapturePreimage(body))) {
    throw new Error("query semantic factor cache capture digest mismatch");
  }
}

function toBinding(cache: QuerySemanticFactorCache): QuerySemanticFactorCacheBinding {
  return {
    schema_version: cache.schema_version,
    cache_content_sha256: cache.cache_content_sha256,
    compiler_operator_id: cache.compiler_operator_id,
    system_prompt_sha256: cache.system_prompt_sha256,
    model_id: cache.model_id,
    provider_url_sha256: cache.provider_url_sha256,
    source_set_sha256: cache.source_set_sha256,
    entry_count: cache.entries.length
  };
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

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<readonly R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const pump = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index];
      if (item !== undefined) results[index] = await worker(item, index);
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) }, pump
  ));
  return results;
}
