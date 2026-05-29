import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Seed-extraction diagnostic instrument: default cwd-rooted dump dir,
// shared with packages/soul/src/garden/compute-provider.ts so a preflight can
// read provider-side and seed-side dumps from one place. data/* is gitignored.
const DEFAULT_COMPILE_SEED_DIAGNOSTIC_DIR_REL =
  "data/diagnostics/seed-extraction-failures";
const COMPILE_SEED_CACHE_KEY_PREFIX_CHARS = 12;
import { resolveSecretRef } from "@do-soul/alaya";
import {
  OFFICIAL_API_GARDEN_MODEL,
  OfficialApiGardenProvider,
  parseOfficialApiSignals,
  type GardenCompileContext
} from "@do-soul/alaya-soul";
import type {
  BenchSignalSeedInput,
  BenchSynthesisSeedInput,
  SeededMemoryResult,
  SeededSynthesisResult
} from "../harness/daemon.js";
import {
  canonicalizeSeedObjectKind,
  rotatingSeedObjectKind
} from "../harness/seed-rotation.js";

/**
 * @anchor longmemeval-compile-seed
 *
 * Field-standard ingestion for the LongMemEval bench seed path. Each
 * haystack turn is run through the PRODUCTION garden extraction —
 * `OfficialApiGardenProvider.compile()` — which LLM-extracts a list of typed
 * `CandidateMemorySignal`s, each carrying a resolved one-assertion
 * `distilled_fact` in its `raw_payload`. Every signal is then seeded as one
 * durable `memory_entry` through the bench daemon's emit→materialize→
 * propose→review chain. So the bench measures the memory system the product
 * actually builds, not a bench-private extractor.
 *
 * Extraction runs at seed/ingest time only — never at recall time.
 *
 * Repeatability: the LLM extraction is cached to an on-disk fixture keyed by
 * a hash of ONLY the load-bearing extraction inputs (model + systemPrompt +
 * turn_content). Volatile routing context — run_id / workspace_id /
 * surface_id — is deliberately excluded: crossquestion.ts stamps run_id with
 * a wall clock, so hashing the assembled userPrompt would make every run a
 * 100% cache miss and the committed fixture dead. The fixture directory is
 * EMPTY on a fresh checkout — it is not pre-populated. The first
 * credentialled bench run extracts via the garden LLM and writes the
 * fixture; that fixture must then be committed. Only after it is committed
 * does a later run (including CI and other contributors) reuse it with zero
 * LLM calls and become one-click repeatable. Until the fixture is committed,
 * a fresh checkout WITH credentials re-extracts live, and a fresh checkout
 * WITHOUT credentials takes the deterministic no-LLM single-fact fallback —
 * those two paths produce different ingestion granularity, and the bench
 * report discloses which path ran (see CompileSeedExtractionStats.path).
 *
 * see also: apps/bench-runner/src/harness/daemon.ts proposeMemoryFromSignal
 * see also: packages/soul/src/garden/compute-provider.ts —
 *   OfficialApiGardenProvider, OFFICIAL_API_SYSTEM_PROMPT
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

// The cache fixture lives beside the pinned dataset metadata under
// docs/bench-history/datasets so that, once a credentialled run has
// populated it, it can be committed and shared — the same repeatable-
// fixture discipline used by the pinned dataset meta. The directory is
// created lazily on the first credentialled run; it is empty (absent)
// until then.
const EXTRACTION_CACHE_ROOT = resolve(
  __dirname,
  "../../../../docs/bench-history/datasets/longmemeval-extraction-cache"
);

const GARDEN_SECRET_REF_ENV = "ALAYA_OFFICIAL_GARDEN_SECRET_REF";
const GARDEN_MODEL_ENV = "OFFICIAL_API_GARDEN_MODEL";
const GARDEN_PROVIDER_URL_ENV = "OFFICIAL_API_GARDEN_PROVIDER_URL";

const DEFAULT_GARDEN_PROVIDER_URL = "https://yunwu.ai/v1";
const EXTRACTION_REQUEST_TIMEOUT_MS = 60_000;
// invariant: wall-clock tick guards against host suspend freezing the monotonic
// setTimeout. setInterval also rides the monotonic clock, but libuv catches up
// suppressed intervals on resume, so the wall-clock check fires within one
// tick after wake.
// see also: packages/soul/src/garden/wall-clock-timeout.ts WALL_CLOCK_TICK_MS
const EXTRACTION_WALL_CLOCK_TICK_MS = 5_000;

/**
 * The injectable `SignalExtractor` shape consumed by
 * `OfficialApiGardenProvider`. Declared structurally here so the bench does
 * not depend on a non-exported soul type; it matches the provider's
 * `extractor` constructor dependency.
 *
 * extractorMeta surfaces the retry observability the bench dump consumes —
 * retryCount and retryClassification let dumpSeedExtractionFailureDiagnostic
 * attribute a fallback to a specific terminal outcome of the retry loop. The
 * field is optional so unit-test stubs that do not exercise retries stay
 * minimal.
 */
export interface BenchSignalExtractor {
  extract(input: {
    readonly systemPrompt: string;
    readonly userPrompt: string;
    readonly abortSignal?: AbortSignal;
    readonly timeoutMs?: number;
  }): Promise<{
    readonly rawJson: string;
    readonly extractorMeta?: BenchSignalExtractorMeta;
  }>;
}

// invariant: closed enum mirrored from
// packages/soul/src/garden/pi-mono-extractor.ts RetryClassification so the
// dump envelope is consistent across the production and bench transports.
export type BenchRetryClassification =
  | "success_first_try"
  | "success_after_retry"
  | "failure_max_retries"
  | "failure_non_retryable_4xx"
  | "failure_timeout"
  | "failure_aborted";

// invariant: BenchSignalExtractorMeta is structurally assignable to the
// production SignalExtractorMeta in pi-mono-extractor.ts so the bench's
// caching extractor can drop into OfficialApiGardenProvider.extractor without
// a widening cast. recoveryKind is always "none" on the bench HTTP path —
// JSON recovery happens inside parseOrRecoverJson, which only the pi-mono
// loop reaches; the bench transport returns whatever content the gateway
// emitted.
// cross-file: packages/soul/src/garden/pi-mono-extractor.ts SignalExtractorMeta
export interface BenchSignalExtractorMeta {
  readonly recoveryKind: "none" | "markdown_strip" | "trailing_strip" | "balanced_close";
  readonly retryCount: number;
  readonly retryClassification: BenchRetryClassification;
}

export interface CompileSeedExtractionConfig {
  /** OpenAI-compatible chat-completions base URL (…/v1). */
  readonly providerUrl: string;
  /** Chat model id. */
  readonly model: string;
  /** Resolved API key, or null when no garden credentials are configured. */
  readonly apiKey: string | null;
}

export interface CompileSeedExtractionStats {
  /** Which seed path ran. Disclosed in the bench report for honesty. */
  path: "official_api_compile" | "no_credentials_fallback";
  /** Turns whose extraction was served from the on-disk cache fixture. */
  cacheHits: number;
  /** Turns that triggered a live LLM extraction call. */
  llmCalls: number;
  /** Turns that fell back to the no-LLM single-fact path. */
  offlineFallbacks: number;
  /** Official extraction fallbacks caused by a live provider/cache-miss failure. */
  liveExtractionFailures: number;
  /** Official extraction fallbacks caused by a cached raw JSON failure. */
  cachedExtractionFailures: number;
  /** Total candidate signals seeded across all turns. */
  factsProduced: number;
  /**
   * Total signals lost between the model's raw envelope and a seeded
   * memory_entry — the sum of every drop stage, so a dropped answer-bearing
   * signal is a visible recall hole, not a silent miss-rate inflate. It is
   * the sum of `parseDropped` + `compileOverflowDropped` (defined below)
   * plus any signal that threw during the seed materialization.
   */
  signalsDropped: number;
  /**
   * Signals discarded INSIDE parseOfficialApiSignals — a malformed single
   * entry rejected by parseOfficialApiSignalEntry, OR a signal past the
   * MAX_OFFICIAL_API_SIGNALS=64 slice cap. These never reach compile().
   */
  parseDropped: number;
  /**
   * Signals dropped INSIDE compile() — a parsed draft whose assembled
   * raw_payload overflowed the protocol 16 KB cap.
   */
  compileOverflowDropped: number;
  /**
   * RAW count of the model envelope's `.signals` array, read BEFORE
   * parseOfficialApiSignals applies its entry-drop / 64-cap. Set by the
   * caching extractor on each extract() call (hit or miss). The seed runner
   * derives parseDropped = rawSignalCount - draftsParsed.
   * Single-threaded seed loop, so no cross-turn race.
   */
  lastTurnRawSignalCount: number;
  /**
   * Drafts parseOfficialApiSignals recovered from the MOST RECENT
   * extraction's raw JSON (post entry-drop / 64-cap). Set alongside
   * lastTurnRawSignalCount. The seed runner derives compileOverflowDropped
   * = draftsParsed - signals-compile()-returned.
   */
  lastTurnDraftCount: number;
  lastExtractionSource: "cache" | "live" | null;
  /**
   * Diagnostic instrument: cache key (or its 12-char prefix; see writers)
   * for the most recent extract() call, so a subsequent extraction failure
   * can dump the cache_key_prefix to the diagnostic envelope. Optional for
   * backward compatibility with stats objects constructed by tests that
   * predate the instrument.
   */
  lastCacheKey?: string | null;
}

/**
 * The persisted-report shape of the seed extraction stats. This is the
 * single mapping from the runner-internal `CompileSeedExtractionStats` to
 * `KpiCore.seed_extraction_path`; every LongMemEval runner surface
 * (single-turn / multiturn / crossquestion) threads it through this helper
 * so a no_credentials_fallback run is never indistinguishable from a real
 * official_api_compile run in the archive.
 */
export interface SeedExtractionPathKpi {
  readonly path: "official_api_compile" | "no_credentials_fallback";
  readonly cache_hits: number;
  readonly llm_calls: number;
  readonly offline_fallbacks: number;
  readonly live_extraction_failures: number;
  readonly cached_extraction_failures: number;
  readonly facts_produced: number;
  /** Total signals lost across all drop stages (parse + compile overflow). */
  readonly signals_dropped: number;
  /** Signals dropped by parseOfficialApiSignals (malformed entry / >64 cap). */
  readonly parse_dropped: number;
  /** Signals dropped by compile() (raw_payload past the 16 KB cap). */
  readonly compile_overflow_dropped: number;
}

export function toSeedExtractionPathKpi(
  stats: CompileSeedExtractionStats
): SeedExtractionPathKpi {
  return {
    path: stats.path,
    cache_hits: stats.cacheHits,
    llm_calls: stats.llmCalls,
    offline_fallbacks: stats.offlineFallbacks,
    live_extraction_failures: stats.liveExtractionFailures,
    cached_extraction_failures: stats.cachedExtractionFailures,
    facts_produced: stats.factsProduced,
    signals_dropped: stats.signalsDropped,
    parse_dropped: stats.parseDropped,
    compile_overflow_dropped: stats.compileOverflowDropped
  };
}

/**
 * Resolve garden LLM configuration from the process environment. When the
 * secret ref is absent or unresolvable, `apiKey` is null and the seed path
 * falls back to the deterministic no-LLM path.
 */
export function resolveCompileSeedExtractionConfig(
  env: NodeJS.ProcessEnv = process.env
): CompileSeedExtractionConfig {
  const providerUrl = normalizeBaseUrl(
    readNonEmpty(env[GARDEN_PROVIDER_URL_ENV]) ?? DEFAULT_GARDEN_PROVIDER_URL
  );
  const model = readNonEmpty(env[GARDEN_MODEL_ENV]) ?? OFFICIAL_API_GARDEN_MODEL;
  const secretRef = readNonEmpty(env[GARDEN_SECRET_REF_ENV]);
  if (secretRef === undefined) {
    return { providerUrl, model, apiKey: null };
  }
  const resolved = resolveSecretRef(secretRef);
  if ("value" in resolved) {
    return { providerUrl, model, apiKey: resolved.value };
  }
  return { providerUrl, model, apiKey: null };
}

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
 * cap and no per-entry validation. A malformed envelope (not an object, or
 * no `.signals` array) counts as 0 — parseOfficialApiSignals would throw on
 * it, which the seed path treats as a whole-turn extraction failure.
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
    return 0;
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

function computeCacheKey(
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

function cacheFilePath(cacheRoot: string, cacheKey: string): string {
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

// invariant: bench retry policy is parity with pi-mono-extractor.ts. Both
// transports must spend up to 3 retries with jittered exponential backoff on
// recoverable failure modes (5xx / 429 / empty body / unknown transport) so a
// transient yunwu.ai burst does not silently demote the archive to the
// no-credentials fallback path. Timeouts retry exactly once. 4xx-non-429 and
// aborts never retry.
const BENCH_HTTP_MAX_RETRIES = 3;
const BENCH_HTTP_MAX_TIMEOUT_RETRIES = 1;
const BENCH_HTTP_JITTER_BASE_MS = 250;
const BENCH_HTTP_JITTER_MAX_MS = 1500;

function computeBenchJitterMs(attempt: number, random: () => number): number {
  const baseMs = Math.min(
    BENCH_HTTP_JITTER_BASE_MS * Math.max(1, 2 ** Math.max(0, attempt)),
    BENCH_HTTP_JITTER_MAX_MS
  );
  const upper = Math.min(baseMs * 2, BENCH_HTTP_JITTER_MAX_MS);
  const span = upper - baseMs;
  return baseMs + Math.floor(random() * (span + 1));
}

interface BenchHttpError {
  readonly classification: BenchRetryClassification;
  readonly retryable: boolean;
  readonly isTimeout: boolean;
  readonly cause: unknown;
}

function classifyBenchHttpError(
  error: unknown,
  status: number | null
): BenchHttpError {
  if (error instanceof Error && /abort/iu.test(error.name + error.message)) {
    // AbortController fired — could be operator abort or our own timeout
    // controller; the caller disambiguates via the timer flag.
    return {
      classification: "failure_aborted",
      retryable: false,
      isTimeout: false,
      cause: error
    };
  }
  if (status !== null) {
    if (status === 429 || (status >= 500 && status < 600)) {
      return {
        classification: "failure_max_retries",
        retryable: true,
        isTimeout: false,
        cause: error
      };
    }
    if (status >= 400 && status < 500) {
      return {
        classification: "failure_non_retryable_4xx",
        retryable: false,
        isTimeout: false,
        cause: error
      };
    }
  }
  // Unknown transport (DNS, connection reset, empty body): retry — the
  // dominant unobserved failure here resolves on the next request.
  return {
    classification: "failure_max_retries",
    retryable: true,
    isTimeout: false,
    cause: error
  };
}

/**
 * Live garden LLM delegate: OpenAI-compatible POST /chat/completions with a
 * JSON-object response format, temperature 0. Wraps the raw fetch in the same
 * retry-with-jitter loop as `createPiMonoExtractor` (3 retries on recoverable
 * failures, 1 retry on timeout, no retry on 4xx-non-429 / abort) so the
 * bench transport does not silently degrade to the fallback path on a
 * transient burst the production transport would have recovered from.
 *
 * `extractorMeta.retryCount` + `extractorMeta.retryClassification` surface
 * on success; on failure the thrown Error carries the same classification
 * in its `.cause` chain so dumpSeedExtractionFailureDiagnostic records the
 * terminal outcome.
 *
 * `deps.sleep` / `deps.random` are test seams so unit tests can drive the
 * jittered backoff without wall-clock sleeps.
 */
export function createGardenHttpExtractor(
  config: CompileSeedExtractionConfig,
  deps?: {
    readonly sleep?: (ms: number) => Promise<void>;
    readonly random?: () => number;
    readonly fetch?: typeof fetch;
  }
): BenchSignalExtractor {
  const sleepImpl =
    deps?.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const randomImpl = deps?.random ?? Math.random;
  const fetchImpl = deps?.fetch ?? fetch;
  return {
    async extract(input) {
      if (config.apiKey === null) {
        throw new Error("garden API key is unavailable");
      }
      let attempt = 0;
      let timeoutRetries = 0;
      let lastError: unknown = null;
      let lastClassification: BenchRetryClassification = "failure_max_retries";
      while (attempt <= BENCH_HTTP_MAX_RETRIES) {
        const controller = new AbortController();
        let timedOut = false;
        const budgetMs = input.timeoutMs ?? EXTRACTION_REQUEST_TIMEOUT_MS;
        const startedAt = Date.now();
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, budgetMs);
        // invariant: wall-clock fallback. setTimeout is paused during host
        // suspend; setInterval catches up on resume and the elapsed check
        // detects budget overrun within one tick.
        const wallClockTimer = setInterval(() => {
          if (Date.now() - startedAt >= budgetMs) {
            timedOut = true;
            controller.abort();
          }
        }, EXTRACTION_WALL_CLOCK_TICK_MS);
        const onOperatorAbort = (): void => controller.abort();
        if (input.abortSignal !== undefined) {
          if (input.abortSignal.aborted) {
            controller.abort();
          } else {
            input.abortSignal.addEventListener("abort", onOperatorAbort);
          }
        }
        try {
          const response = await fetchImpl(`${config.providerUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${config.apiKey}`
            },
            body: JSON.stringify({
              model: config.model,
              temperature: 0,
              response_format: { type: "json_object" },
              messages: [
                { role: "system", content: input.systemPrompt },
                { role: "user", content: input.userPrompt }
              ]
            }),
            signal: controller.signal
          });
          if (!response.ok) {
            const err = new Error(
              `garden extraction HTTP ${response.status} ${response.statusText}`
            );
            (err as { status?: number }).status = response.status;
            throw err;
          }
          const payload = (await response.json()) as {
            readonly choices?: readonly {
              readonly message?: { readonly content?: unknown };
            }[];
          };
          const content = payload.choices?.[0]?.message?.content;
          if (typeof content !== "string" || content.trim().length === 0) {
            throw new Error("garden extraction returned no content");
          }
          return {
            rawJson: content,
            extractorMeta: {
              recoveryKind: "none",
              retryCount: attempt,
              retryClassification:
                attempt === 0 ? "success_first_try" : "success_after_retry"
            }
          };
        } catch (error) {
          lastError = error;
          const status = readStatusFromBenchError(error);
          // Operator abort: never retry.
          if (
            input.abortSignal?.aborted === true &&
            !timedOut
          ) {
            lastClassification = "failure_aborted";
            throw wrapBenchTransportError(error, lastClassification, attempt);
          }
          if (timedOut) {
            // Timer-driven abort = timeout. Bounded retry — at most once.
            lastClassification = "failure_timeout";
            if (timeoutRetries >= BENCH_HTTP_MAX_TIMEOUT_RETRIES) {
              throw wrapBenchTransportError(error, lastClassification, attempt);
            }
            timeoutRetries += 1;
            if (attempt >= BENCH_HTTP_MAX_RETRIES) {
              lastClassification = "failure_max_retries";
              throw wrapBenchTransportError(error, lastClassification, attempt);
            }
            const jitterMs = computeBenchJitterMs(attempt, randomImpl);
            attempt += 1;
            await sleepImpl(jitterMs);
            continue;
          }
          const classified = classifyBenchHttpError(error, status);
          if (!classified.retryable) {
            lastClassification = classified.classification;
            throw wrapBenchTransportError(error, lastClassification, attempt);
          }
          if (attempt >= BENCH_HTTP_MAX_RETRIES) {
            lastClassification = "failure_max_retries";
            throw wrapBenchTransportError(error, lastClassification, attempt);
          }
          const jitterMs = computeBenchJitterMs(attempt, randomImpl);
          attempt += 1;
          await sleepImpl(jitterMs);
        } finally {
          clearTimeout(timer);
          clearInterval(wallClockTimer);
          if (input.abortSignal !== undefined) {
            input.abortSignal.removeEventListener("abort", onOperatorAbort);
          }
        }
      }
      // Defensive — loop always returns or throws.
      throw wrapBenchTransportError(
        lastError,
        lastClassification,
        attempt
      );
    }
  };
}

// invariant: surface retry_classification + retry_count via the .cause chain
// so dumpSeedExtractionFailureDiagnostic can pluck them without re-deriving
// from the message. Tests assert on `.benchRetry` for the dump shape.
function wrapBenchTransportError(
  cause: unknown,
  classification: BenchRetryClassification,
  retryCount: number
): Error {
  const message =
    cause instanceof Error ? cause.message : `garden extraction failed: ${String(cause)}`;
  const wrapped = new Error(message);
  (wrapped as { cause?: unknown }).cause = cause;
  (wrapped as { benchRetry?: unknown }).benchRetry = {
    retryCount,
    retryClassification: classification
  };
  return wrapped;
}

function readStatusFromBenchError(error: unknown): number | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const status = (error as { readonly status?: unknown }).status;
  if (typeof status === "number" && Number.isFinite(status)) {
    return status;
  }
  if (error instanceof Error) {
    const match = /\bHTTP\s+(\d{3})\b/u.exec(error.message);
    if (match !== null) {
      const parsed = Number.parseInt(match[1]!, 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

/** Minimal daemon surface the compile seed path needs — test-stubbable. */
export interface CompileSeedDaemon {
  /**
   * Seeds the production-extracted signals of ONE round through the daemon's
   * in-process signalService.receiveSignal — the same seam production
   * POST_TURN_EXTRACT completion uses — so they materialize with
   * source = garden_compile. Used for the credentialled compile path.
   */
  proposeMemoriesFromCompileSignals(
    inputs: readonly BenchSignalSeedInput[]
  ): Promise<readonly SeededMemoryResult[]>;
  /**
   * Seeds one signal through soul.emit_candidate_signal (source =
   * model_tool). Used ONLY for the no-credentials / extraction-failure
   * fallback, where a full-turn fact genuinely is an agent-style proposal.
   */
  proposeMemoryFromSignal(input: BenchSignalSeedInput): Promise<SeededMemoryResult>;
  /**
   * Emits one session-level potential_synthesis signal so the L2
   * synthesis_capsule layer is exercised on the bench seed path.
   */
  proposeSynthesis(input: BenchSynthesisSeedInput): Promise<SeededSynthesisResult>;
}

/**
 * The compile-based seed runner: holds one provider + caching extractor for
 * a whole bench run so the on-disk fixture and stats accumulate.
 */
export interface CompileSeedRunner {
  readonly stats: CompileSeedExtractionStats;
  /**
   * Seed one haystack turn. Runs the turn through production garden
   * extraction (or the no-credentials fallback), then seeds each resulting
   * candidate signal as a durable memory_entry. Returns every
   * SeededMemoryResult so the caller maps ALL N object_ids back to the
   * source answer turn — a partial map silently undercounts recall.
   */
  seedTurn(input: {
    readonly daemon: CompileSeedDaemon;
    readonly turnContent: string;
    readonly evidenceRefBase: string;
    readonly seedIndex: number;
    readonly workspaceId: string;
    readonly runId: string;
    readonly surfaceId?: string | null;
    // see also: apps/bench-runner/src/harness/daemon.ts BenchSignalSeedInput.sourceMemoryRefs
    readonly sourceMemoryRefs?: readonly string[];
  }): Promise<CompileSeedResult>;
}

export interface CompileSeedResult {
  /** One SeededMemoryResult per extracted candidate signal (N per turn). */
  readonly seeds: readonly SeededMemoryResult[];
  /**
   * Whether THIS turn's source content exceeded the seed content cap.
   * Truncation is a property of the turn, not of each extracted fact:
   * every fact of one turn carries the same full turnContent as evidence,
   * so it is counted once per turn, not per fact fan-out.
   */
  readonly turnTruncated: boolean;
  /** Chars clipped from this turn's content (counted once, not per fact). */
  readonly charsClipped: number;
}

/**
 * Build the compile-based seed runner for a whole bench run.
 *
 * When garden credentials are configured, it constructs the production
 * `OfficialApiGardenProvider` with a caching `SignalExtractor` injected, so
 * every turn goes through real production extraction + the production
 * `OFFICIAL_API_SYSTEM_PROMPT`. When no credentials are configured, it takes
 * the degraded no-LLM fallback (the full turn becomes one candidate fact);
 * `stats.path` records which path ran so the bench report can disclose it.
 *
 * `options.extractorFactory` overrides the live LLM delegate for tests.
 */
export function createCompileSeedRunner(options?: {
  readonly config?: CompileSeedExtractionConfig;
  readonly cacheRoot?: string;
  readonly extractorFactory?: (
    config: CompileSeedExtractionConfig
  ) => BenchSignalExtractor;
  /**
   * Override the directory the seed-side diagnostic dump writes failure
   * envelopes to. Defaults to
   * `<cwd>/data/diagnostics/seed-extraction-failures/`. Pass `null` to
   * disable dumps entirely (read-only fs, unit tests that want zero side
   * effects).
   */
  readonly diagnosticDir?: string | null;
}): CompileSeedRunner {
  const config = options?.config ?? resolveCompileSeedExtractionConfig();
  const credentialled = config.apiKey !== null;
  const stats: CompileSeedExtractionStats = {
    path: credentialled ? "official_api_compile" : "no_credentials_fallback",
    cacheHits: 0,
    llmCalls: 0,
    offlineFallbacks: 0,
    liveExtractionFailures: 0,
    cachedExtractionFailures: 0,
    factsProduced: 0,
    signalsDropped: 0,
    parseDropped: 0,
    compileOverflowDropped: 0,
    lastTurnRawSignalCount: 0,
    lastTurnDraftCount: 0,
    lastExtractionSource: null,
    lastCacheKey: null
  };
  // Per-runner diagnostic dump dir; null disables dumps. Resolution order:
  //   1. explicit options.diagnosticDir (null => off, string => use as-is)
  //   2. ALAYA_SEED_EXTRACTION_DIAG_DIR env (operator override at run time)
  //   3. cwd-rooted DEFAULT_COMPILE_SEED_DIAGNOSTIC_DIR_REL (default on)
  // Co-resolved at runner construction (not lazily) so a later cwd change
  // does not retarget mid-run.
  const envDiagDir = normalizeEnvDiagDir(
    process.env.ALAYA_SEED_EXTRACTION_DIAG_DIR
  );
  const diagnosticDir: string | null =
    options?.diagnosticDir === null
      ? null
      : options?.diagnosticDir !== undefined
        ? resolve(options.diagnosticDir)
        : envDiagDir !== null
          ? resolve(envDiagDir)
          : resolve(process.cwd(), DEFAULT_COMPILE_SEED_DIAGNOSTIC_DIR_REL);
  // Pre-create the dump dir at runner construction (not first failure) so a
  // bench run that triggers many concurrent failures does not race on mkdir.
  // Best-effort — never block the bench start on fs failure.
  if (diagnosticDir !== null) {
    try {
      mkdirSync(diagnosticDir, { recursive: true });
    } catch {
      // Dump path is read-only or the operator's filesystem rejected it;
      // dumpSeedExtractionFailureDiagnostic logs the per-failure error.
    }
  }

  const provider =
    credentialled === false
      ? null
      : new OfficialApiGardenProvider({
          apiKey: config.apiKey,
          model: config.model,
          ...(config.providerUrl === ""
            ? {}
            : { endpoint: config.providerUrl }),
          extractor: createCachingSignalExtractor({
            delegate:
              options?.extractorFactory?.(config) ??
              createGardenHttpExtractor(config),
            model: config.model,
            ...(options?.cacheRoot === undefined
              ? {}
              : { cacheRoot: options.cacheRoot }),
            stats
          }),
          requestTimeoutMs: EXTRACTION_REQUEST_TIMEOUT_MS,
          // invariant: provider-side and seed-side dumps must land in the same
          // dir so a single readdir surfaces every signal of a failure.
          // ALAYA_SEED_EXTRACTION_DIAG_DIR / explicit options.diagnosticDir
          // applies to both layers; explicit null disables the provider
          // dump too.
          diagnosticDir
        });

  async function seedTurn(input: {
    readonly daemon: CompileSeedDaemon;
    readonly turnContent: string;
    readonly evidenceRefBase: string;
    readonly seedIndex: number;
    readonly workspaceId: string;
    readonly runId: string;
    readonly surfaceId?: string | null;
    readonly sourceMemoryRefs?: readonly string[];
  }): Promise<CompileSeedResult> {
    const normalized = input.turnContent.trim();
    if (normalized.length === 0) {
      return { seeds: [], turnTruncated: false, charsClipped: 0 };
    }

    const seedInputs = await extractSeedInputs({
      provider,
      stats,
      turnContent: normalized,
      seedIndex: input.seedIndex,
      context: {
        workspace_id: input.workspaceId,
        run_id: input.runId,
        surface_id: input.surfaceId ?? null,
        turn_messages: []
      },
      diagnosticDir,
      modelId: config.model,
      // Bench seed always drives the official-API provider (or the no-creds
      // fallback, which doesn't reach recordExtractionFailureSource). Recorded
      // explicitly so the dump envelope shape is stable when a future
      // host_worker / custom_api seed path lands.
      providerKind: "official_api"
    });

    // invariant: every fact gets a distinct evidence_ref so the audit trail
    // and the per-fact materialized object_id stay 1:1. sourceMemoryRefs
    // (when supplied by the caller) is replicated onto every fact of the
    // turn so each derived memory_entry carries the same derives_from edge
    // back to the prior turn's seeds.
    // see also: apps/bench-runner/src/harness/daemon.ts BenchSignalSeedInput.sourceMemoryRefs
    const signalInputs: BenchSignalSeedInput[] = seedInputs.map(
      (seedInput, i) => ({
        ...seedInput,
        evidenceRef:
          seedInputs.length === 1
            ? input.evidenceRefBase
            : `${input.evidenceRefBase}-f${i}`,
        ...(input.sourceMemoryRefs === undefined || input.sourceMemoryRefs.length === 0
          ? {}
          : { sourceMemoryRefs: input.sourceMemoryRefs })
      })
    );

    let seeds: readonly SeededMemoryResult[];
    // extractSeedInputs returns a homogeneous list per round — every signal
    // is either official_api_compile (credentialled extraction) or
    // no_credentials_fallback (degraded path). The compile path seeds through
    // the daemon's in-process signalService.receiveSignal — the exact seam
    // production POST_TURN_EXTRACT completion uses — so the seeded signals
    // carry source = garden_compile, faithful to production; the fallback
    // path uses soul.emit_candidate_signal, whose source = model_tool is the
    // honest label for an agent-style full-round proposal.
    if (signalInputs[0]?.extractionProvider === "official_api_compile") {
      // A signal the MaterializationRouter routed to evidence_only / deferred
      // (no memory_entry — e.g. a sub-0.5-confidence signal) is skipped
      // per-signal by proposeMemoriesFromCompileSignals, so the round's other
      // healthy facts still seed; that signal surfaces here as a shortfall
      // between requested inputs and returned seeds. A harder failure (a
      // schema-parse error) still throws and aborts the round batch.
      try {
        seeds = await input.daemon.proposeMemoriesFromCompileSignals(signalInputs);
        const evidenceOnlySkipped = signalInputs.length - seeds.length;
        if (evidenceOnlySkipped > 0) {
          stats.signalsDropped += evidenceOnlySkipped;
          process.stderr.write(
            `[longmemeval compile-seed] ${evidenceOnlySkipped} signal(s) of ` +
              `${signalInputs.length} did not materialize a memory_entry ` +
              `(routed to evidence_only / deferred); the round's other facts ` +
              `seeded normally\n`
          );
        }
      } catch (error) {
        stats.signalsDropped += signalInputs.length;
        process.stderr.write(
          `[longmemeval compile-seed] dropped ${signalInputs.length} signal(s) during compile seed: ${stringifyError(error)}\n`
        );
        return { seeds: [], turnTruncated: false, charsClipped: 0 };
      }
    } else {
      // Degraded fallback: one full-turn fact through the emit path. Per-
      // signal try/catch so a single bad fact does not abort the question.
      const fallbackSeeds: SeededMemoryResult[] = [];
      for (const signalInput of signalInputs) {
        try {
          fallbackSeeds.push(
            await input.daemon.proposeMemoryFromSignal(signalInput)
          );
        } catch (error) {
          stats.signalsDropped += 1;
          process.stderr.write(
            `[longmemeval compile-seed] dropped one signal during seed: ${stringifyError(error)}\n`
          );
        }
      }
      seeds = fallbackSeeds;
    }

    let turnTruncated = false;
    let charsClipped = 0;
    for (const seed of seeds) {
      // Truncation is keyed on the turn's source content, the same string
      // for every fact of this turn — record once, not summed across the
      // fact fan-out.
      if (seed.truncated) {
        turnTruncated = true;
        charsClipped = seed.charsClipped;
      }
    }
    return { seeds, turnTruncated, charsClipped };
  }

  return { stats, seedTurn };
}

type SeedInputDraft = Omit<BenchSignalSeedInput, "evidenceRef">;

async function extractSeedInputs(input: {
  readonly provider: OfficialApiGardenProvider | null;
  readonly stats: CompileSeedExtractionStats;
  readonly turnContent: string;
  readonly seedIndex: number;
  readonly context: GardenCompileContext;
  // Absolute path or null when diagnostic dumps are disabled.
  readonly diagnosticDir?: string | null;
  readonly modelId?: string;
  readonly providerKind?: string;
}): Promise<readonly SeedInputDraft[]> {
  // invariant: no garden credentials => deterministic no-LLM fallback. The
  // full turn becomes one candidate fact. This is honest (no fabricated
  // split), repeatable, and strictly better than the rule distiller's
  // first-2-sentences truncation. It is the DEGRADED path — the production
  // multi-fact extraction activates only with credentials. object_kind
  // rotates so the fallback still exercises both materialization-router
  // branches the credentialled path's varied object_kinds would.
  if (input.provider === null) {
    input.stats.offlineFallbacks += 1;
    input.stats.factsProduced += 1;
    return [
      {
        signalKind: "potential_preference",
        objectKind: rotatingSeedObjectKind(input.seedIndex),
        confidence: 0.9,
        distilledFact: input.turnContent,
        turnContent: input.turnContent,
        turnSeedIndex: input.seedIndex,
        extractionProvider: "no_credentials_fallback"
      }
    ];
  }

  let signals: Awaited<ReturnType<OfficialApiGardenProvider["compile"]>>;
  try {
    signals = await input.provider.compile(input.turnContent, input.context);
  } catch (error) {
    // A single failed extraction must not abort a 500-question bench. Fall
    // back to the full turn so the answer text stays seeded; count it as an
    // offline fallback so the bench report shows the live-extraction hole.
    input.stats.offlineFallbacks += 1;
    recordExtractionFailureSource(input.stats);
    // Dump cache_key_prefix / model / provider / failure source so a
    // bench preflight can attribute the failure to a specific cache
    // shard or live call without re-running.
    await dumpSeedExtractionFailureDiagnostic({
      diagnosticDir: input.diagnosticDir ?? null,
      stats: input.stats,
      modelId: input.modelId ?? null,
      providerKind: input.providerKind ?? null,
      error,
      context: input.context
    });
    input.stats.factsProduced += 1;
    process.stderr.write(
      `[longmemeval compile-seed] extraction failed, using full-turn fallback: ${stringifyError(error)}\n`
    );
    return [
      {
        signalKind: "potential_preference",
        objectKind: rotatingSeedObjectKind(input.seedIndex),
        confidence: 0.9,
        distilledFact: input.turnContent,
        turnContent: input.turnContent,
        turnSeedIndex: input.seedIndex,
        extractionProvider: "no_credentials_fallback"
      }
    ];
  }

  // Signals are lost at two stages, and the bench must count BOTH or
  // signals_dropped understates the recall hole:
  //   1. parse-drop — parseOfficialApiSignals silently discards malformed
  //      single entries and anything past MAX_OFFICIAL_API_SIGNALS=64,
  //      BEFORE compile() ever iterates. The caching extractor recorded the
  //      raw envelope `.signals` length and the post-parse draft count; the
  //      difference is the parse-drop.
  //   2. compile-overflow-drop — compile() drops a parsed draft whose
  //      assembled raw_payload overflows the protocol 16 KB cap, with only a
  //      console.warn, and returns the survivors.
  // The old code counted only stage 2 (draftsParsed - returned), so a
  // malformed / over-cap answer-bearing signal vanished without a trace.
  const turnParseDropped = Math.max(
    0,
    input.stats.lastTurnRawSignalCount - input.stats.lastTurnDraftCount
  );
  const turnCompileOverflowDropped = Math.max(
    0,
    input.stats.lastTurnDraftCount - signals.length
  );
  input.stats.parseDropped += turnParseDropped;
  input.stats.compileOverflowDropped += turnCompileOverflowDropped;
  input.stats.signalsDropped += turnParseDropped + turnCompileOverflowDropped;

  const drafts: SeedInputDraft[] = [];
  for (const signal of signals) {
    // buildDistilledFact materializes raw_payload.distilled_fact into
    // memory_entry.content. A signal whose extractor omitted distilled_fact
    // would otherwise hit the rule distiller; for the bench seed we fall the
    // distilled fact back to matched_text (a real span of the turn) so every
    // seeded memory_entry carries production-shaped content.
    const distilled =
      readRawString(signal.raw_payload, "distilled_fact") ??
      readRawString(signal.raw_payload, "matched_text");
    if (distilled === null) {
      continue;
    }
    const matchedText = readRawString(signal.raw_payload, "matched_text");
    // invariant: the production compile() LLM emits a free-form object_kind
    // (travel_itinerary / podcast / health_advice / …). MaterializationRouter
    // routeByObjectKind only mints a memory_entry for its enumerated
    // dimension table; any other kind on a high-confidence
    // potential_claim / potential_preference signal routes to evidence_only
    // — an evidence_capsule with NO memory_entry — so the seeded turn fact
    // never lands in the recall store. Canonicalize the kind onto a
    // memory_entry-producing route; preserve the LLM's choice in
    // raw_payload.extracted_object_kind for audit fidelity.
    // see also: apps/bench-runner/src/harness/seed-rotation.ts
    //   canonicalizeSeedObjectKind
    // see also: packages/soul/src/garden/materialization-router.ts
    //   routeByObjectKind
    const seedObjectKind = canonicalizeSeedObjectKind(signal.object_kind);
    drafts.push({
      signalKind: signal.signal_kind,
      objectKind: seedObjectKind,
      confidence: signal.confidence,
      distilledFact: distilled,
      turnContent: input.turnContent,
      turnSeedIndex: input.seedIndex,
      ...(matchedText === null ? {} : { matchedText }),
      // Forward the production signal's content-bearing raw_payload so the
      // bench evidence_capsule is built from the same matched_text span
      // production materializes. The compile()-attached schema-grounding
      // block (schema_grounding / detected_object / field_candidates /
      // validation_result) is stripped here: it pins detected_object.
      // object_kind to the ORIGINAL extracted kind, which — once the kind is
      // canonicalized above — would mismatch signal.object_kind and trip
      // signal-service.ts hasInvalidSchemaGrounding (→ deferred, no
      // memory_entry). completeGardenTask re-runs normalizeSchemaGroundedSignal,
      // which rebuilds a consistent schema-grounding block from the
      // canonicalized object_kind + the matched_text retained below.
      productionRawPayload: stripSchemaGrounding(signal.raw_payload, signal.object_kind),
      extractionProvider: "official_api_compile"
    });
  }

  // A turn the production extractor judged to carry no durable candidates
  // (empty signals array) is seeded with the full turn as one fact so the
  // answer text always survives ingest and recall can still find it.
  if (drafts.length === 0) {
    input.stats.factsProduced += 1;
    return [
      {
        signalKind: "potential_preference",
        objectKind: rotatingSeedObjectKind(input.seedIndex),
        confidence: 0.9,
        distilledFact: input.turnContent,
        turnContent: input.turnContent,
        turnSeedIndex: input.seedIndex,
        extractionProvider: "official_api_compile"
      }
    ];
  }

  input.stats.factsProduced += drafts.length;
  return drafts;
}

function recordExtractionFailureSource(stats: CompileSeedExtractionStats): void {
  if (stats.lastExtractionSource === "cache") {
    stats.cachedExtractionFailures += 1;
    return;
  }
  if (stats.lastExtractionSource === "live") {
    stats.liveExtractionFailures += 1;
  }
}

// invariant: shape mirror of the `benchRetry` field createGardenHttpExtractor
// attaches via wrapBenchTransportError. A SignalExtractorError surfaces the
// same fields via direct properties (retryCount / retryClassification); we
// read whichever is present so a future transport switch keeps the dump
// shape stable.
interface BenchRetrySnapshot {
  readonly retryCount: number;
  readonly retryClassification: BenchRetryClassification;
}

function readBenchRetryFromError(error: unknown): BenchRetrySnapshot | null {
  // invariant: depth-limited walk over the .cause chain so a
  // GardenProviderError wrapping the bench HTTP transport error (cause-chain
  // depth 1) still surfaces retry meta to the dump envelope. Two shapes are
  // accepted at each link: `.benchRetry` (the createGardenHttpExtractor
  // wrapBenchTransportError convention) and direct `.retryCount` /
  // `.retryClassification` properties (the SignalExtractorError shape from
  // pi-mono-extractor.ts).
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current === null || current === undefined) return null;
    if (typeof current !== "object") return null;
    const benchRetry = (current as { benchRetry?: unknown }).benchRetry;
    if (typeof benchRetry === "object" && benchRetry !== null) {
      const retryCount = (benchRetry as { retryCount?: unknown }).retryCount;
      const classification = (benchRetry as { retryClassification?: unknown })
        .retryClassification;
      if (
        typeof retryCount === "number" &&
        Number.isFinite(retryCount) &&
        typeof classification === "string"
      ) {
        return {
          retryCount,
          retryClassification: classification as BenchRetryClassification
        };
      }
    }
    const retryCount = (current as { retryCount?: unknown }).retryCount;
    const classification = (current as { retryClassification?: unknown })
      .retryClassification;
    if (
      typeof retryCount === "number" &&
      Number.isFinite(retryCount) &&
      typeof classification === "string"
    ) {
      return {
        retryCount,
        retryClassification: classification as BenchRetryClassification
      };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Dump one seed-side extraction failure diagnostic to
 * `<diagnosticDir>/compile-seed-<ISO-ts>-<uuid>.json`. Captures the cache
 * key prefix, model id, provider kind, last-extraction-source classification,
 * and the immediate failure message so a bench preflight can attribute
 * the failure to a specific cache shard or live extraction call without
 * re-running the bench. Observation only — failures inside the dump are
 * caught and surfaced as a single warn so the seed loop continues.
 *
 * Co-located with the provider-side dump in
 * packages/soul/src/garden/compute-provider.ts:dumpInvalidResponseDiagnostic
 * so a single readdir + JSON pass surfaces every signal of the failure.
 */
async function dumpSeedExtractionFailureDiagnostic(input: {
  readonly diagnosticDir: string | null;
  readonly stats: CompileSeedExtractionStats;
  readonly modelId: string | null;
  readonly providerKind: string | null;
  readonly error: unknown;
  readonly context: GardenCompileContext;
}): Promise<void> {
  if (input.diagnosticDir === null) {
    return;
  }
  try {
    const timestamp = new Date().toISOString();
    const cacheKey = input.stats.lastCacheKey ?? null;
    const benchRetry = readBenchRetryFromError(input.error);
    const envelope = {
      captured_at: timestamp,
      surface: "compile-seed",
      provider_kind: input.providerKind,
      model_id: input.modelId,
      workspace_id: input.context.workspace_id,
      run_id: input.context.run_id,
      surface_id: input.context.surface_id,
      cache_key_prefix:
        cacheKey === null
          ? null
          : cacheKey.slice(0, COMPILE_SEED_CACHE_KEY_PREFIX_CHARS),
      last_extraction_source: input.stats.lastExtractionSource,
      // Counters AFTER this turn's recordExtractionFailureSource update so a
      // dump file is self-describing: which classification bucket this
      // failure landed in (live vs cached) is unambiguous.
      live_extraction_failures: input.stats.liveExtractionFailures,
      cached_extraction_failures: input.stats.cachedExtractionFailures,
      // invariant: retry observability is parity with the provider-side dump
      // (compute-provider.ts dumpInvalidResponseDiagnostic). retry_count and
      // retry_classification let a dump consumer attribute the fallback to
      // the terminal outcome of the retry loop (failure_max_retries vs
      // failure_non_retryable_4xx vs failure_timeout) so a single readdir
      // surfaces whether the bench is hitting a chronic 4xx or a transient
      // burst that needs a higher retry budget. "unknown" only when the
      // thrown error did not flow through createGardenHttpExtractor's
      // wrapBenchTransportError (e.g. a non-HTTP path in a future
      // transport).
      retry_count: benchRetry?.retryCount ?? null,
      retry_classification: benchRetry?.retryClassification ?? "unknown",
      error_message: stringifyError(input.error)
    };
    const fileName = `compile-seed-${timestamp.replace(/[:.]/gu, "-")}-${randomUUID()}.json`;
    const filePath = join(input.diagnosticDir, fileName);
    mkdirSync(dirname(filePath), { recursive: true });
    // Atomic write: tmp + rename guards against an interrupted dump leaving
    // a torn file (WSL2 OOM is a known crash mode on the bench host).
    const tmpPath = `${filePath}.${randomUUID()}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
    renameSync(tmpPath, filePath);
  } catch (dumpError) {
    process.stderr.write(
      `[longmemeval compile-seed] diagnostic dump failed: ${stringifyError(dumpError)}\n`
    );
  }
}

/**
 * Strip the compile()-attached schema-grounding block from a raw_payload so
 * the bench seed signal can be re-grounded against a canonicalized
 * object_kind. The four schema-grounding keys
 * (`schema_grounding` / `detected_object` / `field_candidates` /
 * `validation_result`) pin `detected_object.object_kind` to the ORIGINAL
 * LLM-extracted kind. Once the bench canonicalizes the routing object_kind
 * (canonicalizeSeedObjectKind), keeping that stale block makes
 * signal-service.ts `hasInvalidSchemaGrounding` see
 * `detected_object.object_kind !== signal.object_kind` and defer the signal
 * (no memory_entry). Dropping the block lets completeGardenTask's
 * `normalizeSchemaGroundedSignal` rebuild a consistent block from the
 * canonicalized kind plus the retained `matched_text`.
 *
 * The original kind is preserved under `extracted_object_kind` for audit
 * fidelity so the bench archive still records what the LLM actually chose.
 */
function stripSchemaGrounding(
  rawPayload: Readonly<Record<string, unknown>>,
  extractedObjectKind: string
): Readonly<Record<string, unknown>> {
  const {
    schema_grounding: _schemaGrounding,
    detected_object: _detectedObject,
    field_candidates: _fieldCandidates,
    validation_result: _validationResult,
    ...contentBearing
  } = rawPayload;
  return {
    ...contentBearing,
    extracted_object_kind: extractedObjectKind
  };
}

function readRawString(
  rawPayload: Readonly<Record<string, unknown>>,
  key: string
): string | null {
  const value = rawPayload[key];
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/u, "");
  return trimmed.endsWith("/chat/completions")
    ? trimmed.slice(0, -"/chat/completions".length)
    : trimmed;
}

function readNonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// invariant: normalize ALAYA_SEED_EXTRACTION_DIAG_DIR. Empty strings and
// whitespace are equivalent to unset (the resolver then falls through
// to the cwd-rooted default). A literal "null" / "off" / "disabled" is
// NOT honored here — disabling the dump requires the explicit
// options.diagnosticDir = null wiring, since env-driven disables on a
// release-blocker instrument are too easy to mis-set.
function normalizeEnvDiagDir(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** One seeded turn's content plus the real evidence_capsule id it materialized. */
export interface SessionSeededTurn {
  /** The full source turn content seeded for this turn. */
  readonly turnContent: string;
  /** evidence_capsule object_id the turn's signal materialized, or null. */
  readonly evidenceId: string | null;
}

// Synthesis summary digest cap — keep the digest comfortably under the
// 16384-char soul.emit_candidate_signal raw_payload limit.
const SYNTHESIS_DIGEST_MAX_CHARS = 4_000;
const SYNTHESIS_PER_TURN_MAX_CHARS = 400;

/**
 * @anchor longmemeval-session-synthesis — deterministic, LLM-free synthesis seed
 *
 * Build the session-level potential_synthesis seed input from a session's
 * seeded turns. The summary is a deterministic concat/digest of each turn's
 * content (no LLM call): turns are joined in seed order, each clipped to a
 * fixed per-turn span, the whole digest clipped to a fixed cap. Determinism
 * is required so a re-run of the bench produces a byte-identical synthesis
 * row, mirroring the no-LLM seed discipline of extractSeedInputs.
 *
 * Returns null when fewer than 2 turns materialized a real evidence_capsule
 * id — the MaterializationRouter only routes potential_synthesis with
 * evidence_refs.length >= 2 to synthesisService.create.
 *
 * see also: packages/soul/src/garden/materialization-router.ts materializeSynthesis
 */
export function buildSessionSynthesisInput(input: {
  readonly topicKey: string;
  readonly turns: readonly SessionSeededTurn[];
}): BenchSynthesisSeedInput | null {
  const evidenceRefs = input.turns
    .map((turn) => turn.evidenceId)
    .filter((id): id is string => id !== null);
  if (evidenceRefs.length < 2) {
    return null;
  }
  const digest = input.turns
    .map((turn) => turn.turnContent.replace(/\s+/gu, " ").trim())
    .filter((content) => content.length > 0)
    .map((content) =>
      content.length > SYNTHESIS_PER_TURN_MAX_CHARS
        ? content.slice(0, SYNTHESIS_PER_TURN_MAX_CHARS)
        : content
    )
    .join(" | ");
  const summary =
    digest.length > SYNTHESIS_DIGEST_MAX_CHARS
      ? digest.slice(0, SYNTHESIS_DIGEST_MAX_CHARS)
      : digest;
  // summary must be non-empty for SynthesisCapsuleSchema; an all-blank
  // session cannot synthesize anything meaningful.
  if (summary.length === 0) {
    return null;
  }
  return {
    topicKey: input.topicKey,
    evidenceRefs,
    summary
  };
}

/**
 * @anchor longmemeval-d1-fanout — adjacent-turn derives_from handoff
 *
 * Compute the sourceMemoryRefs for the next turn's seed signal, given the
 * seed result of the current turn. Single-id semantics by design: only the
 * first seed of the current turn carries the derives_from link into the
 * next turn's signal.
 *
 * invariant: returned array length is 0 or 1 — never the union of every
 * fact in the current turn. Unioning N facts per turn would create
 * N x M edges per adjacent pair and scale as
 * session_count * turn_count * fact_per_turn^2; on a 500q LongMemEval run
 * that breaches the WSL2 memory ceiling. D-1's intent is "adjacent
 * sentence derives_from", not "every fact derives from every prior fact".
 *
 * invariant: returns [] when the current turn produced no seeds — the
 * caller treats [] as "no prior turn", emitting the next signal with
 * sourceMemoryRefs omitted (undefined), which is the same shape used for
 * the very first turn of a session and for the first turn of a new
 * session after a session boundary reset.
 *
 * see also: apps/bench-runner/src/longmemeval/runner.ts previousTurnSeedMemoryIds
 * see also: apps/bench-runner/src/longmemeval/multiturn.ts previousTurnSeedMemoryIds
 * see also: apps/bench-runner/src/longmemeval/crossquestion.ts previousTurnSeedMemoryIds
 */
export function computeNextTurnSeedRefs(
  seedResult: Readonly<Pick<CompileSeedResult, "seeds">>
): readonly string[] {
  const first = seedResult.seeds.length > 0 ? seedResult.seeds[0] : undefined;
  return first !== undefined ? [first.memoryId] : [];
}
