import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  OFFICIAL_API_SIGNAL_PARSER_SEMANTICS_VERSION,
  OFFICIAL_API_SOURCE_GROUNDING_SEMANTICS_VERSION,
  OfficialApiGardenProvider,
  buildOfficialApiSourceCorpus,
  parseOfficialApiExtractionRequest,
  stringifyOfficialApiExtractionRequest,
  type GardenCompileContext
} from "@do-soul/alaya-soul";
import type { CandidateMemorySignal } from "@do-soul/alaya-protocol";
import { computeCacheKey } from "../../../compile-seed/compile-seed-cache.js";
import type { RunnerRawShardInspector } from
  "../../../compile-seed/cache/runner-raw-shard-inspector.js";
import type {
  CompileSeedExtractionConfig,
  CompileSeedExtractionStats
} from "../../../compile-seed/compile-seed-types.js";
import {
  extractionModelFamily,
  readExtractionCacheManifestIdentity,
  type ExtractionCacheManifest,
  type ExtractionCacheManifestIdentity
} from "../extraction-cache-manifest.js";
import {
  createSourceAssertionSupplementReader,
  sourceAssertionSupplementBinding,
  type SourceAssertionSupplementBatchReceipt,
  type SourceAssertionSupplementReader,
  type SourceAssertionSupplementReceipt
} from "./source-assertion-supplement.js";

export interface SourceAssertionSupplementRuntime {
  readonly receipt: SourceAssertionSupplementReceipt;
  readonly binding: ReturnType<typeof sourceAssertionSupplementBinding>;
  beginTurn(): void;
  compile(
    turnContent: string,
    context: GardenCompileContext
  ): Promise<readonly CandidateMemorySignal[]>;
  mergeTurnStats(stats: CompileSeedExtractionStats): void;
}

export const SOURCE_ASSERTION_SUPPLEMENT_RECEIPT_ENV =
  "ALAYA_BENCH_SOURCE_ASSERTION_SUPPLEMENT_RECEIPT";
export const SOURCE_ASSERTION_SUPPLEMENT_CACHE_ROOT_ENV =
  "ALAYA_BENCH_SOURCE_ASSERTION_SUPPLEMENT_CACHE_ROOT";

export function resolveSourceAssertionSupplementOptions(
  env: Readonly<Record<string, string | undefined>>,
  cwd = process.cwd()
): Readonly<{ receiptPath: string; sourceCacheRoot: string }> | undefined {
  const receiptPath = normalize(env[SOURCE_ASSERTION_SUPPLEMENT_RECEIPT_ENV]);
  const sourceCacheRoot = normalize(env[SOURCE_ASSERTION_SUPPLEMENT_CACHE_ROOT_ENV]);
  if (receiptPath === null && sourceCacheRoot === null) return undefined;
  if (receiptPath === null || sourceCacheRoot === null) {
    throw new Error("source assertion supplement requires both receipt and cache root");
  }
  return Object.freeze({
    receiptPath: resolve(cwd, receiptPath),
    sourceCacheRoot: resolve(cwd, sourceCacheRoot)
  });
}

export function createSourceAssertionSupplementRuntime(input: {
  readonly receiptPath: string;
  readonly sourceCacheRoot: string;
  readonly primaryCacheRoot: string;
  readonly config: CompileSeedExtractionConfig;
  readonly rawShardInspector: RunnerRawShardInspector;
}): SourceAssertionSupplementRuntime {
  const primary = requireManifest(input.primaryCacheRoot, "primary");
  const source = requireManifest(input.sourceCacheRoot, "source");
  const reader = createReader(input, primary, source);
  const binding = sourceAssertionSupplementBinding(reader.receipt);
  const turnReceipts: SourceAssertionSupplementBatchReceipt[] = [];
  const sourceCorpusState: { current: string | null } = { current: null };
  const extractor = createExtractor(input, reader, turnReceipts, sourceCorpusState);
  const provider = new OfficialApiGardenProvider({
    apiKey: null,
    model: input.config.model,
    extractor,
    injectedExtractorCapability: "cache_only",
    diagnosticDir: null
  });
  return Object.freeze({
    receipt: reader.receipt,
    binding,
    beginTurn: () => { turnReceipts.length = 0; },
    compile: (turnContent: string, context: GardenCompileContext) =>
      compileWithSourceCorpus(provider, sourceCorpusState, turnContent, context),
    mergeTurnStats: (stats: CompileSeedExtractionStats) =>
      mergeTurnStats(stats, turnReceipts)
  });
}

function createReader(
  input: Parameters<typeof createSourceAssertionSupplementRuntime>[0],
  primary: ExtractionCacheManifestIdentity,
  source: ExtractionCacheManifestIdentity
): SourceAssertionSupplementReader {
  const reader = createSourceAssertionSupplementReader({
    receipt: readJson(input.receiptPath),
    primaryIdentity: {
      manifestSha256: primary.manifestSha256,
      model: input.config.model,
      modelFamily: input.config.modelFamily ?? input.config.model,
      requestProfile: input.config.requestProfile,
      systemPromptSha256: primary.manifest.system_prompt_sha256,
      parserSemantics: OFFICIAL_API_SIGNAL_PARSER_SEMANTICS_VERSION,
      groundingSemantics: OFFICIAL_API_SOURCE_GROUNDING_SEMANTICS_VERSION
    },
    sourceManifestSha256: source.manifestSha256,
    readSourceRawJson: (cacheKey) => requireRawJson(
      input.rawShardInspector,
      input.sourceCacheRoot,
      cacheKey,
      source.manifest.extraction_model,
      requireRequestProfile(source.manifest, "source")
    )
  });
  assertSourceIdentity(reader.receipt, source);
  return reader;
}

function createExtractor(
  input: Parameters<typeof createSourceAssertionSupplementRuntime>[0],
  reader: SourceAssertionSupplementReader,
  turnReceipts: SourceAssertionSupplementBatchReceipt[],
  sourceCorpusState: { current: string | null }
) {
  return {
    extract: async (request: { readonly systemPrompt: string; readonly userPrompt: string }) => {
      const parsed = parseOfficialApiExtractionRequest(JSON.parse(request.userPrompt));
      const primaryCacheKey = computeCacheKey(
        input.config.model,
        input.config.requestProfile,
        request.systemPrompt,
        stringifyOfficialApiExtractionRequest(parsed)
      );
      const selected = reader.readBatch({
        request: parsed,
        primaryCacheKey,
        sourceCorpus: requireActiveSourceCorpus(sourceCorpusState),
        primaryRawJson: requireRawJson(
          input.rawShardInspector,
          input.primaryCacheRoot,
          primaryCacheKey,
          input.config.model,
          input.config.requestProfile
        )
      });
      if (selected.receipt !== null) turnReceipts.push(selected.receipt);
      return { rawJson: selected.rawJson };
    }
  };
}

async function compileWithSourceCorpus(
  provider: OfficialApiGardenProvider,
  state: { current: string | null },
  turnContent: string,
  context: GardenCompileContext
): Promise<readonly CandidateMemorySignal[]> {
  if (state.current !== null) {
    throw new Error("source assertion supplement compile is already active");
  }
  state.current = buildOfficialApiSourceCorpus(turnContent.trim(), context.turn_messages);
  try {
    return await provider.compile(turnContent, context);
  } finally {
    state.current = null;
  }
}

function requireActiveSourceCorpus(state: { current: string | null }): string {
  if (state.current === null) {
    throw new Error("source assertion supplement source corpus is unavailable");
  }
  return state.current;
}

function mergeTurnStats(
  stats: CompileSeedExtractionStats,
  receipts: readonly SourceAssertionSupplementBatchReceipt[]
): void {
  stats.lastSemanticSupplementShards = [...receipts];
  stats.lastTurnRawSignalCount += receipts.reduce(
    (total, shard) => total + shard.rawSignalCount, 0
  );
  stats.lastTurnDraftCount += receipts.reduce(
    (total, shard) => total + shard.draftCount, 0
  );
}

function requireManifest(
  cacheRoot: string,
  label: string
): ExtractionCacheManifestIdentity {
  const identity = readExtractionCacheManifestIdentity(cacheRoot);
  if (identity === undefined) {
    throw new Error(`source assertion supplement ${label} manifest is missing`);
  }
  requireRequestProfile(identity.manifest, label);
  return identity;
}

function requireRequestProfile(
  manifest: ExtractionCacheManifest,
  label: string
) {
  if (manifest.schema_version !== 3 || manifest.request_profile === undefined) {
    throw new Error(`source assertion supplement ${label} manifest is not v3`);
  }
  return manifest.request_profile;
}

function requireRawJson(
  inspector: RunnerRawShardInspector,
  cacheRoot: string,
  cacheKey: string,
  model: string,
  requestProfile: CompileSeedExtractionConfig["requestProfile"]
): string {
  const inspected = inspector.inspect({
    phase: "supplement",
    cacheRoot,
    cacheKey,
    model,
    requestProfile
  });
  if (inspected.status !== "hit") {
    throw new Error(
      `source assertion supplement cache shard ${cacheKey} is ${inspected.status}`
    );
  }
  return inspected.rawJson;
}

function assertSourceIdentity(
  receipt: SourceAssertionSupplementReceipt,
  source: ExtractionCacheManifestIdentity
): void {
  const expected = receipt.source_identity;
  const manifest = source.manifest;
  if (expected.model !== manifest.extraction_model ||
      expected.model_family !== extractionModelFamily(manifest) ||
      expected.request_profile !== requireRequestProfile(manifest, "source") ||
      expected.system_prompt_sha256 !== manifest.system_prompt_sha256) {
    throw new Error("source assertion supplement source identity mismatch");
  }
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (cause) {
    throw new Error(`source assertion supplement receipt is unreadable: ${filePath}`, {
      cause
    });
  }
}

function normalize(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? null : normalized;
}
