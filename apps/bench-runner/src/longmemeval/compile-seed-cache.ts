import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import {
  parseOfficialApiSignals,
  salvageRawSignalElements
} from "@do-soul/alaya-soul";
import { EXTRACTION_CACHE_ROOT } from "./compile-seed-config.js";
import { assertExtractionCacheIdentity } from "./extraction/cache-identity.js";
import { ExtractionCacheInvariantError } from "./extraction/cache-invariant-error.js";
import {
  acquireExtractionCacheWriteLease,
  withExtractionCacheWriteLease,
  type ExtractionCacheWriteLease
} from "./extraction/fill-root-guard.js";
import { readExtractionCacheManifestIdentity } from "./extraction-cache-manifest.js";
import type {
  BenchRetryClassification,
  BenchSignalExtractor,
  CompileSeedExtractionConfig,
  CompileSeedExtractionStats,
  BenchTerminalRetryClassification
} from "./compile-seed-types.js";

interface CachedExtraction {
  readonly model: string;
  readonly request_profile: CompileSeedExtractionConfig["requestProfile"];
  readonly cache_key: string;
  readonly raw_json: string;
  readonly extracted_at: string;
}

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
  const cacheKey = computeCacheKey(
    options.config.model,
    options.config.requestProfile,
    input.systemPrompt,
    extractTurnContent(input.userPrompt)
  );
  const cached = inspectCachedExtraction(
    cacheRoot,
    cacheKey,
    options.config.model,
    options.config.requestProfile
  );
  if (cached.status === "hit") {
    recordCacheHit(options.stats, cacheKey, cached.rawJson);
    return { rawJson: cached.rawJson };
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
  rawJson: string
): void {
  if (stats === undefined) return;
  stats.lastExtractionSource = "cache";
  stats.lastCacheKey = cacheKey;
  stats.cacheHits += 1;
  recordExtractionDraftCounts(stats, rawJson);
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
    recordCacheHit(options.stats, cacheKey, recached.rawJson);
    return { rawJson: recached.rawJson };
  }
  const manifestSha = assertWriteIdentity(options, cacheRoot, input.systemPrompt);
  const stats = options.stats;
  if (stats !== undefined) {
    stats.lastExtractionSource = "live";
    stats.lastCacheKey = cacheKey;
  }
  const result = await extractLiveDelegate(options.delegate, input, stats);
  lease.assertOwned();
  assertWriteIdentity(options, cacheRoot, input.systemPrompt, manifestSha);
  parseOfficialApiSignals(result.rawJson);
  try {
    writeCachedExtraction(cacheRoot, cacheKey, {
      model: options.config.model,
      request_profile: options.config.requestProfile,
      cache_key: cacheKey,
      raw_json: result.rawJson,
      extracted_at: new Date().toISOString()
    });
  } catch (cause) {
    throw new ExtractionCacheInvariantError(
      `failed to persist extraction cache shard ${cacheKey}`,
      { cause }
    );
  }
  if (stats !== undefined) {
    stats.llmCalls += 1;
    recordExtractionDraftCounts(stats, result.rawJson);
  }
  return result;
}

async function extractLiveDelegate(
  delegate: BenchSignalExtractor,
  input: Parameters<BenchSignalExtractor["extract"]>[0],
  stats: CompileSeedExtractionStats | undefined
): ReturnType<BenchSignalExtractor["extract"]> {
  try {
    const result = await delegate.extract(input);
    recordRetrySuccess(stats, result.extractorMeta);
    return result;
  } catch (cause) {
    recordRetryFailure(stats, cause);
    throw cause;
  }
}

function recordRetrySuccess(
  stats: CompileSeedExtractionStats | undefined,
  meta: Awaited<ReturnType<BenchSignalExtractor["extract"]>>["extractorMeta"]
): void {
  if (stats === undefined || meta === undefined) return;
  stats.rateLimitRetries = (stats.rateLimitRetries ?? 0) + meta.rateLimitRetries;
  if (meta.retryClassification === "success_after_retry") {
    stats.retrySuccesses = (stats.retrySuccesses ?? 0) + 1;
  }
}

function recordRetryFailure(
  stats: CompileSeedExtractionStats | undefined,
  cause: unknown
): void {
  if (stats === undefined || typeof cause !== "object" || cause === null) return;
  const meta = (cause as { readonly benchRetry?: unknown }).benchRetry;
  if (!isBenchRetryFailure(meta)) return;
  stats.rateLimitRetries = (stats.rateLimitRetries ?? 0) + meta.rateLimitRetries;
  const totals = stats.terminalRetryClassifications ?? {};
  totals[meta.retryClassification] = (totals[meta.retryClassification] ?? 0) + 1;
  stats.terminalRetryClassifications = totals;
}

function isBenchRetryFailure(value: unknown): value is {
  readonly rateLimitRetries: number;
  readonly retryClassification: BenchTerminalRetryClassification;
} {
  if (typeof value !== "object" || value === null) return false;
  const input = value as { rateLimitRetries?: unknown; retryClassification?: unknown };
  return typeof input.rateLimitRetries === "number" &&
    isTerminalRetryClassification(input.retryClassification);
}

function isTerminalRetryClassification(
  value: unknown
): value is BenchTerminalRetryClassification {
  const classification = value as BenchRetryClassification;
  return classification === "failure_max_retries" ||
    classification === "failure_non_retryable_4xx" ||
    classification === "failure_timeout" || classification === "failure_aborted";
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
function extractTurnContent(userPrompt: string): string {
  try {
    const parsed = JSON.parse(userPrompt) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const turnContent = (parsed as Record<string, unknown>).turn_content;
      if (typeof turnContent === "string" && turnContent.length > 0) {
        return turnContent;
      }
    }
  } catch {
    // Not JSON: fall through to hashing the raw userPrompt.
  }
  return userPrompt;
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
function recordExtractionDraftCounts(
  stats: CompileSeedExtractionStats,
  rawJson: string
): void {
  stats.lastTurnRawSignalCount = countRawEnvelopeSignals(rawJson);
  stats.lastTurnDraftCount = countParsedDrafts(rawJson);
}

/**
 * Count the entries in the model envelope's raw `.signals` array, with no
 * cap and no per-entry validation. When the whole envelope parses cleanly,
 * this is the array length. When the envelope is corrupt (parseOfficialApiSignals
 * now salvages it element-wise), count the RAW salvageable `{...}` element
 * population — including the corrupt element(s) — so the dropped corrupt
 * entries land in parseDropped (raw - parsed) instead of vanishing from the
 * attribution. A genuinely-degenerate envelope (no `.signals` region, or no
 * complete element) counts as 0, matching the whole-turn fallback the seed
 * path still applies when zero drafts survive.
 * see also: packages/soul/src/garden/compute-provider.ts salvageRawSignalElements
 */
function countRawEnvelopeSignals(rawJson: string): number {
  try {
    const parsed = JSON.parse(rawJson) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return 0;
    }
    const signals = (parsed as { readonly signals?: unknown }).signals;
    return Array.isArray(signals) ? signals.length : 0;
  } catch {
    return salvageRawSignalElements(rawJson).length;
  }
}

/**
 * Count the candidate-signal drafts the production parser recovers from a
 * raw extraction response, AFTER its malformed-entry drop and 64-cap.
 */
function countParsedDrafts(rawJson: string): number {
  try {
    return parseOfficialApiSignals(rawJson).length;
  } catch {
    return 0;
  }
}

export function computeCacheKey(
  model: string,
  requestProfile: CompileSeedExtractionConfig["requestProfile"],
  systemPrompt: string,
  turnContent: string
): string {
  return createHash("sha256")
    .update(model, "utf8")
    .update("\u0000", "utf8")
    .update(requestProfile, "utf8")
    .update("\u0000", "utf8")
    .update(systemPrompt, "utf8")
    .update("\u0000", "utf8")
    .update(turnContent, "utf8")
    .digest("hex");
}

export function cacheFilePath(cacheRoot: string, cacheKey: string): string {
  // Shard by the first two hex chars so a 500-question haystack does not
  // dump tens of thousands of files into one directory.
  return join(cacheRoot, cacheKey.slice(0, 2), `${cacheKey}.json`);
}

export type CachedExtractionInspection =
  | { readonly status: "hit"; readonly rawJson: string }
  | { readonly status: "missing"; readonly reason?: undefined }
  | { readonly status: "invalid"; readonly reason: string };

export function inspectCachedExtraction(
  cacheRoot: string,
  cacheKey: string,
  model: string,
  requestProfile: CompileSeedExtractionConfig["requestProfile"]
): CachedExtractionInspection {
  const filePath = cacheFilePath(cacheRoot, cacheKey);
  if (!existsSync(filePath)) {
    return { status: "missing" };
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<CachedExtraction>;
    if (typeof parsed.raw_json !== "string") {
      return { status: "invalid", reason: "raw_json must be a string" };
    }
    if (parsed.model !== model) {
      return { status: "invalid", reason: `model ${String(parsed.model)} != ${model}` };
    }
    if (parsed.request_profile !== requestProfile) {
      return {
        status: "invalid",
        reason: `request_profile ${String(parsed.request_profile)} != ${requestProfile}`
      };
    }
    if (parsed.cache_key !== cacheKey) {
      return { status: "invalid", reason: "cache_key does not match fixture path" };
    }
    parseOfficialApiSignals(parsed.raw_json);
    return { status: "hit", rawJson: parsed.raw_json };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: "invalid", reason: `invalid cached extraction: ${reason}` };
  }
}

function writeCachedExtraction(
  cacheRoot: string,
  cacheKey: string,
  entry: CachedExtraction
): void {
  const filePath = cacheFilePath(cacheRoot, cacheKey);
  mkdirSync(dirname(filePath), { recursive: true });
  // invariant: atomic write. WSL2 OOM is a known crash mode in this bench
  // env; a bare writeFileSync interrupted mid-write leaves a torn shard that
  // silently degrades that turn to the fallback path forever. Write to a
  // unique temp file, then rename onto the final path — rename is atomic on
  // the same filesystem, so a reader sees either the old file or the whole
  // new one, never a partial.
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmpPath, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
    renameSync(tmpPath, filePath);
  } catch (cause) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // Cleanup must not conceal the authoritative persistence failure.
    }
    throw cause;
  }
}
