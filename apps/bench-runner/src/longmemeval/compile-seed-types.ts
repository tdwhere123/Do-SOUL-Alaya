import type {
  BenchSignalSeedInput,
  BenchSynthesisSeedInput,
  CompileSeedBatchResult,
  CompileSeedDropReason,
  SeededMemoryResult,
  SeededSynthesisResult
} from "../harness/daemon.js";
import type { ExtractionRequestProfile } from "./extraction-cache-manifest.js";
import type {
  ExtractionFillQuestionWindow
} from "./extraction/fill-manifest-contract.js";

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
    /** A probe uses one transport attempt and never enters the retry loop. */
    readonly retryMode?: "default" | "disabled";
    /** Called immediately before each provider HTTP attempt. */
    readonly onTransportAttempt?: () => void;
    /** Provider output-token ceiling when the selected profile supports it. */
    readonly maxOutputTokens?: number;
    /** Exact provider request field pre-registered in the authority receipt. */
    readonly outputTokenField?: "max_tokens" | "max_completion_tokens";
  }): Promise<{
    readonly rawJson: string;
    readonly extractorMeta?: BenchSignalExtractorMeta;
    /** Exact provider-reported request usage, never locally estimated. */
    readonly usage?: BenchProviderUsage;
  }>;
}

export interface BenchProviderUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
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

export type BenchTerminalRetryClassification = Exclude<
  BenchRetryClassification,
  "success_first_try" | "success_after_retry"
>;

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
  readonly rateLimitRetries: number;
}

export interface CompileSeedExtractionConfig {
  /** OpenAI-compatible chat-completions base URL (…/v1). */
  readonly providerUrl: string;
  /** Exact chat model id sent to the provider and used by the raw cache key. */
  readonly model: string;
  /** Comparison-only model family; never participates in the raw cache key. */
  readonly modelFamily?: string;
  /** Explicit request semantics; participates in cache and shard identity. */
  readonly requestProfile: ExtractionRequestProfile;
  /** Resolved API key, or null when no garden credentials are configured. */
  readonly apiKey: string | null;
}

export interface CompileSeedRunnerOptions {
  readonly config?: CompileSeedExtractionConfig;
  readonly cacheRoot?: string;
  readonly extractorFactory?: (
    config: CompileSeedExtractionConfig
  ) => BenchSignalExtractor;
  /**
   * Opt out of the run-start coverage guard so the run may live-extract the
   * uncovered cache gap on purpose (extraction-fill / explicit live re-run).
   * The model + prompt guards still apply; only the coverage gate is relaxed.
   */
  readonly allowLiveExtraction?: boolean;
  /**
   * The distinct turn contents THIS run will extract. When provided, the
   * run-start preflight switches from the manifest coverage scalar to
   * window-containment: every one of these turns must already have a fixture on
   * disk.
   */
  readonly requiredTurnContents?: readonly string[];
  /** Exact question offset and effective count represented by those turns. */
  readonly requiredQuestionWindow?: ExtractionFillQuestionWindow;
  /**
   * Skip the run-start preflight entirely. For unit tests that drive the
   * runner with a hand-built config + temp cacheRoot and do not exercise the
   * manifest guard. Production runner entrypoints never set this.
   */
  readonly skipPreflight?: boolean;
  /**
   * Override the directory the seed-side diagnostic dump writes failure
   * envelopes to. Defaults to
   * `<cwd>/data/diagnostics/seed-extraction-failures/`. Pass `null` to
   * disable dumps entirely.
   */
  readonly diagnosticDir?: string | null;
}

export interface CompileSeedExtractionStats {
  /** Which seed path ran. Disclosed in the bench report for honesty. */
  path: "official_api_compile" | "no_credentials_fallback";
  /** Non-empty turns submitted to the extraction seam. */
  extractionAttempts?: number;
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
  /** Live extractions that succeeded only after at least one retry. */
  retrySuccesses?: number;
  /** Provider attempts that returned HTTP 429. */
  rateLimitRetries?: number;
  /** Rate-limit events that reduced the extraction pool's active concurrency. */
  adaptiveConcurrencyBackoffs?: number;
  /** Sum of scheduled global rate-limit backoff windows in milliseconds. */
  adaptiveConcurrencyBackoffMs?: number;
  /** Terminal live transport outcomes, grouped without payload data. */
  terminalRetryClassifications?: Partial<
    Record<BenchTerminalRetryClassification, number>
  >;
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
   * Per-reason breakdown of losses inside proposeMemoriesFromCompileSignals:
   *   - candidate_absent: the router accepts and triages a signal but produces
   *     no memory_entry (for example evidence_only / deferred).
   *   - materialization_drop: the signal throws before materializing a
   *     memory_entry.
   * Healthy siblings from the same turn continue independently. A
   * post-materialization accept/review failure is not a drop; it aborts the
   * bench so a recallable memory cannot disappear from the seed sidecar.
   * These counts are a subset of signalsDropped; parse and compile-overflow
   * drops happen earlier and are excluded here.
   */
  signalsDroppedByReason: Record<CompileSeedDropReason, number>;
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
  /** SHA-256 of the exact raw_json string returned by the latest successful extraction. */
  lastRawJsonSha256: string | null;
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
  readonly extraction_attempts: number;
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
  /**
   * Materialization-seam drops by reason (a SUBSET of signals_dropped) so the
   * archive discloses WHY a seeded fact never became a durable memory_entry:
   *   - candidate_absent: routed to evidence_only / deferred (no memory_entry).
   *   - materialization_drop: the signal threw before memory_entry creation
   *     and was isolated per-signal.
   * Post-materialization accept/review failures fail the bench closed instead
   * of entering this ledger.
   * Persisted so candidate-absent / seed-quality misses are root-causable from
   * the KPI archive, not just stderr.
   */
  readonly signals_dropped_by_reason: {
    readonly candidate_absent: number;
    readonly materialization_drop: number;
  };
}

/** Minimal daemon surface the compile seed path needs — test-stubbable. */
export interface CompileSeedDaemon {
  /**
   * Seeds the production-extracted signals of ONE round through the daemon's
   * in-process signalService.receiveSignal — the same seam production
   * POST_TURN_EXTRACT completion uses — so they materialize with
   * source = garden_compile. Used for the credentialled compile path.
   *
   * Returns the materialized seeds AND a per-signal pre-memory-entry drop
   * ledger (candidate_absent / materialization_drop). Per-signal failure
   * isolation lives in the daemon implementation — one bad pre-materialization
   * signal never drops its batch-mates. Post-materialization accept failures
   * throw and abort scoring.
   * see also: apps/bench-runner/src/harness/daemon.ts proposeMemoriesFromCompileSignals
   */
  proposeMemoriesFromCompileSignals(
    inputs: readonly BenchSignalSeedInput[]
  ): Promise<CompileSeedBatchResult>;
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
  seedTurn(input: CompileSeedTurnInput): Promise<CompileSeedResult>;
}

export interface CompileSeedTurnInput {
  readonly daemon: CompileSeedDaemon;
  readonly turnContent: string;
  readonly evidenceRefBase: string;
  readonly seedIndex: number;
  readonly workspaceId: string;
  readonly runId: string;
  readonly surfaceId?: string | null;
  readonly sourceObservedAt?: string;
  // see also: apps/bench-runner/src/harness/daemon.ts BenchSignalSeedInput.sourceMemoryRefs
  readonly sourceMemoryRefs?: readonly string[];
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
