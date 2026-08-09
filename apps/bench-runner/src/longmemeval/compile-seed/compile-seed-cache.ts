import {
  parseOfficialApiExtractionRequest,
  stringifyOfficialApiExtractionRequest,
  type OfficialApiExtractionRequest
} from "@do-soul/alaya-soul";
import { EXTRACTION_CACHE_ROOT } from "./compile-seed-config.js";
import { assertExtractionCacheIdentity } from "../extraction/cache/cache-identity.js";
import { ExtractionCacheInvariantError } from "../extraction/cache/cache-invariant-error.js";
import {
  inspectExtractionRawJson,
  type ExtractionRawJsonInspection
} from "../extraction/content-closure.js";
import {
  acquireExtractionCacheWriteLease,
  withExtractionCacheWriteLease,
  type ExtractionCacheWriteLease
} from "../extraction/fill/manifest/fill-root-guard.js";
import { readExtractionCacheManifestIdentity } from "../extraction/cache/extraction-cache-manifest.js";
import {
  extractLiveDelegate,
  type ExtractionLiveTransportOutcome
} from "../extraction/cache/cache-live-delegate.js";
import {
  cachedExtractionResult,
  persistedResponseMetadata
} from "./cache/cached-response-metadata.js";
import {
  inspectCachedExtraction,
  writeCachedExtraction
} from "./cache/cache-shard.js";
export {
  cacheFilePath,
  inspectCachedExtraction,
  type CachedExtractionInspection
} from "./cache/cache-shard.js";
export {
  computeExtractionContentClosureSha256,
  computeExtractionKeySetSha256,
  computeExtractionRawJsonSha256,
  inspectExtractionRawJson,
  type ExtractionContentClosureEntry,
  type ExtractionRawJsonInspection
} from "../extraction/content-closure.js";
import type {
  BenchSignalExtractor,
  CompileSeedExtractionConfig,
  CompileSeedExtractionStats
} from "./compile-seed-types.js";
import { computeCacheKey } from "./cache/cache-key.js";
import { buildExtractionTransportProvenance } from
  "../extraction/transport-route.js";
export {
  computeCacheKey,
  computeExtractionTurnCacheKey,
  computeExtractionTurnCacheKeys,
  computeSourceTurnCacheKey,
  computeSourceTurnCacheKeys
} from "./cache/cache-key.js";

interface CachingSignalExtractorOptions {
  readonly delegate: BenchSignalExtractor;
  readonly config: Pick<
    CompileSeedExtractionConfig,
    "model" | "modelFamily" | "providerUrl" | "requestProfile" |
      "transportModel" | "transportProviderUrl"
  >;
  readonly cacheRoot?: string;
  readonly stats?: CompileSeedExtractionStats;
  readonly allowLiveExtraction?: boolean;
  readonly writeLease?: ExtractionCacheWriteLease;
  /** Aggregate exact shards for the single-threaded snapshot seed loop. */
  readonly trackTurnShards?: boolean;
  /** Called before each actual provider HTTP attempt for an uncached shard. */
  readonly onTransportAttempt?: (cacheKey: string, signal?: AbortSignal) => void | Promise<void>;
  /** Called only after a reserved provider-backed shard is atomically written. */
  readonly onLiveProviderExtractionSucceeded?: (cacheKey: string) => void;
  /** Records an atomically written canonical empty shard without a provider attempt. */
  readonly onDeterministicExtractionSucceeded?: (cacheKey: string) => void;
  /** Releases a reserved shard slot after its live delegate fails. */
  readonly onLiveExtractionFailed?: (cacheKey: string) => void;
  /** Records the exact provider-reported usage, or an explicit unavailable outcome. */
  readonly onLiveExtractionOutcome?: (
    cacheKey: string,
    outcome: ExtractionLiveTransportOutcome
  ) => void;
  /** Advances a no-progress watchdog after a cache hit or durable write. */
  readonly onExtractionProgress?: () => void;
  /** Completed siblings stay opaque because fill only needs missing raw shards. */
  readonly executionCacheKeys?: ReadonlySet<string>;
}

/**
 * Build an on-disk-cached `SignalExtractor`.
 *
 * It wraps a live delegate and keys raw responses by model, request profile,
 * system prompt, and the canonical compact extraction request.
 * A hit returns stored `rawJson` without LLM calls; a cache-only miss fails
 * closed before the delegate boundary.
 *
 * `OfficialApiGardenProvider` parses `rawJson` with production semantics.
 */
export function createCachingSignalExtractor(
  options: CachingSignalExtractorOptions
): BenchSignalExtractor {
  const cacheRoot = options.cacheRoot ?? EXTRACTION_CACHE_ROOT;
  return {
    extract: (input) => extractWithCache(options, cacheRoot, input)
  };
}

async function extractWithCache(
  options: CachingSignalExtractorOptions,
  cacheRoot: string,
  input: Parameters<BenchSignalExtractor["extract"]>[0]
): ReturnType<BenchSignalExtractor["extract"]> {
  const extractionInput = extractCacheInputIdentity(input.userPrompt);
  const cacheKey = computeCacheKey(
    options.config.model,
    options.config.requestProfile,
    input.systemPrompt,
    extractionInput.canonical
  );
  if (options.executionCacheKeys !== undefined &&
      !options.executionCacheKeys.has(cacheKey)) {
    return { rawJson: '{"signals":[]}' };
  }
  if (options.stats !== undefined) {
    options.stats.extractionAttempts = (options.stats.extractionAttempts ?? 0) + 1;
    options.stats.lastCacheKey = cacheKey;
    options.stats.lastRawJsonSha256 = null;
  }
  const cached = inspectCachedExtraction(
    cacheRoot,
    cacheKey,
    options.config.model,
    options.config.requestProfile
  );
  if (cached.status === "hit") {
    recordCacheHit(options, cacheKey, cached);
    options.onExtractionProgress?.();
    return cachedExtractionResult(cached);
  }
  if (options.allowLiveExtraction === false) {
    throw new Error(
      `[longmemeval cache-only] extraction fixture ${cached.status}: ` +
      `${cacheKey}; live extraction disabled${cached.reason === undefined ? "" : ` (${cached.reason})`}`
    );
  }
  if (extractionInput.request.source_assertions.length === 0) {
    return persistDeterministicEmpty(options, cacheRoot, cacheKey, input);
  }
  return extractLive(options, cacheRoot, cacheKey, input);
}

async function persistDeterministicEmpty(
  options: CachingSignalExtractorOptions,
  cacheRoot: string,
  cacheKey: string,
  input: Parameters<BenchSignalExtractor["extract"]>[0]
): ReturnType<BenchSignalExtractor["extract"]> {
  const ownedLease = options.writeLease;
  const lease = ownedLease ?? acquireExtractionCacheWriteLease(cacheRoot);
  const write = async (): ReturnType<BenchSignalExtractor["extract"]> => {
    lease.assertOwned();
    const recached = inspectCachedExtraction(
      cacheRoot,
      cacheKey,
      options.config.model,
      options.config.requestProfile
    );
    if (recached.status === "hit") {
      recordCacheHit(options, cacheKey, recached);
      options.onExtractionProgress?.();
      return cachedExtractionResult(recached);
    }
    const manifestSha = assertWriteIdentity(options, cacheRoot, input.systemPrompt);
    const result = { rawJson: '{"signals":[]}' };
    const inspection = persistExtraction(options, cacheRoot, cacheKey, result, false);
    assertWriteIdentity(options, cacheRoot, input.systemPrompt, manifestSha);
    options.onDeterministicExtractionSucceeded?.(cacheKey);
    if (options.stats !== undefined) {
      options.stats.lastExtractionSource = "cache";
      options.stats.lastCacheKey = cacheKey;
      options.stats.cacheHits += 1;
      recordExtractionInspection(options, cacheKey, "cache", inspection);
    }
    options.onExtractionProgress?.();
    return result;
  };
  if (ownedLease !== undefined) return write();
  return withExtractionCacheWriteLease(lease, write);
}

function recordCacheHit(
  options: CachingSignalExtractorOptions,
  cacheKey: string,
  cached: ExtractionRawJsonInspection & { readonly rawJson: string }
): void {
  const stats = options.stats;
  if (stats === undefined) return;
  stats.lastCacheKey = cacheKey;
  stats.cacheHits += 1;
  recordExtractionInspection(options, cacheKey, "cache", cached);
}

async function extractLive(
  options: CachingSignalExtractorOptions,
  cacheRoot: string,
  cacheKey: string,
  input: Parameters<BenchSignalExtractor["extract"]>[0]
): ReturnType<BenchSignalExtractor["extract"]> {
  const ownedLease = options.writeLease;
  if (ownedLease !== undefined && ownedLease.cacheRoot !== cacheRoot) {
    throw new ExtractionCacheInvariantError(
      "extraction cache writer lease belongs to a different cache root"
    );
  }
  if (ownedLease !== undefined) {
    return extractLiveWithLease(options, cacheRoot, cacheKey, input, ownedLease);
  }
  const lease = acquireExtractionCacheWriteLease(cacheRoot);
  return withExtractionCacheWriteLease(
    lease,
    () => extractLiveWithLease(options, cacheRoot, cacheKey, input, lease)
  );
}

async function extractLiveWithLease(
  options: CachingSignalExtractorOptions,
  cacheRoot: string,
  cacheKey: string,
  input: Parameters<BenchSignalExtractor["extract"]>[0],
  lease: ExtractionCacheWriteLease
): ReturnType<BenchSignalExtractor["extract"]> {
  lease.assertOwned();
  const recached = inspectCachedExtraction(
    cacheRoot,
    cacheKey,
    options.config.model,
    options.config.requestProfile
  );
  if (recached.status === "hit") {
    recordCacheHit(options, cacheKey, recached);
    options.onExtractionProgress?.();
    return cachedExtractionResult(recached);
  }
  const manifestSha = assertWriteIdentity(options, cacheRoot, input.systemPrompt);
  const stats = options.stats;
  markLiveExtractionStarted(stats, cacheKey);
  let providerAttemptAuthorized = options.onTransportAttempt === undefined;
  const result = await extractLiveDelegate({
    delegate: options.delegate,
    request: withSemanticValidation(
      withAuthorityAttemptHook(input, options, cacheKey, () => {
        providerAttemptAuthorized = true;
      })
    ),
    stats,
    onFailure: () => options.onLiveExtractionFailed?.(cacheKey),
    onOutcome: (outcome) => {
      if (!providerAttemptAuthorized) return;
      providerAttemptAuthorized = options.onTransportAttempt === undefined;
      options.onLiveExtractionOutcome?.(cacheKey, outcome);
    }
  });
  lease.assertOwned();
  assertWriteIdentity(options, cacheRoot, input.systemPrompt, manifestSha);
  const inspection = persistExtraction(options, cacheRoot, cacheKey, result, true);
  recordLiveExtractionSuccess(options, cacheKey, stats, inspection);
  return result;
}

function withSemanticValidation(
  input: Parameters<BenchSignalExtractor["extract"]>[0]
): Parameters<BenchSignalExtractor["extract"]>[0] {
  return {
    ...input,
    validateRawJson: (rawJson) => {
      inspectExtractionRawJson(rawJson);
      input.validateRawJson?.(rawJson);
    }
  };
}

function markLiveExtractionStarted(
  stats: CompileSeedExtractionStats | undefined,
  cacheKey: string
): void {
  if (stats === undefined) return;
  stats.lastExtractionSource = "live";
  stats.lastCacheKey = cacheKey;
}

function persistExtraction(
  options: CachingSignalExtractorOptions,
  cacheRoot: string,
  cacheKey: string,
  result: Awaited<ReturnType<BenchSignalExtractor["extract"]>>,
  providerBacked: boolean
): ExtractionRawJsonInspection {
  const inspection = inspectExtractionRawJson(result.rawJson);
  try {
    writeCachedExtraction(cacheRoot, cacheKey, {
      model: options.config.model,
      request_profile: options.config.requestProfile,
      cache_key: cacheKey,
      raw_json: result.rawJson,
      extracted_at: new Date().toISOString(),
      ...(providerBacked ? {
        transport_provenance: buildExtractionTransportProvenance(options.config)
      } : {}),
      ...persistedResponseMetadata(result.responseMetadata, result.usage)
    });
  } catch (cause) {
    throw new ExtractionCacheInvariantError(
      `failed to persist extraction cache shard ${cacheKey}`,
      { cause }
    );
  }
  return inspection;
}

function recordLiveExtractionSuccess(
  options: CachingSignalExtractorOptions,
  cacheKey: string,
  stats: CompileSeedExtractionStats | undefined,
  inspection: ExtractionRawJsonInspection
): void {
  if (stats !== undefined) {
    stats.llmCalls += 1;
    recordExtractionInspection(options, cacheKey, "live", inspection);
  }
  options.onLiveProviderExtractionSucceeded?.(cacheKey);
  options.onExtractionProgress?.();
}

function withAuthorityAttemptHook(
  input: Parameters<BenchSignalExtractor["extract"]>[0],
  options: CachingSignalExtractorOptions,
  cacheKey: string,
  markProviderAttemptAuthorized: () => void
): Parameters<BenchSignalExtractor["extract"]>[0] {
  if (options.onTransportAttempt === undefined) return input;
  return {
    ...input,
    onTransportAttempt: async (signal) => {
      await options.onTransportAttempt?.(cacheKey, signal);
      markProviderAttemptAuthorized();
      await input.onTransportAttempt?.(signal);
    }
  };
}

function assertWriteIdentity(
  options: CachingSignalExtractorOptions,
  cacheRoot: string,
  systemPrompt: string,
  expectedManifestSha?: string
): string {
  let identity: ReturnType<typeof readExtractionCacheManifestIdentity>;
  try {
    identity = readExtractionCacheManifestIdentity(cacheRoot);
  } catch (cause) {
    throw new ExtractionCacheInvariantError(
      "extraction cache manifest became unreadable during live extraction",
      { cause }
    );
  }
  if (identity === undefined) {
    throw new ExtractionCacheInvariantError(
      "live extraction cache writes require manifest.json; run extraction-fill " +
        "to initialize provider/model identity before writing shards"
    );
  }
  if (expectedManifestSha !== undefined && identity.manifestSha256 !== expectedManifestSha) {
    throw new ExtractionCacheInvariantError(
      "extraction cache manifest changed during live extraction"
    );
  }
  assertExtractionCacheIdentity({
    config: options.config,
    systemPrompt,
    manifest: identity.manifest,
    validateProvider: true
  });
  return identity.manifestSha256;
}

function extractCacheInputIdentity(userPrompt: string): {
  readonly request: OfficialApiExtractionRequest;
  readonly canonical: string;
} {
  try {
    const request = parseOfficialApiExtractionRequest(JSON.parse(userPrompt) as unknown);
    return { request, canonical: stringifyOfficialApiExtractionRequest(request) };
  } catch (cause) {
    throw new ExtractionCacheInvariantError(
      "cache extractor received a non-canonical official API extraction request",
      { cause }
    );
  }
}

/**
 * Record, into the run stats, the two draft counts for ONE extraction
 * response so the seed runner can attribute every dropped signal:
 *
 *   - lastTurnRawSignalCount — the RAW length of the model envelope's
 *     `.signals` array, read BEFORE parseOfficialApiSignals applies its
 *     entry-drop / MAX_OFFICIAL_API_SIGNALS=64 cap.
 *   - lastTurnDraftCount — the count parseOfficialApiSignals recovers,
 *     i.e. AFTER that cap and after malformed single entries are dropped.
 *
 * raw - parsed = signals lost inside the parser (parseDropped); parsed -
 * compile()-returned = signals lost inside compile() (compileOverflowDropped).
 * Counting only the parsed length here, as the old code did, made
 * signals_dropped blind to every malformed / over-cap entry the parser had
 * already silently discarded.
 */
function recordExtractionInspection(
  options: CachingSignalExtractorOptions,
  cacheKey: string,
  source: "cache" | "live",
  inspection: ExtractionRawJsonInspection
): void {
  const stats = options.stats;
  if (stats === undefined) return;
  const aggregate = options.trackTurnShards === true;
  stats.lastExtractionSource = aggregate && stats.lastExtractionSource === "live"
    ? "live"
    : source;
  stats.lastRawJsonSha256 = inspection.rawJsonSha256;
  stats.lastTurnRawSignalCount = aggregate
    ? stats.lastTurnRawSignalCount + inspection.rawSignalCount
    : inspection.rawSignalCount;
  stats.lastTurnDraftCount = aggregate
    ? stats.lastTurnDraftCount + inspection.parsedDraftCount
    : inspection.parsedDraftCount;
  if (aggregate) {
    stats.lastExtractionShards?.push(Object.freeze({
      extractionSource: source,
      cacheKey,
      rawJsonSha256: inspection.rawJsonSha256,
      rawSignalCount: inspection.rawSignalCount,
      draftCount: inspection.parsedDraftCount
    }));
  }
}
