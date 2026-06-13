import type {
  BenchSignalSeedInput,
  BenchSynthesisSeedInput,
  CompileSeedBatchResult,
  CompileSeedDropReason,
  SeededMemoryResult,
  SeededSynthesisResult
} from "../harness/daemon.js";

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
   * Per-reason breakdown of signals lost AT THE MATERIALIZATION SEAM (the
   * proposeMemoriesFromCompileSignals path), so a candidate-absent seed-quality
   * miss is root-causable from the archive instead of only stderr:
   *   - candidate_absent: received + triaged but the router produced no
   *     memory_entry (evidence_only / deferred) — an expected sub-threshold
   *     outcome, the signal-quality hole the bench must surface.
   *   - materialization_error: the signal THREW before materializing a
   *     memory_entry. Isolated per-signal so one bad pre-materialization signal
   *     never drops its batch-mates — the fix for the 1963-signal whole-batch
   *     swallow.
   * A post-materialization accept/review failure is not a drop; it aborts the
   * bench so a recallable memory cannot be omitted from the seed sidecar.
   * These are a SUBSET of signalsDropped (the parse / compile-overflow drops
   * happen earlier, before this seam, and are NOT counted here).
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
  /**
   * Materialization-seam drops by reason (a SUBSET of signals_dropped) so the
   * archive discloses WHY a seeded fact never became a durable memory_entry:
   *   - candidate_absent: routed to evidence_only / deferred (no memory_entry).
   *   - materialization_error: the signal threw before memory_entry creation
   *     and was isolated per-signal.
   * Post-materialization accept/review failures fail the bench closed instead
   * of entering this ledger.
   * Persisted so candidate-absent / seed-quality misses are root-causable from
   * the KPI archive, not just stderr.
   */
  readonly signals_dropped_by_reason: {
    readonly candidate_absent: number;
    readonly materialization_error: number;
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
   * ledger (candidate_absent / materialization_error). Per-signal failure
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
