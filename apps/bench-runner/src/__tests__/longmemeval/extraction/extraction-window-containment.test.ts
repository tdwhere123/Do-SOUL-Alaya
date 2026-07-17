import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import {
  collectDistinctTurnContents,
  runExtractionFill
} from "../../../longmemeval/extraction/extraction-fill.js";
import {
  createCachingSignalExtractor,
  preflightExtractionCache,
  type BenchSignalExtractor,
  type CompileSeedExtractionConfig
} from "../../../longmemeval/compile-seed.js";
import {
  computeSystemPromptSha256,
  readExtractionCacheManifest,
  writeExtractionCacheManifest,
  EXTRACTION_CACHE_KEY_ALGO,
  EXTRACTION_CACHE_MANIFEST_VERSION
} from "../../../longmemeval/extraction/cache/extraction-cache-manifest.js";
import { buildLongMemEvalFixtureQuestion } from "../longmemeval-fixture.js";
import { writeExtractionCacheTestManifest } from "./extraction-cache-test-fixture.js";

// @anchor extraction-window-containment — I2: the cache coverage gate must
// validate THIS run's question window, not the (possibly narrower) window the
// last extraction-fill recorded. A staged fill writing coverage=1.0 over a
// small window must NOT let a wider run pass preflight and silently
// live-extract the unfilled remainder.
// cross-file: apps/bench-runner/src/longmemeval/compile-seed.ts
//   (preflightExtractionCache requiredTurnContents)

const CONFIG: CompileSeedExtractionConfig = {
  providerUrl: "https://yunwu.ai/v1",
  model: "gpt-5.4-mini",
  requestProfile: "provider-default-v1",
  apiKey: "test-key"
};

// Offline delegate: writes one empty signal envelope per turn, no live HTTP.
function offlineExtractorFactory(): BenchSignalExtractor {
  return { extract: vi.fn(async () => ({ rawJson: '{"signals":[]}' })) };
}

// Populate the cache with fixtures for exactly `turnContents`, through the same
// caching extractor + cache key the production seed path writes.
async function fillTurns(
  cacheRoot: string,
  turnContents: readonly string[]
): Promise<void> {
  writeExtractionCacheTestManifest({
    cacheRoot,
    model: CONFIG.model,
    modelFamily: CONFIG.model,
    providerUrl: CONFIG.providerUrl,
    systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
  });
  const extractor = createCachingSignalExtractor({
    delegate: offlineExtractorFactory(),
    config: CONFIG,
    cacheRoot
  });
  for (const turn of turnContents) {
    await extractor.extract({
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
      userPrompt: JSON.stringify({
        workspace_id: "x",
        run_id: "x",
        surface_id: null,
        turn_content: turn,
        turn_messages: []
      })
    });
  }
  // The staged-fill scenario always has a manifest claiming full coverage of
  // its (narrow) fill window. Write one so preflight exercises the
  // manifest-present containment path, not the no-manifest first-build path.
  writeExtractionCacheManifest(cacheRoot, {
    schema_version: EXTRACTION_CACHE_MANIFEST_VERSION,
    extraction_model: CONFIG.model,
    model_family: CONFIG.model,
    request_profile: CONFIG.requestProfile,
    provider_url: CONFIG.providerUrl,
    system_prompt_sha256: computeSystemPromptSha256(OFFICIAL_API_SYSTEM_PROMPT),
    cache_key_algo: EXTRACTION_CACHE_KEY_ALGO,
    dataset: "longmemeval-oracle",
    dataset_revision: "fixture",
    requested_turns: turnContents.length,
    cached_turns: turnContents.length,
    coverage: 1,
    storage: "git-tracked",
    built_at: new Date().toISOString(),
    builder: "test"
  });
}

let cacheRoot: string;

beforeEach(async () => {
  cacheRoot = await mkdtemp(join(tmpdir(), "window-containment-"));
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", "gpt-5.4-mini");
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", "provider-default-v1");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(cacheRoot, { recursive: true, force: true });
});

describe("extraction window-containment preflight", () => {
  it("passes a run whose window equals the filled window, throws on a wider window", async () => {
    const windowA = [buildLongMemEvalFixtureQuestion("q001", "s-001")];
    const windowAB = [
      buildLongMemEvalFixtureQuestion("q001", "s-001"),
      buildLongMemEvalFixtureQuestion("q002", "s-002")
    ];
    const turnsA = collectDistinctTurnContents(windowA);
    const turnsAB = collectDistinctTurnContents(windowAB);
    expect(turnsAB.length).toBeGreaterThan(turnsA.length);

    await fillTurns(cacheRoot, turnsA);

    // A run whose window is exactly the filled window A passes.
    expect(() =>
      preflightExtractionCache({
        cacheRoot,
        config: CONFIG,
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
        requiredTurnContents: turnsA
      })
    ).not.toThrow();

    // A wider run (window A+B) must THROW: window B's turns have no fixture.
    expect(() =>
      preflightExtractionCache({
        cacheRoot,
        config: CONFIG,
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
        requiredTurnContents: turnsAB
      })
    ).toThrow(/covers only part of this run's question window/su);

    // The same wider run with --allow-live-extraction is permitted.
    expect(() =>
      preflightExtractionCache({
        cacheRoot,
        config: CONFIG,
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
        requiredTurnContents: turnsAB,
        allowLiveExtraction: true
      })
    ).not.toThrow();
  });

  it("extraction-fill over window A writes coverage=1.0 yet preflight blocks window A+B", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "wc-data-"));
    const pinnedMetaRoot = await mkdtemp(join(tmpdir(), "wc-pinned-"));
    try {
      const windowAB = [
        buildLongMemEvalFixtureQuestion("q001", "s-001"),
        buildLongMemEvalFixtureQuestion("q002", "s-002")
      ];
      const raw = JSON.stringify(windowAB);
      const sha = createHash("sha256").update(raw, "utf8").digest("hex");
      await writeFile(join(dataDir, "longmemeval_oracle.json"), raw, "utf8");
      await writeFile(
        join(pinnedMetaRoot, "longmemeval_oracle.meta.json"),
        JSON.stringify({ name: "longmemeval_oracle", sha256: sha, question_count: 2 }),
        "utf8"
      );

      // Fill the cache against the narrow window A (--limit 1). extraction-fill
      // writes coverage=1.0: 100% of THAT window's distinct turns are cached.
      const fill = await runExtractionFill({
        variant: "longmemeval_oracle",
        limit: 1,
        cacheRoot,
        dataDir,
        pinnedMetaRoot,
        extractorFactory: offlineExtractorFactory,
        log: () => {}
      });
      expect(fill.coverage).toBe(1);
      const manifest = readExtractionCacheManifest(cacheRoot);
      expect(manifest?.coverage).toBe(1);

      const turnsA = collectDistinctTurnContents(windowAB.slice(0, 1));
      expect(() => preflightExtractionCache({
        cacheRoot,
        config: CONFIG,
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
        requiredTurnContents: turnsA,
        requiredQuestionWindow: { offset: 0, limit: 1 }
      })).not.toThrow();

      // The full window A+B still fails preflight despite coverage=1.0 — the
      // scalar is relative to the fill window, containment catches the gap.
      const turnsAB = collectDistinctTurnContents(windowAB);
      expect(() =>
        preflightExtractionCache({
          cacheRoot,
          config: CONFIG,
          systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
          requiredTurnContents: turnsAB,
          requiredQuestionWindow: { offset: 0, limit: 2 }
        })
      ).toThrow(/complete fill question window.*contain.*offset\/limit/su);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
      await rm(pinnedMetaRoot, { recursive: true, force: true });
    }
  }, 60_000);

  // @anchor offline-coverage-gap-exemption — the no-credentials offline seed
  // path (apiKey null) can never live-extract: a missing fixture is served by
  // the deterministic full-turn fallback, not an LLM call. So the
  // "uncovered window" guard is a category error there and must NOT fire,
  // while a credentialled run with the SAME uncovered window MUST still throw
  // (it would silently burn ~466h live-extracting the gap).
  // cross-file: compile-seed.ts createCompileSeedRunner (threads
  //   liveExtractionPossible = credentialled)
  it("skips the uncovered-window guard for an offline (no-credentials) run but keeps it for a credentialled run", async () => {
    const windowA = [buildLongMemEvalFixtureQuestion("q001", "s-001")];
    const windowAB = [
      buildLongMemEvalFixtureQuestion("q001", "s-001"),
      buildLongMemEvalFixtureQuestion("q002", "s-002")
    ];
    const turnsAB = collectDistinctTurnContents(windowAB);
    // Fill only window A so window B's turns are an uncovered gap.
    await fillTurns(cacheRoot, collectDistinctTurnContents(windowA));

    const offlineConfig: CompileSeedExtractionConfig = {
      providerUrl: CONFIG.providerUrl,
      model: CONFIG.model,
      requestProfile: CONFIG.requestProfile,
      apiKey: null
    };

    // Offline run: apiKey null => liveExtractionPossible defaults false =>
    // the gap is handled by the offline fallback, so preflight is a no-op.
    expect(() =>
      preflightExtractionCache({
        cacheRoot,
        config: offlineConfig,
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
        requiredTurnContents: turnsAB
      })
    ).not.toThrow();

    // An explicit liveExtractionPossible:false on a credentialled config is
    // also exempt (the flag, not just apiKey, gates the guard).
    expect(() =>
      preflightExtractionCache({
        cacheRoot,
        config: CONFIG,
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
        requiredTurnContents: turnsAB,
        liveExtractionPossible: false
      })
    ).not.toThrow();

    // Load-bearing: a credentialled run (apiKey present => liveExtractionPossible
    // defaults true) with the SAME uncovered window MUST still throw. This is
    // the deliberate release-blocker behavior; relaxing offline mode must not
    // gut the guard for real runs.
    expect(() =>
      preflightExtractionCache({
        cacheRoot,
        config: CONFIG,
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
        requiredTurnContents: turnsAB
      })
    ).toThrow(/covers only part of this run's question window/su);

    // And the same credentialled run with an explicit liveExtractionPossible:true
    // throws too — the flag does not silently disable the guard for online runs.
    expect(() =>
      preflightExtractionCache({
        cacheRoot,
        config: CONFIG,
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
        requiredTurnContents: turnsAB,
        liveExtractionPossible: true
      })
    ).toThrow(/covers only part of this run's question window/su);
  });
});
