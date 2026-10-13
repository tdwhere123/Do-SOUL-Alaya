import { mkdirSync, statSync } from "node:fs";
import { AlayaError } from "@do-soul/alaya-protocol";
import { resolve } from "node:path";
import {
  OFFICIAL_API_SYSTEM_PROMPT,
  OfficialApiGardenProvider
} from "@do-soul/alaya-soul";
import { readExtractionCacheManifestIdentity } from
  "../extraction/cache/extraction-cache-manifest.js";
import { createCachingSignalExtractor } from "./compile-seed-cache.js";
import {
  createRunnerRawShardInspector,
  type RunnerRawShardInspector
} from "./cache/runner-raw-shard-inspector.js";
import {
  resolveCompileSeedExtractionConfig,
  resolveExtractionSourcePacking,
  resolveEffectiveExtractionCacheRoot,
  resolveBenchExtractionCacheMinCoverage,
  resolveBenchRequireExtractionCacheManifest
} from "./compile-seed-config.js";
import {
  createGardenHttpExtractor,
  EXTRACTION_REQUEST_TIMEOUT_MS
} from "./compile-seed-http.js";
import { preflightExtractionCache } from "./compile-seed-preflight.js";
import { normalizeEnvDiagDir } from "./compile-seed-extract.js";
import type {
  CompileSeedExtractionStats,
  CompileSeedRunnerOptions,
  ExtractionCachePreflightProof,
  RawShardInspectionDiagnostics
} from "./compile-seed-types.js";
import {
  createSourceAssertionSupplementRuntime,
  type SourceAssertionSupplementRuntime
} from "../extraction/cache/semantic-supplement/source-assertion-supplement-runtime.js";
import { assertExtractionCachePreflightProofReuse } from
  "./preflight/cache-preflight-proof.js";

const DEFAULT_COMPILE_SEED_DIAGNOSTIC_DIR_REL =
  "data/diagnostics/seed-extraction-failures";

export interface CompileSeedRunnerContext {
  readonly config: ReturnType<typeof resolveCompileSeedExtractionConfig>;
  readonly stats: CompileSeedExtractionStats;
  readonly provider: OfficialApiGardenProvider | null;
  readonly semanticSupplement: SourceAssertionSupplementRuntime | null;
  readonly diagnosticDir: string | null;
  readonly extractionCachePreflightProof?: ExtractionCachePreflightProof;
}

export function createCompileSeedRunnerContext(
  options: CompileSeedRunnerOptions | undefined
): CompileSeedRunnerContext {
  const cacheRoot = resolveEffectiveExtractionCacheRoot(options?.cacheRoot);
  if ((options?.cacheRoot?.trim().length ?? 0) > 0 ||
      (process.env.ALAYA_BENCH_EXTRACTION_CACHE_ROOT?.trim().length ?? 0) > 0) {
    assertSelectedCacheRootExists(cacheRoot);
  }
  const manifestIdentity = readExtractionCacheManifestIdentity(cacheRoot);
  const manifest = manifestIdentity?.manifest;
  const config = options?.config === undefined
    ? resolveCompileSeedExtractionConfig(process.env, manifest, options?.sourcePacking)
    : { ...options.config, sourcePacking: resolveExtractionSourcePacking(
        process.env, manifest, options.sourcePacking, options.config.sourcePacking
      ) };
  const credentialled = config.apiKey !== null;
  const cacheOnly = manifest !== undefined && !credentialled;
  const extractionCachePreflightProof = runExtractionCachePreflight(
    options, cacheRoot, config, credentialled, manifestIdentity
  );
  const rawShardInspector = createRunnerRawShardInspector();
  const stats = createCompileSeedStats(
    credentialled || cacheOnly,
    rawShardInspector.diagnostics
  );
  const diagnosticDir = resolveCompileSeedDiagnosticDir(options);
  ensureDiagnosticDir(diagnosticDir);
  const semanticSupplement = options?.sourceAssertionSupplement === undefined
    ? null
    : createSourceAssertionSupplementRuntime({
        ...options.sourceAssertionSupplement,
        primaryCacheRoot: cacheRoot,
        config,
        rawShardInspector
      });
  return {
    config,
    stats,
    diagnosticDir,
    semanticSupplement,
    ...(extractionCachePreflightProof === undefined ? {} : {
      extractionCachePreflightProof
    }),
    provider: createOfficialApiProvider({
      options,
      config,
      cacheRoot,
      stats,
      credentialled,
      cacheOnly,
      diagnosticDir,
      rawShardInspector
    })
  };
}

function assertSelectedCacheRootExists(cacheRoot: string): void {
  try {
    if (!statSync(cacheRoot).isDirectory()) {
      throw new AlayaError("VALIDATION", `selected extraction cache root is not a directory: ${cacheRoot}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AlayaError("UNAVAILABLE", `selected extraction cache root does not exist: ${cacheRoot}`);
    }
    throw error;
  }
}

function runExtractionCachePreflight(
  options: CompileSeedRunnerOptions | undefined,
  cacheRoot: string,
  config: ReturnType<typeof resolveCompileSeedExtractionConfig>,
  credentialled: boolean,
  manifestIdentity: ReturnType<typeof readExtractionCacheManifestIdentity> | undefined
): ExtractionCachePreflightProof | undefined {
  if (options?.skipPreflight === true) return undefined;
  const manifest = manifestIdentity?.manifest;
  if (options?.extractionCachePreflightProof !== undefined) {
    if (manifestIdentity === undefined || options.requiredTurnContents === undefined ||
        options.requiredQuestionWindow === undefined) {
      throw new Error("extraction cache preflight proof requires a bound manifest window");
    }
    assertExtractionCachePreflightProofReuse(options.extractionCachePreflightProof, {
      cacheRoot,
      manifestIdentity,
      config,
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
      requiredTurnContents: options.requiredTurnContents,
      requiredQuestionWindow: options.requiredQuestionWindow,
      ...(options.requiredExtractionTurns === undefined ? {} : {
        requiredExtractionTurns: options.requiredExtractionTurns
      })
    });
    return options.extractionCachePreflightProof;
  }
  const minimumCoverage = resolveBenchExtractionCacheMinCoverage();
  preflightExtractionCache({
    cacheRoot,
    config,
    systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
    liveExtractionPossible: credentialled,
    requireManifest: resolveBenchRequireExtractionCacheManifest(),
    ...(minimumCoverage === undefined ? {} : { minimumCoverage }),
    ...(options?.requiredTurnContents === undefined
      ? {}
      : { requiredTurnContents: options.requiredTurnContents }),
    ...(options?.requiredExtractionTurns === undefined
      ? {}
      : { requiredExtractionTurns: options.requiredExtractionTurns }),
    ...(options?.requiredQuestionWindow === undefined
      ? {}
      : { requiredQuestionWindow: options.requiredQuestionWindow }),
    ...(manifest === undefined ? {} : { manifest })
  });
  return undefined;
}

function createCompileSeedStats(
  usesOfficialCompile: boolean,
  rawShardInspection: RawShardInspectionDiagnostics
): CompileSeedExtractionStats {
  return {
    path: usesOfficialCompile ? "official_api_compile" : "no_credentials_fallback",
    rawShardInspection,
    extractionAttempts: 0,
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
    lastExtractionShards: [],
    lastSemanticSupplementShards: [],
    lastCacheKey: null,
    lastRawJsonSha256: null
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
  readonly cacheOnly: boolean;
  readonly diagnosticDir: string | null;
  readonly rawShardInspector: RunnerRawShardInspector;
}): OfficialApiGardenProvider | null {
  if (!input.credentialled && !input.cacheOnly) return null;
  const extractor = createCachingSignalExtractor({
    delegate:
      input.options?.extractorFactory?.(input.config) ??
      createGardenHttpExtractor(input.config),
    config: input.config,
    cacheRoot: input.cacheRoot,
    stats: input.stats,
    trackTurnShards: true,
    rawShardInspector: input.rawShardInspector,
    allowLiveExtraction: false
  });
  return new OfficialApiGardenProvider({
    sourcePacking: input.config.sourcePacking,
    apiKey: input.config.apiKey,
    model: input.config.model,
    ...(input.config.providerUrl === ""
      ? {}
      : { endpoint: input.config.providerUrl }),
    extractor,
    ...(input.cacheOnly
      ? { injectedExtractorCapability: "cache_only" as const }
      : {}),
    requestTimeoutMs: EXTRACTION_REQUEST_TIMEOUT_MS,
    diagnosticDir: input.diagnosticDir
  });
}
