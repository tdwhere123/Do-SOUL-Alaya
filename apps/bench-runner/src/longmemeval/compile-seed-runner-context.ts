import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  OFFICIAL_API_SYSTEM_PROMPT,
  OfficialApiGardenProvider
} from "@do-soul/alaya-soul";
import { readExtractionCacheManifest } from "./extraction-cache-manifest.js";
import { createCachingSignalExtractor } from "./compile-seed-cache.js";
import {
  EXTRACTION_CACHE_ROOT,
  resolveCompileSeedExtractionConfig
} from "./compile-seed-config.js";
import {
  createGardenHttpExtractor,
  EXTRACTION_REQUEST_TIMEOUT_MS
} from "./compile-seed-http.js";
import { preflightExtractionCache } from "./compile-seed-preflight.js";
import { preflightDeepSeekWarmSubstrateCache } from "./deepseek-cache-config.js";
import { normalizeEnvDiagDir } from "./compile-seed-extract.js";
import type {
  CompileSeedExtractionStats,
  CompileSeedRunnerOptions
} from "./compile-seed-types.js";

const DEFAULT_COMPILE_SEED_DIAGNOSTIC_DIR_REL =
  "data/diagnostics/seed-extraction-failures";

export interface CompileSeedRunnerContext {
  readonly config: ReturnType<typeof resolveCompileSeedExtractionConfig>;
  readonly stats: CompileSeedExtractionStats;
  readonly provider: OfficialApiGardenProvider | null;
  readonly diagnosticDir: string | null;
}

export function createCompileSeedRunnerContext(
  options: CompileSeedRunnerOptions | undefined
): CompileSeedRunnerContext {
  const cacheRoot = options?.cacheRoot ?? EXTRACTION_CACHE_ROOT;
  const manifest = options?.config
    ? undefined
    : readExtractionCacheManifest(cacheRoot);
  const config =
    options?.config ?? resolveCompileSeedExtractionConfig(process.env, manifest);
  const credentialled = config.apiKey !== null;
  runExtractionCachePreflight(options, cacheRoot, config, credentialled, manifest);
  const stats = createCompileSeedStats(credentialled);
  const diagnosticDir = resolveCompileSeedDiagnosticDir(options);
  ensureDiagnosticDir(diagnosticDir);
  return {
    config,
    stats,
    diagnosticDir,
    provider: createOfficialApiProvider({
      options,
      config,
      cacheRoot,
      stats,
      credentialled,
      diagnosticDir
    })
  };
}

function runExtractionCachePreflight(
  options: CompileSeedRunnerOptions | undefined,
  cacheRoot: string,
  config: ReturnType<typeof resolveCompileSeedExtractionConfig>,
  credentialled: boolean,
  manifest: ReturnType<typeof readExtractionCacheManifest> | undefined
): void {
  if (options?.skipPreflight === true) return;
  preflightDeepSeekWarmSubstrateCache({
    cacheRoot,
    config,
    liveExtractionPossible: credentialled,
    ...(options?.allowLiveExtraction === undefined
      ? {}
      : { allowLiveExtraction: options.allowLiveExtraction }),
    ...(options?.requiredTurnContents === undefined
      ? {}
      : { requiredTurnContents: options.requiredTurnContents })
  });
  preflightExtractionCache({
    cacheRoot,
    config,
    systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
    liveExtractionPossible: credentialled,
    ...(options?.allowLiveExtraction === undefined
      ? {}
      : { allowLiveExtraction: options.allowLiveExtraction }),
    ...(options?.requiredTurnContents === undefined
      ? {}
      : { requiredTurnContents: options.requiredTurnContents }),
    ...(manifest === undefined ? {} : { manifest })
  });
}

function createCompileSeedStats(credentialled: boolean): CompileSeedExtractionStats {
  return {
    path: credentialled ? "official_api_compile" : "no_credentials_fallback",
    cacheHits: 0,
    llmCalls: 0,
    offlineFallbacks: 0,
    liveExtractionFailures: 0,
    cachedExtractionFailures: 0,
    factsProduced: 0,
    signalsDropped: 0,
    signalsDroppedByReason: { candidate_absent: 0, materialization_drop: 0 },
    parseDropped: 0,
    compileOverflowDropped: 0,
    lastTurnRawSignalCount: 0,
    lastTurnDraftCount: 0,
    lastExtractionSource: null,
    lastCacheKey: null
  };
}

function resolveCompileSeedDiagnosticDir(
  options: CompileSeedRunnerOptions | undefined
): string | null {
  const envDiagDir = normalizeEnvDiagDir(
    process.env.ALAYA_SEED_EXTRACTION_DIAG_DIR
  );
  if (options?.diagnosticDir === null) return null;
  if (options?.diagnosticDir !== undefined) return resolve(options.diagnosticDir);
  if (envDiagDir !== null) return resolve(envDiagDir);
  return resolve(process.cwd(), DEFAULT_COMPILE_SEED_DIAGNOSTIC_DIR_REL);
}

function ensureDiagnosticDir(diagnosticDir: string | null): void {
  if (diagnosticDir === null) return;
  try {
    mkdirSync(diagnosticDir, { recursive: true });
  } catch {
    // dumpSeedExtractionFailureDiagnostic logs the per-failure error.
  }
}

function createOfficialApiProvider(input: {
  readonly options: CompileSeedRunnerOptions | undefined;
  readonly config: ReturnType<typeof resolveCompileSeedExtractionConfig>;
  readonly cacheRoot: string;
  readonly stats: CompileSeedExtractionStats;
  readonly credentialled: boolean;
  readonly diagnosticDir: string | null;
}): OfficialApiGardenProvider | null {
  if (!input.credentialled) return null;
  return new OfficialApiGardenProvider({
    apiKey: input.config.apiKey,
    model: input.config.model,
    ...(input.config.providerUrl === ""
      ? {}
      : { endpoint: input.config.providerUrl }),
    extractor: createCachingSignalExtractor({
      delegate:
        input.options?.extractorFactory?.(input.config) ??
        createGardenHttpExtractor(input.config),
      model: input.config.model,
      cacheRoot: input.cacheRoot,
      stats: input.stats
    }),
    requestTimeoutMs: EXTRACTION_REQUEST_TIMEOUT_MS,
    diagnosticDir: input.diagnosticDir
  });
}
