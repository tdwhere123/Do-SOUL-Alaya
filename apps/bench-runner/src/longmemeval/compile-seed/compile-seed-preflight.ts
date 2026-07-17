import {
  readExtractionCacheManifest,
  type ExtractionCacheManifest
} from "../extraction/cache/extraction-cache-manifest.js";
import { assertExtractionCacheIdentity } from "../extraction/cache/cache-identity.js";
import {
  computeCacheKey,
  inspectCachedExtraction
} from "./compile-seed-cache.js";
import {
  inspectExtractionCacheContentClosure,
  inspectExtractionFillCompletion
} from "../extraction/fill/fill-completion.js";
import {
  containsExtractionFillQuestionWindow
} from "../extraction/fill/fill-authority.js";
import type {
  ExtractionFillQuestionWindow
} from "../extraction/fill/manifest/fill-manifest-contract.js";
import type {
  CompileSeedExtractionConfig
} from "./compile-seed-types.js";

// Run-start coverage threshold. A populated cache below this coverage means a
// run would live-extract a large gap; the operator must pass an explicit
// allow-live / fill flag rather than have a slow live run start silently.
const EXTRACTION_CACHE_COVERAGE_THRESHOLD = 0.95;

/**
 * Run-start fail-loud guard. Runs in ~1s (file read + sha256, zero LLM) and
 * turns the otherwise-silent "wrong model / changed prompt / uncovered cache"
 * failures — which today only surface as a 466h slow run — into an immediate,
 * actionable throw.
 *
 * Behaviour by case:
 *   - NO manifest with requireManifest=false: allow inspection/offline
 *     continuation and warn. Live shard writes still fail until
 *     extraction-fill pins provider/model identity.
 *   - manifest present, `config.model !== manifest.extraction_model`: throw,
 *     naming both values — the cache would 0-hit and the run would be a full
 *     live extraction.
 *   - manifest present, `sha256(systemPrompt) !== manifest.system_prompt_sha256`:
 *     throw — the prompt drifted, so every key changed and the whole cache is
 *     dead.
 *   - manifest present, NO `coverage` field AND not an allow-live/fill run:
 *     throw — a pre-fill manifest cannot prove the cache covers the dataset,
 *     so it is a gap requiring `--allow-live-extraction`. extraction-fill
 *     always writes coverage, so a coverage-less manifest means an unfilled
 *     cache.
 *   - manifest present, `coverage < threshold` AND not an allow-live/fill run:
 *     throw, telling the operator to run extraction-fill or pass
 *     `--allow-live-extraction`.
 *
 * cross-file: apps/bench-runner/src/longmemeval/extraction-cache-manifest.ts
 */
export interface ExtractionCachePreflightInput {
  readonly cacheRoot: string;
  readonly config: CompileSeedExtractionConfig;
  readonly systemPrompt: string;
  readonly allowLiveExtraction?: boolean;
  // Whether THIS run can live-extract at all. The "uncovered window / coverage
  // gap" guards below exist to stop a credentialled run from silently spending
  // ~466h live-extracting an unfilled cache window. In a manifest-backed,
  // credentialless run, a missing fixture fails inside the cache-only extractor
  // before its delegate. Manifest-less compatibility runs may still use the
  // deterministic full-turn fallback. When live extraction is impossible the
  // coverage gap is therefore not a silent-cost hole, and this guard must NOT
  // fire. Defaults to `config.apiKey !== null` — the
  // single source createCompileSeedRunner reads for its `credentialled` flag —
  // so a direct caller that passes a credentialled config keeps the guard.
  // invariant: this only relaxes the live-extraction-gap guards; the
  // model/prompt-drift guards above always fire (cheap config-drift detection).
  readonly liveExtractionPossible?: boolean;
  readonly manifest?: ExtractionCacheManifest | undefined;
  // The distinct turn contents THIS run will extract (its --limit/--offset
  // question window flattened to rounds + dedup). When present, the gate is
  // window-containment: every one of these turns must already have a fixture on
  // disk, regardless of the manifest's coverage scalar (which is only
  // denominated against whatever window the LAST extraction-fill recorded). A
  // staged `extraction-fill --limit 100` writing coverage=1.0 therefore can no
  // longer let a `longmemeval --limit 500` run silently live-extract the
  // unfilled 400. When absent (callers that do not flatten a turn window),
  // the gate falls back to the manifest coverage scalar below.
  // cross-file: apps/bench-runner/src/longmemeval/extraction-fill.ts
  //   collectDistinctTurnContents (the producer side of the same dedup)
  readonly requiredTurnContents?: readonly string[];
  /** Exact question offset and effective count that produced required turns. */
  readonly requiredQuestionWindow?: ExtractionFillQuestionWindow;
  readonly warn?: (message: string) => void;
  /** When set, coverage scalar gate uses this floor instead of the 0.95 default. */
  readonly minimumCoverage?: number;
  /** Fail loud when manifest.json is absent (cache-only / warm-substrate runs). */
  readonly requireManifest?: boolean;
}

export function preflightExtractionCache(input: ExtractionCachePreflightInput): void {
  const manifest = input.manifest ?? readExtractionCacheManifest(input.cacheRoot);
  const warn = input.warn ?? ((message: string) => process.stderr.write(`${message}\n`));
  const liveExtractionPossible = input.liveExtractionPossible ?? input.config.apiKey !== null;
  const minimumCoverage = input.minimumCoverage ?? EXTRACTION_CACHE_COVERAGE_THRESHOLD;
  if (manifest === undefined) {
    handleMissingManifest(input.cacheRoot, input.requireManifest === true, warn);
    return;
  }
  assertExtractionCacheIdentity({
    config: input.config,
    systemPrompt: input.systemPrompt,
    manifest,
    validateProvider: input.allowLiveExtraction === true
  });
  assertConsumableFillContract(manifest, input);
  if (input.requiredTurnContents !== undefined) {
    if (assertScopedWindowBinding({
      cacheRoot: input.cacheRoot,
      model: input.config.model,
      requestProfile: input.config.requestProfile,
      systemPrompt: input.systemPrompt,
      requiredTurnContents: input.requiredTurnContents,
      requiredQuestionWindow: input.requiredQuestionWindow,
      manifest,
      allowLiveExtraction: input.allowLiveExtraction
    })) return;
    assertWindowContainment({
      cacheRoot: input.cacheRoot,
      model: input.config.model,
      requestProfile: input.config.requestProfile,
      systemPrompt: input.systemPrompt,
      requiredTurnContents: input.requiredTurnContents,
      allowLiveExtraction: input.allowLiveExtraction,
      liveExtractionPossible
    });
    return;
  }
  assertCoverageScalar(
    manifest.coverage,
    input.allowLiveExtraction === true,
    liveExtractionPossible,
    minimumCoverage
  );
}

function assertConsumableFillContract(
  manifest: ExtractionCacheManifest,
  input: ExtractionCachePreflightInput
): void {
  if (input.allowLiveExtraction === true || manifest.fill_status === undefined) return;
  if (manifest.fill_status === "in_progress") {
    throw new Error(
      "[longmemeval preflight] extraction cache fill is in_progress; a cache-only " +
        "run requires a finalized complete fill. Resume extraction-fill first."
    );
  }
  if (input.requiredTurnContents !== undefined &&
    input.requiredQuestionWindow !== undefined) return;
  throw new Error(
    "[longmemeval preflight] extraction cache complete fill requires the run's " +
      "exact turn key set and question window metadata."
  );
}

function assertScopedWindowBinding(input: {
  readonly cacheRoot: string;
  readonly model: string;
  readonly requestProfile: CompileSeedExtractionConfig["requestProfile"];
  readonly systemPrompt: string;
  readonly requiredTurnContents: readonly string[];
  readonly requiredQuestionWindow?: ExtractionFillQuestionWindow;
  readonly manifest: ExtractionCacheManifest;
  readonly allowLiveExtraction?: boolean;
}): boolean {
  if (input.allowLiveExtraction === true || input.manifest.fill_status !== "complete") {
    return false;
  }
  const window = assertContainedFillWindow(input);
  assertFinalizedContentClosure(input);
  if (input.manifest.window_offset !== window.offset ||
    input.manifest.window_limit !== window.limit) {
    return assertScopedSubsetFixtures(input);
  }
  const completion = inspectExtractionFillCompletion({
    cacheRoot: input.cacheRoot,
    model: input.model,
    requestProfile: input.requestProfile,
    systemPrompt: input.systemPrompt,
    turnContents: input.requiredTurnContents
  });
  if (completion.expectedTurns !== input.manifest.expected_turns ||
    completion.expectedKeySetSha256 !== input.manifest.expected_key_set_sha256) {
    throw new Error(
      "[longmemeval preflight] extraction cache complete fill does not match " +
        "this run's exact key set. Run extraction-fill for this question window."
    );
  }
  if (completion.validTurns !== completion.expectedTurns ||
    completion.missingTurns > 0 || completion.invalidTurns > 0 ||
    completion.orphanTurns > 0) {
    throw new Error(
      "[longmemeval preflight] extraction cache complete fill is structurally " +
        `invalid: missing=${completion.missingTurns} invalid=${completion.invalidTurns} ` +
        `orphan=${completion.orphanTurns}. Resume extraction-fill first.`
    );
  }
  return true;
}

function assertFinalizedContentClosure(
  input: Parameters<typeof assertScopedWindowBinding>[0]
): void {
  const inspected = inspectExtractionCacheContentClosure({
    cacheRoot: input.cacheRoot,
    model: input.model,
    requestProfile: input.requestProfile
  });
  const manifest = input.manifest;
  if (manifest.content_closure_sha256 === undefined ||
      inspected.shardTurns !== manifest.expected_turns ||
      inspected.validTurns !== manifest.expected_turns ||
      inspected.invalidTurns !== 0 ||
      inspected.keySetSha256 !== manifest.expected_key_set_sha256 ||
      inspected.contentClosureSha256 !== manifest.content_closure_sha256) {
    throw new Error(
      "[longmemeval preflight] extraction cache finalized content closure differs " +
        "from its complete manifest. Resume extraction-fill before consuming it."
    );
  }
}

function assertContainedFillWindow(
  input: Parameters<typeof assertScopedWindowBinding>[0]
): ExtractionFillQuestionWindow {
  const window = input.requiredQuestionWindow;
  if (window !== undefined && containsExtractionFillQuestionWindow(
    input.manifest, window.offset, window.limit
  )) return window;
  throw new Error(
    "[longmemeval preflight] extraction cache complete fill question window " +
      "does not contain this run's offset/limit. Run extraction-fill for " +
      "this question window."
  );
}

function assertScopedSubsetFixtures(
  input: Parameters<typeof assertScopedWindowBinding>[0]
): true {
  const unavailable = inspectRequiredTurnFixtures(
    input.cacheRoot,
    input.model,
    input.requestProfile,
    input.systemPrompt,
    input.requiredTurnContents
  );
  if (unavailable.total === 0) return true;
  throw new Error(
    "[longmemeval preflight] extraction cache complete fill has an invalid " +
      `consumer subwindow: ${unavailable.missing} missing and ` +
      `${unavailable.invalid} invalid required fixture(s).`
  );
}

function handleMissingManifest(
  cacheRoot: string,
  requireManifest: boolean,
  warn: (message: string) => void
): void {
  if (requireManifest) {
    throw new Error(
      "[longmemeval preflight] extraction-cache manifest is missing at " +
        `${cacheRoot}. Restore or populate the cache before a cache-only ` +
      "bench run, or set ALAYA_BENCH_REQUIRE_EXTRACTION_CACHE_MANIFEST=0 " +
        "only for inspection/offline continuation. Run extraction-fill before " +
        "any live cache write."
    );
  }
  warn(
    "[longmemeval preflight] no extraction-cache manifest at " +
      `${cacheRoot}; this explicit first-ever build inspection may continue, but ` +
      "live shard writes remain blocked until extraction-fill atomically pins " +
      "the provider/model identity."
  );
}

// Window-containment gate. When the caller hands the actual run window's
// distinct turns, validate THIS run's window directly against on-disk
// fixtures instead of trusting the manifest's coverage scalar. The scalar is
// denominated against whatever window the last extraction-fill recorded
// (extraction-fill.ts coverage = (requested - failures)/requested over that
// fill's --limit/--offset window), so a staged 100Q fill writing coverage=1.0
// would otherwise let a 500Q run pass preflight and silently live-extract the
// unfilled 400. Containment closes that sub-channel by asserting every turn
// this run needs has a fixture, regardless of the scalar.
function assertWindowContainment(input: {
  readonly cacheRoot: string;
  readonly model: string;
  readonly requestProfile: CompileSeedExtractionConfig["requestProfile"];
  readonly systemPrompt: string;
  readonly requiredTurnContents: readonly string[];
  readonly allowLiveExtraction?: boolean;
  readonly liveExtractionPossible: boolean;
}): void {
  const unavailable = inspectRequiredTurnFixtures(
    input.cacheRoot,
    input.model,
    input.requestProfile,
    input.systemPrompt,
    input.requiredTurnContents
  );
  if (
    unavailable.total > 0 &&
    input.allowLiveExtraction !== true &&
    input.liveExtractionPossible
  ) {
    const total = input.requiredTurnContents.length;
    throw new Error(
      "[longmemeval preflight] extraction cache covers only part of this " +
        `run's question window: ${unavailable.missing} missing and ` +
        `${unavailable.invalid} invalid fixture(s) among ${total} distinct turns, ` +
        "so this run would live-extract the gap. The cache " +
        "manifest's coverage scalar is relative to the window the last " +
        "extraction-fill recorded, not this run's window. Run extraction-fill " +
        "for the FULL --limit/--offset window of this run, or pass " +
        "--allow-live-extraction to live-extract the gap on purpose."
    );
  }
}

function assertCoverageScalar(
  coverage: number | undefined,
  allowLiveExtraction: boolean,
  liveExtractionPossible: boolean,
  minimumCoverage: number
): void {
  // A manifest WITHOUT a coverage field is itself a gap: a provenance-only
  // manifest (built before any fill recorded a denominator) cannot prove the
  // cache covers the dataset, so treating "coverage absent" as "coverage ok"
  // would silently re-open the 466h live-run hole the guard exists to close.
  // extraction-fill now always writes coverage, so a coverage-less manifest
  // means the cache was never filled against a known denominator. Require the
  // same explicit opt-in a low-coverage manifest requires.
  if (coverage === undefined) {
    if (!allowLiveExtraction && liveExtractionPossible) {
      throw new Error(
        "[longmemeval preflight] extraction cache manifest has no coverage " +
          "field; the cache was never filled against a known dataset " +
          "denominator, so this run could live-extract an unknown gap. Run " +
          "extraction-fill (which writes coverage) to populate the cache, or " +
          "pass --allow-live-extraction to live-extract on purpose."
      );
    }
    return;
  }
  if (
    coverage < minimumCoverage &&
    !allowLiveExtraction &&
    liveExtractionPossible
  ) {
    const coveragePct = (coverage * 100).toFixed(1);
    throw new Error(
      "[longmemeval preflight] extraction cache coverage " +
        `${coveragePct}% is below the ${(minimumCoverage * 100).toFixed(0)}% threshold; this run would live-extract the uncovered ` +
        "gap. Run extraction-fill to populate the cache, or pass " +
        "--allow-live-extraction to live-extract the gap on purpose."
    );
  }
}

/** A path alone cannot prove a runtime cache hit; use the runtime validator. */
function inspectRequiredTurnFixtures(
  cacheRoot: string,
  model: string,
  requestProfile: CompileSeedExtractionConfig["requestProfile"],
  systemPrompt: string,
  turnContents: readonly string[]
): { readonly missing: number; readonly invalid: number; readonly total: number } {
  let missing = 0;
  let invalid = 0;
  for (const turnContent of turnContents) {
    const cacheKey = computeCacheKey(model, requestProfile, systemPrompt, turnContent);
    const status = inspectCachedExtraction(
      cacheRoot,
      cacheKey,
      model,
      requestProfile
    ).status;
    if (status === "missing") missing += 1;
    if (status === "invalid") invalid += 1;
  }
  return { missing, invalid, total: missing + invalid };
}
