import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import {
  parseOfficialApiSignals,
  salvageRawSignalElements
} from "@do-soul/alaya-soul";
import { EXTRACTION_CACHE_ROOT } from "./compile-seed-config.js";
import type {
  BenchSignalExtractor,
  CompileSeedExtractionStats
} from "./compile-seed-types.js";

interface CachedExtraction {
  readonly model: string;
  readonly cache_key: string;
  readonly raw_json: string;
  readonly extracted_at: string;
}

/**
 * Build an on-disk-cached `SignalExtractor`.
 *
 * It wraps a delegate extractor (the live LLM transport) and caches the raw
 * LLM response keyed by a SHA-256 hash of the load-bearing extraction
 * inputs (model + systemPrompt + turn_content) — never the volatile routing
 * context (run_id / workspace_id / surface_id) the userPrompt also carries.
 * On a cache hit it returns the stored `rawJson` with zero LLM calls; on a
 * miss it calls the delegate and writes the fixture. This is what makes the
 * bench repeatable / zero-LLM on re-runs.
 *
 * `OfficialApiGardenProvider` then parses that `rawJson` with the production
 * `parseOfficialApiSignals` — so caching never alters extraction semantics.
 */
export function createCachingSignalExtractor(options: {
  readonly delegate: BenchSignalExtractor;
  readonly model: string;
  readonly cacheRoot?: string;
  readonly stats?: CompileSeedExtractionStats;
}): BenchSignalExtractor {
  const cacheRoot = options.cacheRoot ?? EXTRACTION_CACHE_ROOT;
  const stats = options.stats;
  return {
    async extract(input) {
      const cacheKey = computeCacheKey(
        options.model,
        input.systemPrompt,
        extractTurnContent(input.userPrompt)
      );
      const cached = readCachedExtraction(cacheRoot, cacheKey, options.model);
      if (cached !== undefined) {
        if (stats !== undefined) {
          stats.lastExtractionSource = "cache";
          // Full cache key recorded here; the diagnostic writer slices to
          // the 12-char prefix so logs stay scannable without leaking
          // enough hash to fingerprint a private fixture path.
          stats.lastCacheKey = cacheKey;
          stats.cacheHits += 1;
          recordExtractionDraftCounts(stats, cached);
        }
        return { rawJson: cached };
      }
      if (stats !== undefined) {
        stats.lastExtractionSource = "live";
        stats.lastCacheKey = cacheKey;
      }
      const result = await options.delegate.extract(input);
      writeCachedExtraction(cacheRoot, cacheKey, {
        model: options.model,
        cache_key: cacheKey,
        raw_json: result.rawJson,
        extracted_at: new Date().toISOString()
      });
      if (stats !== undefined) {
        stats.llmCalls += 1;
        recordExtractionDraftCounts(stats, result.rawJson);
      }
      return result;
    }
  };
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
  systemPrompt: string,
  turnContent: string
): string {
  return createHash("sha256")
    .update(model, "utf8")
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

function readCachedExtraction(
  cacheRoot: string,
  cacheKey: string,
  model: string
): string | undefined {
  const filePath = cacheFilePath(cacheRoot, cacheKey);
  if (!existsSync(filePath)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as CachedExtraction;
    if (typeof parsed.raw_json !== "string") {
      return undefined;
    }
    // Defence in depth: the cache key already hashes the model, so a model
    // mismatch should be impossible — but a hand-edited / cross-pollinated
    // shard would silently feed a wrong-model extraction into the bench.
    // Treat a mismatch as a miss rather than trusting the stale fixture.
    if (typeof parsed.model === "string" && parsed.model !== model) {
      return undefined;
    }
    return parsed.raw_json;
  } catch {
    return undefined;
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
  writeFileSync(tmpPath, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
  renameSync(tmpPath, filePath);
}
