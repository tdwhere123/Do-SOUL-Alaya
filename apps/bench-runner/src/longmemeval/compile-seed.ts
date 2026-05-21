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
import { resolveSecretRef } from "@do-soul/alaya";
import {
  OFFICIAL_API_GARDEN_MODEL,
  OfficialApiGardenProvider,
  parseOfficialApiSignals,
  type GardenCompileContext
} from "@do-soul/alaya-soul";
import type { BenchSignalSeedInput, SeededMemoryResult } from "../harness/daemon.js";
import { rotatingSeedObjectKind } from "../harness/seed-rotation.js";

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

/**
 * The injectable `SignalExtractor` shape consumed by
 * `OfficialApiGardenProvider`. Declared structurally here so the bench does
 * not depend on a non-exported soul type; it matches the provider's
 * `extractor` constructor dependency.
 */
export interface BenchSignalExtractor {
  extract(input: {
    readonly systemPrompt: string;
    readonly userPrompt: string;
    readonly abortSignal?: AbortSignal;
    readonly timeoutMs?: number;
  }): Promise<{ readonly rawJson: string }>;
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
          stats.cacheHits += 1;
          recordExtractionDraftCounts(stats, cached);
        }
        return { rawJson: cached };
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

/**
 * Live garden LLM delegate: OpenAI-compatible POST /chat/completions with a
 * JSON-object response format, temperature 0. This is the same transport the
 * production `createPiMonoExtractor` uses; it is re-implemented here with
 * `fetch` (no new client dependency) because the bench harness drives the
 * provider through its injectable `extractor` seam and the production pi-mono
 * extractor is not on the soul package's public surface. The provider still
 * supplies the production `OFFICIAL_API_SYSTEM_PROMPT` and parses the
 * response with the production `parseOfficialApiSignals`, so extraction
 * semantics are production-faithful — only the chat-completions transport
 * shim is bench-local.
 */
export function createGardenHttpExtractor(
  config: CompileSeedExtractionConfig
): BenchSignalExtractor {
  return {
    async extract(input) {
      if (config.apiKey === null) {
        throw new Error("garden API key is unavailable");
      }
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        input.timeoutMs ?? EXTRACTION_REQUEST_TIMEOUT_MS
      );
      try {
        const response = await fetch(`${config.providerUrl}/chat/completions`, {
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
          throw new Error(
            `garden extraction HTTP ${response.status} ${response.statusText}`
          );
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
        return { rawJson: content };
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

/** Minimal daemon surface the compile seed path needs — test-stubbable. */
export interface CompileSeedDaemon {
  /**
   * Seeds the production-extracted signals of ONE turn through the garden
   * task completion path so they materialize with source = garden_compile —
   * faithful to production POST_TURN_EXTRACT. Used for the credentialled
   * compile path.
   */
  proposeMemoriesFromGardenTask(
    inputs: readonly BenchSignalSeedInput[]
  ): Promise<readonly SeededMemoryResult[]>;
  /**
   * Seeds one signal through soul.emit_candidate_signal (source =
   * model_tool). Used ONLY for the no-credentials / extraction-failure
   * fallback, where a full-turn fact genuinely is an agent-style proposal.
   */
  proposeMemoryFromSignal(input: BenchSignalSeedInput): Promise<SeededMemoryResult>;
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
}): CompileSeedRunner {
  const config = options?.config ?? resolveCompileSeedExtractionConfig();
  const credentialled = config.apiKey !== null;
  const stats: CompileSeedExtractionStats = {
    path: credentialled ? "official_api_compile" : "no_credentials_fallback",
    cacheHits: 0,
    llmCalls: 0,
    offlineFallbacks: 0,
    factsProduced: 0,
    signalsDropped: 0,
    parseDropped: 0,
    compileOverflowDropped: 0,
    lastTurnRawSignalCount: 0,
    lastTurnDraftCount: 0
  };

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
          requestTimeoutMs: EXTRACTION_REQUEST_TIMEOUT_MS
        });

  async function seedTurn(input: {
    readonly daemon: CompileSeedDaemon;
    readonly turnContent: string;
    readonly evidenceRefBase: string;
    readonly seedIndex: number;
    readonly workspaceId: string;
    readonly runId: string;
    readonly surfaceId?: string | null;
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
      }
    });

    // invariant: every fact gets a distinct evidence_ref so the audit trail
    // and the per-fact materialized object_id stay 1:1.
    const signalInputs: BenchSignalSeedInput[] = seedInputs.map(
      (seedInput, i) => ({
        ...seedInput,
        evidenceRef:
          seedInputs.length === 1
            ? input.evidenceRefBase
            : `${input.evidenceRefBase}-f${i}`
      })
    );

    let seeds: readonly SeededMemoryResult[];
    // extractSeedInputs returns a homogeneous list per turn — every signal
    // is either official_api_compile (credentialled extraction) or
    // no_credentials_fallback (degraded path). The compile path materializes
    // through garden.complete_task so the seeded signals carry source =
    // garden_compile, faithful to the production POST_TURN_EXTRACT
    // completion; the fallback path uses soul.emit_candidate_signal, whose
    // source = model_tool is the honest label for an agent-style full-turn
    // proposal.
    if (signalInputs[0]?.extractionProvider === "official_api_compile") {
      // The whole turn's signals go through ONE garden task, matching
      // production where one POST_TURN_EXTRACT task carries all of a turn's
      // compile() signals. A bad signal kind aborts the batch — the same
      // all-or-nothing per-task behaviour the production completion has.
      try {
        seeds = await input.daemon.proposeMemoriesFromGardenTask(signalInputs);
      } catch (error) {
        stats.signalsDropped += signalInputs.length;
        process.stderr.write(
          `[longmemeval compile-seed] dropped ${signalInputs.length} signal(s) during garden-task seed: ${stringifyError(error)}\n`
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
    drafts.push({
      signalKind: signal.signal_kind,
      objectKind: signal.object_kind,
      confidence: signal.confidence,
      distilledFact: distilled,
      turnContent: input.turnContent,
      ...(matchedText === null ? {} : { matchedText }),
      // Forward the production signal's schema-grounded raw_payload verbatim
      // so the bench evidence_capsule is built from the same matched_text
      // span production materializes (buildSignalSummary reads
      // field_candidates[0].value). Without this the bench would carry the
      // full turn as evidence — richer than production.
      productionRawPayload: signal.raw_payload,
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
        extractionProvider: "official_api_compile"
      }
    ];
  }

  input.stats.factsProduced += drafts.length;
  return drafts;
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
