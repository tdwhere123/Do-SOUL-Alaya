import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Seed-extraction diagnostic instrument: default cwd-rooted dump dir,
// shared with packages/soul/src/garden/compute-provider.ts so a preflight can
// read provider-side and seed-side dumps from one place. data/* is gitignored.
const DEFAULT_COMPILE_SEED_DIAGNOSTIC_DIR_REL =
  "data/diagnostics/seed-extraction-failures";
const COMPILE_SEED_CACHE_KEY_PREFIX_CHARS = 12;
import {
  OFFICIAL_API_SYSTEM_PROMPT,
  OfficialApiGardenProvider,
  parseOfficialApiSignals,
  salvageRawSignalElements,
  type GardenCompileContext
} from "@do-soul/alaya-soul";
import { readExtractionCacheManifest } from "./extraction-cache-manifest.js";
import { createCachingSignalExtractor } from "./compile-seed-cache.js";
export { createCachingSignalExtractor } from "./compile-seed-cache.js";
import {
  EXTRACTION_CACHE_ROOT,
  resolveBenchAllowLiveExtraction,
  resolveCompileSeedExtractionConfig,
  toSeedExtractionPathKpi
} from "./compile-seed-config.js";
export {
  EXTRACTION_CACHE_ROOT,
  resolveBenchAllowLiveExtraction,
  resolveCompileSeedExtractionConfig,
  toSeedExtractionPathKpi
} from "./compile-seed-config.js";
import {
  createGardenHttpExtractor,
  EXTRACTION_REQUEST_TIMEOUT_MS
} from "./compile-seed-http.js";
export {
  createGardenHttpExtractor,
  extractContentFromChatCompletionBody
} from "./compile-seed-http.js";
import { preflightExtractionCache } from "./compile-seed-preflight.js";
export { preflightExtractionCache } from "./compile-seed-preflight.js";
import type {
  BenchRetryClassification,
  BenchSignalExtractor,
  CompileSeedDaemon,
  CompileSeedExtractionConfig,
  CompileSeedExtractionStats,
  CompileSeedResult,
  CompileSeedRunner
} from "./compile-seed-types.js";
export type {
  BenchRetryClassification,
  BenchSignalExtractor,
  BenchSignalExtractorMeta,
  CompileSeedDaemon,
  CompileSeedExtractionConfig,
  CompileSeedExtractionStats,
  CompileSeedResult,
  CompileSeedRunner,
  SeedExtractionPathKpi
} from "./compile-seed-types.js";
import type {
  BenchSignalSeedInput,
  CompileSeedBatchResult,
  SeededMemoryResult,
  SeededSynthesisResult
} from "../harness/daemon.js";
import {
  canonicalizeSeedObjectKind,
  rotatingSeedObjectKind
} from "../harness/seed-rotation.js";
import { isUnscoredMaterializedSeedError } from "../harness/seed-errors.js";
export {
  buildSessionSynthesisInput,
  computeNextTurnSeedRefs,
  type SessionSeededTurn
} from "./compile-seed-session.js";

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
 * At assembly time a run-start fail-loud guard (preflightExtractionCache)
 * validates the resolved model + system prompt + cache coverage against the
 * cache's self-describing manifest, so a model/prompt/coverage drift throws
 * in ~1s instead of silently degrading to a 466h live run.
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
   * Opt out of the run-start coverage guard so the run may live-extract the
   * uncovered cache gap on purpose (extraction-fill / explicit live re-run).
   * The model + prompt guards still apply; only the coverage gate is relaxed.
   */
  readonly allowLiveExtraction?: boolean;
  /**
   * The distinct turn contents THIS run will extract. When provided, the
   * run-start preflight switches from the manifest coverage scalar to
   * window-containment: every one of these turns must already have a fixture on
   * disk. The runner passes its flattened question window so a staged
   * extraction-fill cannot let a wider run silently live-extract the gap.
   * cross-file: apps/bench-runner/src/longmemeval/runner.ts (passes the window)
   */
  readonly requiredTurnContents?: readonly string[];
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
   * disable dumps entirely (read-only fs, unit tests that want zero side
   * effects).
   */
  readonly diagnosticDir?: string | null;
}): CompileSeedRunner {
  const cacheRoot = options?.cacheRoot ?? EXTRACTION_CACHE_ROOT;
  // The cache self-describes its build model/prompt/coverage. Read it once so
  // both config resolution (env-absent -> manifest.extraction_model, never the
  // production constant) and the run-start guard consume the same source.
  const manifest = options?.config
    ? undefined
    : readExtractionCacheManifest(cacheRoot);
  const config =
    options?.config ?? resolveCompileSeedExtractionConfig(process.env, manifest);
  // Single source for online-vs-offline: credentials presence. The offline
  // (credentialled === false) path's provider is null, so a missing fixture is
  // served by the deterministic full-turn fallback, never a live LLM call.
  const credentialled = config.apiKey !== null;
  // Run-start fail-loud guard. Skipped only for unit tests that hand-build the
  // config + a manifest-less temp cacheRoot; production entrypoints never skip.
  // liveExtractionPossible threads `credentialled` so the coverage-gap guards
  // fire only for credentialled runs (which CAN silently burn ~466h live);
  // the offline path has nothing to live-extract, so the gap is a no-op.
  // cross-file: preflightExtractionCache (consumes liveExtractionPossible)
  if (options?.skipPreflight !== true) {
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
  const stats: CompileSeedExtractionStats = {
    path: credentialled ? "official_api_compile" : "no_credentials_fallback",
    cacheHits: 0,
    llmCalls: 0,
    offlineFallbacks: 0,
    liveExtractionFailures: 0,
    cachedExtractionFailures: 0,
    factsProduced: 0,
    signalsDropped: 0,
    signalsDroppedByReason: { candidate_absent: 0, materialization_error: 0 },
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
            cacheRoot,
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
      // proposeMemoriesFromCompileSignals isolates failures PER SIGNAL: a
      // signal routed to evidence_only / deferred (candidate_absent) and a
      // signal that threw before memory_entry creation (materialization_error)
      // are each recorded in the returned `dropped` ledger WITHOUT aborting the
      // round's healthy batch-mates. A post-materialization accept/review error
      // rethrows from this block so scoring cannot proceed with a recallable
      // memory missing from seedResult.seeds. The per-reason ledger is folded
      // into the stats so candidate-absent / seed-quality is root-causable from
      // the KPI archive. The outer try/catch remains a defensive backstop for a
      // truly unexpected whole-batch failure (a daemon-level bug, not a
      // per-signal one); the per-signal path no longer routes through it.
      try {
        const batch: CompileSeedBatchResult =
          await input.daemon.proposeMemoriesFromCompileSignals(signalInputs);
        seeds = batch.seeds;
        if (batch.dropped.length > 0) {
          stats.signalsDropped += batch.dropped.length;
          for (const drop of batch.dropped) {
            stats.signalsDroppedByReason[drop.reason] += 1;
          }
          const byReason = batch.dropped.reduce<Record<string, number>>(
            (acc, drop) => {
              acc[drop.reason] = (acc[drop.reason] ?? 0) + 1;
              return acc;
            },
            {}
          );
          const breakdown = Object.entries(byReason)
            .map(([reason, count]) => `${reason}=${count}`)
            .join(" ");
          process.stderr.write(
            `[longmemeval compile-seed] ${batch.dropped.length} signal(s) of ` +
              `${signalInputs.length} did not materialize a memory_entry ` +
              `(${breakdown}); the round's other facts seeded normally\n`
          );
        }
      } catch (error) {
        if (isUnscoredMaterializedSeedError(error)) {
          throw error;
        }
        stats.signalsDropped += signalInputs.length;
        stats.signalsDroppedByReason.materialization_error += signalInputs.length;
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
          if (isUnscoredMaterializedSeedError(error)) {
            throw error;
          }
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
    // see also: packages/soul/src/garden/materialization-router/inputs.ts
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
