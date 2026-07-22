import { createHash } from "node:crypto";
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
import { computeTrustedRoleCorpusDigest } from "../extraction/turn-contents.js";
import type { LongMemEvalExtractionTurn } from "../extraction/turn-contents.js";

interface CachingSignalExtractorOptions {
  readonly delegate: BenchSignalExtractor;
  readonly config: Pick<
    CompileSeedExtractionConfig,
    "model" | "modelFamily" | "providerUrl" | "requestProfile"
  >;
  readonly cacheRoot?: string;
  readonly stats?: CompileSeedExtractionStats;
  readonly allowLiveExtraction?: boolean;
  readonly writeLease?: ExtractionCacheWriteLease;
  /** Called before each actual provider HTTP attempt for an uncached shard. */
  readonly onTransportAttempt?: (cacheKey: string, signal?: AbortSignal) => void | Promise<void>;
  /** Called only after an atomic raw shard write succeeds. */
  readonly onLiveExtractionSucceeded?: (cacheKey: string) => void;
  /** Releases a reserved shard slot after its live delegate fails. */
  readonly onLiveExtractionFailed?: (cacheKey: string) => void;
  /** Records the exact provider-reported usage, or an explicit unavailable outcome. */
  readonly onLiveExtractionOutcome?: (
    cacheKey: string,
    outcome: ExtractionLiveTransportOutcome
  ) => void;
  /** Advances a no-progress watchdog after a cache hit or durable write. */
  readonly onExtractionProgress?: () => void;
}

/**
 * Build an on-disk-cached `SignalExtractor`.
 *
 * It wraps a delegate extractor (the live LLM transport) and caches the raw
 * LLM response keyed by a SHA-256 hash of the load-bearing extraction
 * inputs (model + requestProfile + systemPrompt + turn_content) — never the volatile routing
 * context (run_id / workspace_id / surface_id) the userPrompt also carries.
 * On a cache hit it returns the stored `rawJson` with zero LLM calls; on a
 * miss it calls the delegate and writes the fixture only when live extraction
 * is allowed. Cache-only callers fail closed before the delegate boundary.
 *
 * `OfficialApiGardenProvider` then parses that `rawJson` with the production
 * `parseOfficialApiSignals` — so caching never alters extraction semantics.
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
    extractionInput.turnContent,
    extractionInput.trustedRoleCorpusDigest
  );
  if (options.stats !== undefined) {
    options.stats.lastExtractionSource = null;
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
    recordCacheHit(options.stats, cacheKey, cached);
    options.onExtractionProgress?.();
    return cachedExtractionResult(cached);
  }
  if (options.allowLiveExtraction === false) {
    throw new Error(
      `[longmemeval cache-only] extraction fixture ${cached.status}: ` +
      `${cacheKey}; live extraction disabled${cached.reason === undefined ? "" : ` (${cached.reason})`}`
    );
  }
  return extractLive(options, cacheRoot, cacheKey, input);
}

function recordCacheHit(
  stats: CompileSeedExtractionStats | undefined,
  cacheKey: string,
  cached: ExtractionRawJsonInspection & { readonly rawJson: string }
): void {
  if (stats === undefined) return;
  stats.lastExtractionSource = "cache";
  stats.lastCacheKey = cacheKey;
  stats.cacheHits += 1;
  recordExtractionInspection(stats, cached);
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
    recordCacheHit(options.stats, cacheKey, recached);
    options.onExtractionProgress?.();
    return cachedExtractionResult(recached);
  }
  const manifestSha = assertWriteIdentity(options, cacheRoot, input.systemPrompt);
  const stats = options.stats;
  markLiveExtractionStarted(stats, cacheKey);
  let providerAttemptAuthorized = options.onTransportAttempt === undefined;
  const result = await extractLiveDelegate({
    delegate: options.delegate,
    request: withAuthorityAttemptHook(input, options, cacheKey, () => {
      providerAttemptAuthorized = true;
    }),
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
  const inspection = persistLiveExtraction(options, cacheRoot, cacheKey, result);
  recordLiveExtractionSuccess(options, cacheKey, stats, inspection);
  return result;
}

function markLiveExtractionStarted(
  stats: CompileSeedExtractionStats | undefined,
  cacheKey: string
): void {
  if (stats === undefined) return;
  stats.lastExtractionSource = "live";
  stats.lastCacheKey = cacheKey;
}

function persistLiveExtraction(
  options: CachingSignalExtractorOptions,
  cacheRoot: string,
  cacheKey: string,
  result: Awaited<ReturnType<BenchSignalExtractor["extract"]>>
): ExtractionRawJsonInspection {
  const inspection = inspectExtractionRawJson(result.rawJson);
  try {
    writeCachedExtraction(cacheRoot, cacheKey, {
      model: options.config.model,
      request_profile: options.config.requestProfile,
      cache_key: cacheKey,
      raw_json: result.rawJson,
      extracted_at: new Date().toISOString(),
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
    recordExtractionInspection(stats, inspection);
  }
  options.onLiveExtractionSucceeded?.(cacheKey);
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

/**
 * Pull the load-bearing `turn_content` out of the assembled provider
 * userPrompt. The provider builds userPrompt as
 * `JSON.stringify({workspace_id, run_id, surface_id, turn_content, ...})`
 * (see compute-provider.ts requestSignals); only `turn_content` decides the
 * extraction. Falls back to the whole userPrompt if the shape is
 * unexpected, never silently keying on a constant.
 */
function extractCacheInputIdentity(userPrompt: string): {
  readonly turnContent: string;
  readonly trustedRoleCorpusDigest?: string;
} {
  try {
    const parsed = JSON.parse(userPrompt) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      const turnContent = record.turn_content;
      if (typeof turnContent === "string" && turnContent.length > 0) {
        const messages = readRoleCorpus(record.turn_messages);
        return {
          turnContent,
          ...(messages === undefined
            ? {}
            : { trustedRoleCorpusDigest: computeTrustedRoleCorpusDigest(messages) })
        };
      }
    }
  } catch {
    // Not JSON: fall through to hashing the raw userPrompt.
  }
  return { turnContent: userPrompt };
}

function readRoleCorpus(
  value: unknown
): readonly { readonly role: string; readonly content: string }[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const messages: { role: string; content: string }[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return undefined;
    const { role, content } = item as Record<string, unknown>;
    if (typeof role !== "string" || typeof content !== "string") return undefined;
    messages.push({ role, content });
  }
  return messages;
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
  stats: CompileSeedExtractionStats,
  inspection: ExtractionRawJsonInspection
): void {
  stats.lastRawJsonSha256 = inspection.rawJsonSha256;
  stats.lastTurnRawSignalCount = inspection.rawSignalCount;
  stats.lastTurnDraftCount = inspection.parsedDraftCount;
}

export function computeCacheKey(
  model: string,
  requestProfile: CompileSeedExtractionConfig["requestProfile"],
  systemPrompt: string,
  turnContent: string,
  trustedRoleCorpusDigest?: string
): string {
  const hash = createHash("sha256")
    .update(model, "utf8")
    .update("\u0000", "utf8")
    .update(requestProfile, "utf8")
    .update("\u0000", "utf8")
    .update(systemPrompt, "utf8")
    .update("\u0000", "utf8")
    .update(turnContent, "utf8");
  if (trustedRoleCorpusDigest !== undefined) {
    if (!/^[a-f0-9]{64}$/u.test(trustedRoleCorpusDigest)) {
      throw new Error("trusted role corpus digest must be a lowercase sha256");
    }
    hash.update("\u0000trusted-role-corpus-v1\u0000", "utf8")
      .update(trustedRoleCorpusDigest, "utf8");
  }
  return hash.digest("hex");
}

export function computeExtractionTurnCacheKey(
  model: string,
  requestProfile: CompileSeedExtractionConfig["requestProfile"],
  systemPrompt: string,
  turn: LongMemEvalExtractionTurn
): string {
  return computeCacheKey(
    model,
    requestProfile,
    systemPrompt,
    turn.turnContent,
    computeTrustedRoleCorpusDigest(turn.turnMessages)
  );
}
