import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OfficialApiGardenProvider } from "@do-soul/alaya-soul";
import {
  computeNextTurnSeedRefs,
  createCachingSignalExtractor,
  createCompileSeedRunner,
  createGardenHttpExtractor,
  extractContentFromChatCompletionBody,
  resolveCompileSeedExtractionConfig,
  toSeedExtractionPathKpi,
  type BenchSignalExtractor,
  type CompileSeedDaemon,
  type CompileSeedExtractionConfig,
  type CompileSeedExtractionStats
} from "../longmemeval/compile-seed.js";
import type { BenchSignalSeedInput, SeededMemoryResult } from "../harness/daemon.js";
import { createUnscoredMaterializedSeedError } from "../harness/seed-errors.js";

/**
 * A test CompileSeedDaemon stub. The compile (credentialled) seed path
 * materializes a round's signals through proposeMemoriesFromCompileSignals
 * (the in-process signalService.receiveSignal seam); the no-credentials
 * fallback path uses proposeMemoryFromSignal. Both delegate to one per-signal
 * handler so tests can inspect every BenchSignalSeedInput regardless of path.
 */
function buildCompileSeedDaemon(
  onSignal: (input: BenchSignalSeedInput) => SeededMemoryResult
): CompileSeedDaemon {
  return {
    proposeMemoryFromSignal: async (input) => onSignal(input),
    proposeMemoriesFromCompileSignals: async (inputs) => ({
      seeds: inputs.map(onSignal),
      dropped: []
    }),
    // The compile-seed tests do not exercise the session-level L2 synthesis
    // emission seam (covered by harness/daemon tests); the stub keeps the
    // CompileSeedDaemon contract satisfied and returns a null synthesisId
    // mirroring the no-op path the real daemon takes when no synthesis
    // capsule is created.
    proposeSynthesis: async () => ({ synthesisId: null })
  };
}

const CREDENTIALLED_CONFIG: CompileSeedExtractionConfig = {
  providerUrl: "https://example.test/v1",
  model: "test-model",
  apiKey: "test-key"
};

const OFFLINE_CONFIG: CompileSeedExtractionConfig = {
  providerUrl: "https://example.test/v1",
  model: "test-model",
  apiKey: null
};

function signalsEnvelope(
  facts: readonly { distilled: string; matched: string }[]
): string {
  return JSON.stringify({
    signals: facts.map((fact) => ({
      signal_kind: "potential_preference",
      object_kind: "user_preference",
      confidence: 0.9,
      matched_text: fact.matched,
      distilled_fact: fact.distilled
    }))
  });
}

describe("createCachingSignalExtractor", () => {
  let cacheRoot: string;

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "compile-seed-cache-"));
  });

  afterEach(async () => {
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("delegates to the real extractor on a cache miss", async () => {
    const delegate: BenchSignalExtractor = {
      extract: vi.fn(async () => ({ rawJson: '{"signals":[]}' }))
    };
    const stats: CompileSeedExtractionStats = {
      path: "official_api_compile",
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
      lastExtractionSource: null
    };
    const extractor = createCachingSignalExtractor({
      delegate,
      model: "test-model",
      cacheRoot,
      stats
    });

    const result = await extractor.extract({
      systemPrompt: "sys",
      userPrompt: "user"
    });

    expect(result.rawJson).toBe('{"signals":[]}');
    expect(delegate.extract).toHaveBeenCalledTimes(1);
    expect(stats.llmCalls).toBe(1);
    expect(stats.cacheHits).toBe(0);
    expect(stats.liveExtractionFailures).toBe(0);
    expect(stats.cachedExtractionFailures).toBe(0);
    expect(stats.lastExtractionSource).toBe("live");
  });

  it("serves a second extraction from the on-disk fixture with zero LLM calls", async () => {
    const delegate: BenchSignalExtractor = {
      extract: vi.fn(async () => ({ rawJson: '{"signals":[{"x":1}]}' }))
    };
    const firstStats: CompileSeedExtractionStats = {
      path: "official_api_compile",
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
      lastExtractionSource: null
    };
    const firstRun = createCachingSignalExtractor({
      delegate,
      model: "test-model",
      cacheRoot,
      stats: firstStats
    });
    await firstRun.extract({ systemPrompt: "sys", userPrompt: "turn-A" });
    expect(delegate.extract).toHaveBeenCalledTimes(1);

    // A fresh extractor sharing the same fixture must not call the delegate.
    const secondStats: CompileSeedExtractionStats = {
      path: "official_api_compile",
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
      lastExtractionSource: null
    };
    const secondRun = createCachingSignalExtractor({
      delegate,
      model: "test-model",
      cacheRoot,
      stats: secondStats
    });
    const cached = await secondRun.extract({
      systemPrompt: "sys",
      userPrompt: "turn-A"
    });

    expect(delegate.extract).toHaveBeenCalledTimes(1);
    expect(secondStats.cacheHits).toBe(1);
    expect(secondStats.llmCalls).toBe(0);
    expect(secondStats.liveExtractionFailures).toBe(0);
    expect(secondStats.cachedExtractionFailures).toBe(0);
    expect(secondStats.lastExtractionSource).toBe("cache");
    expect(cached.rawJson).toBe('{"signals":[{"x":1}]}');
  });

  it("keys the cache on the prompt: a different user prompt is a fresh miss", async () => {
    const delegate: BenchSignalExtractor = {
      extract: vi
        .fn<BenchSignalExtractor["extract"]>()
        .mockResolvedValueOnce({ rawJson: '{"signals":[{"a":1}]}' })
        .mockResolvedValueOnce({ rawJson: '{"signals":[{"b":2}]}' })
    };
    const extractor = createCachingSignalExtractor({
      delegate,
      model: "test-model",
      cacheRoot
    });

    const first = await extractor.extract({ systemPrompt: "s", userPrompt: "A" });
    const second = await extractor.extract({ systemPrompt: "s", userPrompt: "B" });

    expect(first.rawJson).toBe('{"signals":[{"a":1}]}');
    expect(second.rawJson).toBe('{"signals":[{"b":2}]}');
    expect(delegate.extract).toHaveBeenCalledTimes(2);
  });
});

describe("resolveCompileSeedExtractionConfig", () => {
  it("resolves a null key when no garden secret ref is set", () => {
    const config = resolveCompileSeedExtractionConfig({
      OFFICIAL_API_GARDEN_MODEL: "gpt-5.4-mini"
    });
    expect(config.apiKey).toBeNull();
    expect(config.model).toBe("gpt-5.4-mini");
    expect(config.providerUrl).toBe("https://yunwu.ai/v1");
  });

  it("throws when neither env model nor manifest can resolve the model", () => {
    expect(() => resolveCompileSeedExtractionConfig({})).toThrow(
      /extraction model is unresolved/u
    );
  });

  it("falls back to the manifest extraction_model when env is unset", () => {
    const config = resolveCompileSeedExtractionConfig(
      {},
      {
        schema_version: 1,
        extraction_model: "gpt-5.4-mini",
        provider_url: "https://yunwu.ai/v1",
        system_prompt_sha256: "deadbeef",
        cache_key_algo: "sha256(model\\0systemPrompt\\0turnContent)",
        dataset: "longmemeval-s",
        dataset_revision: "rev",
        storage: "git-tracked",
        built_at: "2026-05-27T00:00:00Z",
        builder: "test"
      }
    );
    expect(config.model).toBe("gpt-5.4-mini");
    expect(config.providerUrl).toBe("https://yunwu.ai/v1");
  });
});

describe("createCompileSeedRunner — compile-based seed", () => {
  let cacheRoot: string;
  const SEED_CONTEXT = {
    workspaceId: "ws-test",
    runId: "run-test"
  };

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "compile-seed-runner-"));
  });

  afterEach(async () => {
    await rm(cacheRoot, { recursive: true, force: true });
  });

  function buildSeed(memoryId: string): SeededMemoryResult {
    return {
      memoryId,
      signalId: `signal-${memoryId}`,
      proposalId: `proposal-${memoryId}`,
      // The bench seeders attach a real evidence_capsule per durable memory;
      // synthesizing one here mirrors the production row the materializer
      // would have created. Tests that need the null-evidence branch can
      // pass it explicitly via the helper at module bottom (makeSeed).
      evidenceId: `evidence-${memoryId}`,
      truncated: false,
      charsClipped: 0
    };
  }

  it("produces N memory_entry object_ids for a multi-fact turn", async () => {
    const seeded: BenchSignalSeedInput[] = [];
    let counter = 0;
    const daemon = buildCompileSeedDaemon((input) => {
      seeded.push(input);
      counter += 1;
      return buildSeed(`memory-${counter}`);
    });
    const runner = createCompileSeedRunner({
      config: CREDENTIALLED_CONFIG,
      cacheRoot,
      extractorFactory: () => ({
        extract: async () => ({
          rawJson: signalsEnvelope([
            { distilled: "Alice lives in Berlin.", matched: "moved to Berlin" },
            {
              distilled: "Alice started her job on 2024-03-01.",
              matched: "started my job in March 2024"
            }
          ])
        })
      })
    });

    const result = await runner.seedTurn({
      daemon,
      turnContent: "I moved to Berlin and I started my job in March 2024.",
      evidenceRefBase: "q1-s0-t0",
      seedIndex: 0,
      ...SEED_CONTEXT
    });

    // Two extracted facts -> two memory_entry seeds.
    expect(result.seeds.map((seed) => seed.memoryId)).toEqual([
      "memory-1",
      "memory-2"
    ]);
    expect(seeded).toHaveLength(2);
    // Each seed carries the production-extracted resolved distilled_fact and
    // the full turn as evidence.
    expect(seeded.map((input) => input.distilledFact)).toEqual([
      "Alice lives in Berlin.",
      "Alice started her job on 2024-03-01."
    ]);
    expect(seeded.every((input) => input.turnContent.includes("Berlin"))).toBe(
      true
    );
    expect(
      seeded.every((input) => input.extractionProvider === "official_api_compile")
    ).toBe(true);
    // Distinct evidence refs keep the per-fact object_id 1:1.
    expect(seeded.map((input) => input.evidenceRef)).toEqual([
      "q1-s0-t0-f0",
      "q1-s0-t0-f1"
    ]);
    expect(runner.stats.path).toBe("official_api_compile");
    expect(runner.stats.factsProduced).toBe(2);
    expect(runner.stats.llmCalls).toBe(1);
    expect(runner.stats.liveExtractionFailures).toBe(0);
    expect(runner.stats.cachedExtractionFailures).toBe(0);
  });

  it("salvages valid signals when one envelope entry is corrupt — recovered, not a fallback", async () => {
    // Two clean entries straddle one corrupt entry (bad `\'` escape) so the
    // whole-envelope JSON.parse throws. Element-wise salvage recovers the
    // two clean siblings; the corrupt entry is dropped to parseDropped, and
    // NEITHER the cached/live failure counters NOR offline_fallbacks bump —
    // the turn is a successful extraction, so the release blocker still sees
    // a clean offline_fallbacks / failure count.
    const corruptEnvelope =
      `{"signals":[` +
      `{"signal_kind":"potential_preference","object_kind":"user_preference",` +
      `"confidence":0.9,"matched_text":"moved to Berlin","distilled_fact":"Alice lives in Berlin."},` +
      `{"signal_kind":"potential_preference","object_kind":"user_preference",` +
      `"confidence":0.8,"matched_text":"I\\'ll bring my dog","distilled_fact":"bad"},` +
      `{"signal_kind":"potential_preference","object_kind":"user_preference",` +
      `"confidence":0.9,"matched_text":"started my job","distilled_fact":"Alice started her job."}` +
      `]}`;
    expect(() => JSON.parse(corruptEnvelope)).toThrow();

    const seeded: BenchSignalSeedInput[] = [];
    let counter = 0;
    const daemon = buildCompileSeedDaemon((input) => {
      seeded.push(input);
      counter += 1;
      return buildSeed(`memory-${counter}`);
    });
    const runner = createCompileSeedRunner({
      config: CREDENTIALLED_CONFIG,
      cacheRoot,
      extractorFactory: () => ({
        extract: async () => ({ rawJson: corruptEnvelope })
      })
    });

    const result = await runner.seedTurn({
      daemon,
      turnContent: "I moved to Berlin and I started my job.",
      evidenceRefBase: "q1-s0-t0",
      seedIndex: 0,
      ...SEED_CONTEXT
    });

    // Two salvaged facts seeded — NOT one degraded full-turn fact.
    expect(result.seeds.map((seed) => seed.memoryId)).toEqual([
      "memory-1",
      "memory-2"
    ]);
    expect(seeded.map((input) => input.distilledFact)).toEqual([
      "Alice lives in Berlin.",
      "Alice started her job."
    ]);
    expect(
      seeded.every((input) => input.extractionProvider === "official_api_compile")
    ).toBe(true);
    // Recovered turn is a success: no failure-bucket increments.
    expect(runner.stats.cachedExtractionFailures).toBe(0);
    expect(runner.stats.liveExtractionFailures).toBe(0);
    expect(runner.stats.offlineFallbacks).toBe(0);
    expect(runner.stats.factsProduced).toBe(2);
    // The one dropped corrupt entry is attributed to parseDropped (raw=3,
    // parsed=2), so nothing is silently lost.
    expect(runner.stats.parseDropped).toBe(1);
    expect(runner.stats.signalsDropped).toBe(1);
    // The release blocker reads these stats; a recovered run is releasable on
    // the seed-extraction dimension (path stays official_api_compile, zero
    // offline fallbacks / failures).
    const kpi = toSeedExtractionPathKpi(runner.stats);
    expect(kpi.path).toBe("official_api_compile");
    expect(kpi.offline_fallbacks).toBe(0);
    expect(kpi.cached_extraction_failures).toBe(0);
    expect(kpi.parse_dropped).toBe(1);
  });

  it("falls back to the full turn when the envelope is degenerate (no complete entry)", async () => {
    // The only entry is truncated mid-string (max_tokens) — no complete
    // element survives salvage, so the turn correctly degrades to the
    // full-turn fallback and is NOT counted as a successful extraction.
    const degenerate =
      `{"signals":[{"signal_kind":"potential_preference","object_kind":"user_preference",` +
      `"confidence":0.9,"matched_text":"`;
    expect(() => JSON.parse(degenerate)).toThrow();

    const seeded: BenchSignalSeedInput[] = [];
    const daemon = buildCompileSeedDaemon((input) => {
      seeded.push(input);
      return buildSeed("memory-1");
    });
    const runner = createCompileSeedRunner({
      config: CREDENTIALLED_CONFIG,
      cacheRoot,
      extractorFactory: () => ({
        extract: async () => ({ rawJson: degenerate })
      })
    });

    const result = await runner.seedTurn({
      daemon,
      turnContent: "I moved to Berlin.",
      evidenceRefBase: "q1-s0-t0",
      seedIndex: 0,
      ...SEED_CONTEXT
    });

    // One degraded full-turn fact; the failure is counted (live source here,
    // since a fresh seedTurn live-extracts on cache miss).
    expect(result.seeds).toHaveLength(1);
    expect(seeded[0]?.distilledFact).toBe("I moved to Berlin.");
    expect(seeded[0]?.extractionProvider).toBe("no_credentials_fallback");
    expect(runner.stats.offlineFallbacks).toBe(1);
    expect(runner.stats.liveExtractionFailures).toBe(1);
    expect(runner.stats.cachedExtractionFailures).toBe(0);
  });

  it("seeds the full turn as one fact when the extractor finds no candidates", async () => {
    const seeded: BenchSignalSeedInput[] = [];
    const daemon = buildCompileSeedDaemon((input) => {
      seeded.push(input);
      return buildSeed("memory-1");
    });
    const runner = createCompileSeedRunner({
      config: CREDENTIALLED_CONFIG,
      cacheRoot,
      extractorFactory: () => ({
        extract: async () => ({ rawJson: '{"signals":[]}' })
      })
    });

    const result = await runner.seedTurn({
      daemon,
      turnContent: "ok thanks",
      evidenceRefBase: "q1-s0-t0",
      seedIndex: 0,
      ...SEED_CONTEXT
    });

    expect(result.seeds).toHaveLength(1);
    expect(seeded[0]?.distilledFact).toBe("ok thanks");
  });

  it("falls back to the full turn as one fact when no credentials are configured", async () => {
    const seeded: BenchSignalSeedInput[] = [];
    const daemon = buildCompileSeedDaemon((input) => {
      seeded.push(input);
      return buildSeed("memory-1");
    });
    const runner = createCompileSeedRunner({
      config: OFFLINE_CONFIG,
      cacheRoot
    });

    const result = await runner.seedTurn({
      daemon,
      turnContent: "First sentence. Second sentence. Third with the answer.",
      evidenceRefBase: "q1-s0-t0",
      seedIndex: 0,
      ...SEED_CONTEXT
    });

    expect(runner.stats.path).toBe("no_credentials_fallback");
    expect(result.seeds).toHaveLength(1);
    expect(seeded[0]?.distilledFact).toBe(
      "First sentence. Second sentence. Third with the answer."
    );
    expect(seeded[0]?.extractionProvider).toBe("no_credentials_fallback");
    expect(runner.stats.offlineFallbacks).toBe(1);
    expect(runner.stats.llmCalls).toBe(0);
  });

  it("falls back to the full turn as one fact when extraction throws", async () => {
    const seeded: BenchSignalSeedInput[] = [];
    const daemon = buildCompileSeedDaemon((input) => {
      seeded.push(input);
      return buildSeed("memory-1");
    });
    const runner = createCompileSeedRunner({
      config: CREDENTIALLED_CONFIG,
      cacheRoot,
      extractorFactory: () => ({
        extract: async () => {
          throw new Error("garden extraction HTTP 500");
        }
      })
    });

    const result = await runner.seedTurn({
      daemon,
      turnContent: "A turn whose extraction will fail.",
      evidenceRefBase: "q1-s0-t0",
      seedIndex: 0,
      ...SEED_CONTEXT
    });

    expect(result.seeds).toHaveLength(1);
    expect(seeded[0]?.distilledFact).toBe("A turn whose extraction will fail.");
    expect(runner.stats.offlineFallbacks).toBe(1);
    expect(runner.stats.cacheHits).toBe(0);
    expect(runner.stats.llmCalls).toBe(0);
    expect(runner.stats.liveExtractionFailures).toBe(1);
    expect(runner.stats.cachedExtractionFailures).toBe(0);
    expect(toSeedExtractionPathKpi(runner.stats)).toMatchObject({
      offline_fallbacks: 1,
      live_extraction_failures: 1,
      cached_extraction_failures: 0
    });
  });

  it("classifies cached invalid raw JSON separately from live failures", async () => {
    const turnContent = "A turn whose cached raw JSON is malformed.";
    const firstDaemon = buildCompileSeedDaemon(() => buildSeed("memory-1"));
    const firstRunner = createCompileSeedRunner({
      config: CREDENTIALLED_CONFIG,
      cacheRoot,
      extractorFactory: () => ({
        extract: async () => ({ rawJson: '{"not_signals":[]}' })
      })
    });
    await firstRunner.seedTurn({
      daemon: firstDaemon,
      turnContent,
      evidenceRefBase: "q1-s0-t0",
      seedIndex: 0,
      ...SEED_CONTEXT
    });

    const delegate = vi.fn(async () => ({ rawJson: signalsEnvelope([]) }));
    const seeded: BenchSignalSeedInput[] = [];
    const secondDaemon = buildCompileSeedDaemon((input) => {
      seeded.push(input);
      return buildSeed("memory-2");
    });
    const secondRunner = createCompileSeedRunner({
      config: CREDENTIALLED_CONFIG,
      cacheRoot,
      extractorFactory: () => ({ extract: delegate })
    });

    const result = await secondRunner.seedTurn({
      daemon: secondDaemon,
      turnContent,
      evidenceRefBase: "q1-s0-t0",
      seedIndex: 0,
      ...SEED_CONTEXT
    });

    expect(result.seeds).toHaveLength(1);
    expect(seeded[0]?.distilledFact).toBe(turnContent);
    expect(delegate).not.toHaveBeenCalled();
    expect(secondRunner.stats.cacheHits).toBe(1);
    expect(secondRunner.stats.llmCalls).toBe(0);
    expect(secondRunner.stats.offlineFallbacks).toBe(1);
    expect(secondRunner.stats.liveExtractionFailures).toBe(0);
    expect(secondRunner.stats.cachedExtractionFailures).toBe(1);
    expect(toSeedExtractionPathKpi(secondRunner.stats)).toMatchObject({
      cache_hits: 1,
      llm_calls: 0,
      offline_fallbacks: 1,
      live_extraction_failures: 0,
      cached_extraction_failures: 1
    });
  });

  it("maps ALL N seeded object_ids back to the source answer turn (sidecar)", async () => {
    let counter = 0;
    const daemon = buildCompileSeedDaemon(() => {
      counter += 1;
      return buildSeed(`memory-${counter}`);
    });
    const runner = createCompileSeedRunner({
      config: CREDENTIALLED_CONFIG,
      cacheRoot,
      extractorFactory: () => ({
        extract: async () => ({
          rawJson: signalsEnvelope([
            { distilled: "Fact A.", matched: "a" },
            { distilled: "Fact B.", matched: "b" },
            { distilled: "Fact C.", matched: "c" }
          ])
        })
      })
    });

    const sidecar = new Map<string, { sessionId: string; hasAnswer: boolean }>();
    const result = await runner.seedTurn({
      daemon,
      turnContent: "compound answer turn",
      evidenceRefBase: "q1-s0-t0",
      seedIndex: 0,
      ...SEED_CONTEXT
    });
    for (const seed of result.seeds) {
      sidecar.set(seed.memoryId, { sessionId: "session-answer", hasAnswer: true });
    }

    // All three extracted facts of the answer turn map into the sidecar — a
    // partial map would silently undercount recall.
    expect(sidecar.size).toBe(3);
    expect([...sidecar.keys()]).toEqual(["memory-1", "memory-2", "memory-3"]);
    expect(
      [...sidecar.values()].every(
        (entry) => entry.hasAnswer && entry.sessionId === "session-answer"
      )
    ).toBe(true);
  });
});

describe("extraction cache key — load-bearing inputs only", () => {
  let cacheRoot: string;

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "compile-seed-cachekey-"));
  });

  afterEach(async () => {
    await rm(cacheRoot, { recursive: true, force: true });
  });

  // The provider assembles userPrompt as
  // JSON.stringify({workspace_id, run_id, surface_id, turn_content, ...}).
  // crossquestion.ts stamps run_id with a wall clock, so two runs of the
  // same turn differ in run_id; the cache key must ignore it.
  function userPromptFor(turn: string, runId: string): string {
    return JSON.stringify({
      workspace_id: "ws-1",
      run_id: runId,
      surface_id: null,
      turn_content: turn,
      turn_messages: []
    });
  }

  it("hits the cache for the same turn under a different run_id", async () => {
    const delegate: BenchSignalExtractor = {
      extract: vi.fn(async () => ({ rawJson: '{"signals":[]}' }))
    };
    const firstStats: CompileSeedExtractionStats = {
      path: "official_api_compile",
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
      lastExtractionSource: null
    };
    const firstRun = createCachingSignalExtractor({
      delegate,
      model: "test-model",
      cacheRoot,
      stats: firstStats
    });
    await firstRun.extract({
      systemPrompt: "sys",
      userPrompt: userPromptFor("I moved to Berlin.", "run-cq-abc-1700000000000")
    });
    expect(delegate.extract).toHaveBeenCalledTimes(1);
    expect(firstStats.llmCalls).toBe(1);

    // Same turn, a different wall-clock run_id — must be served from the
    // fixture with zero LLM calls. A run_id in the cache key would make
    // this a guaranteed miss and the committed fixture dead.
    const secondStats: CompileSeedExtractionStats = {
      path: "official_api_compile",
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
      lastExtractionSource: null
    };
    const secondRun = createCachingSignalExtractor({
      delegate,
      model: "test-model",
      cacheRoot,
      stats: secondStats
    });
    const cached = await secondRun.extract({
      systemPrompt: "sys",
      userPrompt: userPromptFor("I moved to Berlin.", "run-cq-abc-1799999999999")
    });

    expect(delegate.extract).toHaveBeenCalledTimes(1);
    expect(secondStats.cacheHits).toBe(1);
    expect(secondStats.llmCalls).toBe(0);
    expect(cached.rawJson).toBe('{"signals":[]}');
  });

  it("still misses when the turn_content itself changes", async () => {
    const delegate: BenchSignalExtractor = {
      extract: vi
        .fn<BenchSignalExtractor["extract"]>()
        .mockResolvedValueOnce({ rawJson: '{"signals":[{"a":1}]}' })
        .mockResolvedValueOnce({ rawJson: '{"signals":[{"b":2}]}' })
    };
    const extractor = createCachingSignalExtractor({
      delegate,
      model: "test-model",
      cacheRoot
    });
    await extractor.extract({
      systemPrompt: "sys",
      userPrompt: userPromptFor("Turn one.", "run-1")
    });
    await extractor.extract({
      systemPrompt: "sys",
      userPrompt: userPromptFor("Turn two.", "run-1")
    });
    expect(delegate.extract).toHaveBeenCalledTimes(2);
  });
});

describe("bench evidence capsule — production-faithful span", () => {
  let cacheRoot: string;

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "compile-seed-evidence-"));
  });

  afterEach(async () => {
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("seeds the matched_text span as evidence, not the full turn", async () => {
    const seeded: BenchSignalSeedInput[] = [];
    const daemon = buildCompileSeedDaemon((input) => {
      seeded.push(input);
      return {
        memoryId: "memory-1",
        signalId: "signal-1",
        proposalId: "proposal-1",
        evidenceId: "evidence-1",
        truncated: false,
        charsClipped: 0
      };
    });
    const runner = createCompileSeedRunner({
      config: CREDENTIALLED_CONFIG,
      cacheRoot,
      extractorFactory: () => ({
        extract: async () => ({
          rawJson: signalsEnvelope([
            { distilled: "Alice lives in Berlin.", matched: "I moved to Berlin" }
          ])
        })
      })
    });

    const fullTurn =
      "Yesterday I moved to Berlin and it has been a long week of unpacking.";
    await runner.seedTurn({
      daemon,
      turnContent: fullTurn,
      evidenceRefBase: "q1-s0-t0",
      seedIndex: 0,
      workspaceId: "ws-test",
      runId: "run-test"
    });

    expect(seeded).toHaveLength(1);
    const raw = seeded[0]?.productionRawPayload;
    expect(raw).toBeDefined();
    // The bench forwards compile()'s CONTENT-bearing raw_payload but strips
    // the schema-grounding block (it pins detected_object.object_kind to the
    // pre-canonicalization extracted kind — see stripSchemaGrounding). The
    // load-bearing matched_text span survives: completeGardenTask's
    // normalizeSchemaGroundedSignal re-grounds the signal from it, and
    // production buildSignalSummary falls back to raw_payload.matched_text.
    // It is the SAME span production materializes — NOT the full turn.
    expect(raw?.matched_text).toBe("I moved to Berlin");
    expect(raw?.matched_text).not.toBe(fullTurn);
    // The pre-strip schema-grounding keys are gone; the original
    // LLM-extracted object_kind is preserved for audit fidelity.
    expect(raw?.schema_grounding).toBeUndefined();
    expect(raw?.detected_object).toBeUndefined();
    expect(raw?.field_candidates).toBeUndefined();
    expect(raw?.validation_result).toBeUndefined();
    expect(raw?.extracted_object_kind).toBe("user_preference");
  });

  it("carries the full turn only on the no-credentials fallback", async () => {
    const seeded: BenchSignalSeedInput[] = [];
    const daemon = buildCompileSeedDaemon((input) => {
      seeded.push(input);
      return {
        memoryId: "memory-1",
        signalId: "signal-1",
        proposalId: "proposal-1",
        evidenceId: "evidence-1",
        truncated: false,
        charsClipped: 0
      };
    });
    const runner = createCompileSeedRunner({
      config: OFFLINE_CONFIG,
      cacheRoot
    });
    await runner.seedTurn({
      daemon,
      turnContent: "A full degraded-path turn.",
      evidenceRefBase: "q1-s0-t0",
      seedIndex: 0,
      workspaceId: "ws-test",
      runId: "run-test"
    });
    // The degraded path has no production raw_payload; it honestly carries
    // the full turn (and is labelled no_credentials_fallback).
    expect(seeded[0]?.productionRawPayload).toBeUndefined();
    expect(seeded[0]?.turnContent).toBe("A full degraded-path turn.");
  });
});

describe("compile() signal-drop count is observable", () => {
  let cacheRoot: string;

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "compile-seed-drops-"));
  });

  afterEach(async () => {
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("counts signals compile() dropped as oversized (compile_overflow_dropped)", async () => {
    let counter = 0;
    const daemon = buildCompileSeedDaemon(() => {
      counter += 1;
      return {
        memoryId: `memory-${counter}`,
        signalId: `signal-${counter}`,
        proposalId: `proposal-${counter}`,
        evidenceId: `evidence-${counter}`,
        truncated: false,
        charsClipped: 0
      };
    });
    // The middle signal's matched_text is a real ~4500-char span of the
    // turn. The parser clamps it to 4000, but schema-grounding then triples
    // it (field_candidates value + evidence) and the turn_content_excerpt is
    // built from the same long span — the assembled raw_payload overflows
    // the protocol 16 KB cap, so compile() drops that one signal and returns
    // the two survivors. The drop must be counted, not silent.
    const oversizedSpan = "lorem ipsum dolor ".repeat(260); // ~4680 chars
    const turnContent = `Intro sentence. ${oversizedSpan} Closing sentence.`;
    const runner = createCompileSeedRunner({
      config: CREDENTIALLED_CONFIG,
      cacheRoot,
      extractorFactory: () => ({
        extract: async () => ({
          rawJson: JSON.stringify({
            signals: [
              {
                signal_kind: "potential_preference",
                object_kind: "user_preference",
                confidence: 0.9,
                matched_text: "Intro sentence",
                distilled_fact: "Survivor one."
              },
              {
                signal_kind: "potential_preference",
                object_kind: "user_preference",
                confidence: 0.9,
                matched_text: oversizedSpan.trim(),
                distilled_fact: "Oversized signal."
              },
              {
                signal_kind: "potential_preference",
                object_kind: "user_preference",
                confidence: 0.9,
                matched_text: "Closing sentence",
                distilled_fact: "Survivor two."
              }
            ]
          })
        })
      })
    });

    const result = await runner.seedTurn({
      daemon,
      turnContent,
      evidenceRefBase: "q1-s0-t0",
      seedIndex: 0,
      workspaceId: "ws-test",
      runId: "run-test"
    });

    // Two survivors seeded; the oversized signal is dropped INSIDE compile().
    // It is a compile-overflow drop — all 3 parsed cleanly, so parse_dropped
    // stays 0; the single loss is on the compile_overflow_dropped leg.
    expect(result.seeds).toHaveLength(2);
    expect(runner.stats.compileOverflowDropped).toBe(1);
    expect(runner.stats.parseDropped).toBe(0);
    expect(runner.stats.signalsDropped).toBe(1);
    expect(runner.stats.factsProduced).toBe(2);
  });

  it("counts malformed entries the parser dropped (parse_dropped)", async () => {
    // Regression: parseOfficialApiSignals silently discards a malformed
    // single entry BEFORE compile() iterates. A drop counter that uses
    // parseOfficialApiSignals(rawJson).length as the draft count never
    // sees a parser-stage drop — only the compile overflow leg.
    // signals_dropped must count the malformed entry too.
    let counter = 0;
    const daemon = buildCompileSeedDaemon(() => {
      counter += 1;
      return {
        memoryId: `memory-${counter}`,
        signalId: `signal-${counter}`,
        proposalId: `proposal-${counter}`,
        evidenceId: `evidence-${counter}`,
        truncated: false,
        charsClipped: 0
      };
    });
    const runner = createCompileSeedRunner({
      config: CREDENTIALLED_CONFIG,
      cacheRoot,
      extractorFactory: () => ({
        extract: async () => ({
          // The model envelope carries 3 raw signals. The middle one is
          // malformed — its signal_kind is not a recognised enum value —
          // so parseOfficialApiSignalEntry returns null and it never
          // reaches compile(). The two well-formed entries survive.
          rawJson: JSON.stringify({
            signals: [
              {
                signal_kind: "potential_preference",
                object_kind: "user_preference",
                confidence: 0.9,
                matched_text: "Intro span",
                distilled_fact: "Survivor one."
              },
              {
                signal_kind: "not_a_real_signal_kind",
                object_kind: "user_preference",
                confidence: 0.9,
                matched_text: "Malformed span",
                distilled_fact: "Malformed entry."
              },
              {
                signal_kind: "potential_preference",
                object_kind: "user_preference",
                confidence: 0.9,
                matched_text: "Closing span",
                distilled_fact: "Survivor two."
              }
            ]
          })
        })
      })
    });

    const result = await runner.seedTurn({
      daemon,
      turnContent: "Intro span. Some content. Closing span.",
      evidenceRefBase: "q1-s0-t0",
      seedIndex: 0,
      workspaceId: "ws-test",
      runId: "run-test"
    });

    // Two survivors seeded; the malformed entry is the parse-stage drop.
    expect(result.seeds).toHaveLength(2);
    expect(runner.stats.parseDropped).toBe(1);
    expect(runner.stats.compileOverflowDropped).toBe(0);
    expect(runner.stats.signalsDropped).toBe(1);
    expect(runner.stats.factsProduced).toBe(2);
  });

  it("isolates per-signal materialization drops by reason and keeps healthy batch-mates", async () => {
    // Regression for the 1963-signal whole-batch drop: when some signals of a
    // turn fail to materialize a memory_entry (candidate_absent) or throw before
    // memory_entry creation and are isolated per-signal (materialization_error),
    // the turn's HEALTHY batch-mates must still seed, and each drop must be
    // attributed by reason in the stats so candidate-absent / seed-quality is
    // root-causable from the KPI archive — not just stderr.
    const daemon: CompileSeedDaemon = {
      proposeMemoryFromSignal: async () => ({
        memoryId: "memory-fallback",
        signalId: "signal-fallback",
        proposalId: "proposal-fallback",
        evidenceId: "evidence-fallback",
        truncated: false,
        charsClipped: 0
      }),
      // Three clean facts arrive; the daemon seeds the first, drops the second
      // as candidate_absent, drops the third as materialization_error.
      proposeMemoriesFromCompileSignals: async () => ({
        seeds: [
          {
            memoryId: "memory-1",
            signalId: "signal-1",
            proposalId: "proposal-1",
            evidenceId: "evidence-1",
            truncated: false,
            charsClipped: 0
          }
        ],
        dropped: [
          { reason: "candidate_absent", detail: "triage=accepted routing=evidence archival" },
          { reason: "materialization_error", detail: "boom" }
        ]
      }),
      proposeSynthesis: async () => ({ synthesisId: null })
    };
    const runner = createCompileSeedRunner({
      config: CREDENTIALLED_CONFIG,
      cacheRoot,
      extractorFactory: () => ({
        extract: async () => ({
          rawJson: signalsEnvelope([
            { distilled: "Survivor.", matched: "Intro span" },
            { distilled: "Absent.", matched: "Middle span" },
            { distilled: "Threw.", matched: "Closing span" }
          ])
        })
      })
    });

    const result = await runner.seedTurn({
      daemon,
      turnContent: "Intro span. Middle span. Closing span.",
      evidenceRefBase: "q1-s0-t0",
      seedIndex: 0,
      workspaceId: "ws-test",
      runId: "run-test"
    });

    // The one healthy fact seeded — the two failures did NOT drop it.
    expect(result.seeds).toHaveLength(1);
    expect(result.seeds[0]?.memoryId).toBe("memory-1");
    // Both materialization-seam drops are counted, attributed by reason.
    expect(runner.stats.signalsDropped).toBe(2);
    expect(runner.stats.signalsDroppedByReason).toEqual({
      candidate_absent: 1,
      materialization_error: 1
    });
    // No extraction-stage drops on this clean envelope.
    expect(runner.stats.parseDropped).toBe(0);
    expect(runner.stats.compileOverflowDropped).toBe(0);

    // The per-reason ledger surfaces in the persisted KPI.
    const kpi = toSeedExtractionPathKpi(runner.stats);
    expect(kpi.signals_dropped_by_reason).toEqual({
      candidate_absent: 1,
      materialization_error: 1
    });
    expect(kpi.signals_dropped).toBe(2);
  });

  it("fails closed when a compile seed memory materializes but accept fails", async () => {
    const daemon: CompileSeedDaemon = {
      proposeMemoryFromSignal: async () => {
        throw new Error("fallback path should not run");
      },
      proposeMemoriesFromCompileSignals: async () => {
        throw createUnscoredMaterializedSeedError({
          memoryId: "memory-created-before-accept-failed",
          evidenceRef: "q1-s0-t0",
          cause: new Error("review tail failed")
        });
      },
      proposeSynthesis: async () => ({ synthesisId: null })
    };
    const runner = createCompileSeedRunner({
      config: CREDENTIALLED_CONFIG,
      cacheRoot,
      extractorFactory: () => ({
        extract: async () => ({
          rawJson: signalsEnvelope([{ distilled: "Created but unaccepted.", matched: "Intro span" }])
        })
      })
    });

    await expect(
      runner.seedTurn({
        daemon,
        turnContent: "Intro span.",
        evidenceRefBase: "q1-s0-t0",
        seedIndex: 0,
        workspaceId: "ws-test",
        runId: "run-test"
      })
    ).rejects.toThrow(/recallable unscored seed memory/);

    expect(runner.stats.signalsDropped).toBe(0);
    expect(runner.stats.signalsDroppedByReason).toEqual({
      candidate_absent: 0,
      materialization_error: 0
    });
  });

  it("fails closed in no-credentials fallback when a seed memory materializes but accept fails", async () => {
    const daemon: CompileSeedDaemon = {
      proposeMemoryFromSignal: async () => {
        throw createUnscoredMaterializedSeedError({
          memoryId: "fallback-memory-created-before-accept-failed",
          evidenceRef: "q1-s0-t0",
          cause: new Error("fallback review tail failed")
        });
      },
      proposeMemoriesFromCompileSignals: async () => {
        throw new Error("credentialled compile path should not run");
      },
      proposeSynthesis: async () => ({ synthesisId: null })
    };
    const runner = createCompileSeedRunner({
      config: OFFLINE_CONFIG,
      cacheRoot
    });

    await expect(
      runner.seedTurn({
        daemon,
        turnContent: "Intro span.",
        evidenceRefBase: "q1-s0-t0",
        seedIndex: 0,
        workspaceId: "ws-test",
        runId: "run-test"
      })
    ).rejects.toThrow(/recallable unscored seed memory/);

    expect(runner.stats.signalsDropped).toBe(0);
    expect(runner.stats.signalsDroppedByReason).toEqual({
      candidate_absent: 0,
      materialization_error: 0
    });
  });
});

describe("extraction cache write is atomic", () => {
  let cacheRoot: string;

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "compile-seed-atomic-"));
  });

  afterEach(async () => {
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("never leaves a partially-written shard on the final path", async () => {
    // A delegate whose response is large enough that a torn write would be
    // visibly partial. The write-tmp-then-rename discipline means the final
    // shard is always whole, parseable JSON with the complete raw_json.
    const bigRawJson = JSON.stringify({
      signals: Array.from({ length: 200 }, (_, i) => ({
        signal_kind: "potential_preference",
        object_kind: "user_preference",
        confidence: 0.9,
        matched_text: `span ${i}`,
        distilled_fact: `Fact number ${i}.`
      }))
    });
    const delegate: BenchSignalExtractor = {
      extract: vi.fn(async () => ({ rawJson: bigRawJson }))
    };
    const extractor = createCachingSignalExtractor({
      delegate,
      model: "test-model",
      cacheRoot
    });
    await extractor.extract({ systemPrompt: "sys", userPrompt: "atomic-turn" });

    const cacheKey = createHash("sha256")
      .update("test-model", "utf8")
      .update("\u0000", "utf8")
      .update("sys", "utf8")
      .update("\u0000", "utf8")
      .update("atomic-turn", "utf8")
      .digest("hex");
    const shardPath = join(cacheRoot, cacheKey.slice(0, 2), `${cacheKey}.json`);
    const onDisk = JSON.parse(readFileSync(shardPath, "utf8")) as {
      raw_json: string;
    };
    expect(onDisk.raw_json).toBe(bigRawJson);

    // The fixture is reused on a second extractor with zero LLM calls — only
    // possible if the shard landed whole.
    const reread = createCachingSignalExtractor({
      delegate,
      model: "test-model",
      cacheRoot
    });
    const second = await reread.extract({
      systemPrompt: "sys",
      userPrompt: "atomic-turn"
    });
    expect(second.rawJson).toBe(bigRawJson);
    expect(delegate.extract).toHaveBeenCalledTimes(1);
  });
});

describe("userPrompt shape contract — cache key turn_content dependency", () => {
  let cacheRoot: string;

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "compile-seed-promptshape-"));
  });

  afterEach(async () => {
    await rm(cacheRoot, { recursive: true, force: true });
  });

  // The extraction cache key hashes only the load-bearing turn_content,
  // recovered by parsing the userPrompt JSON the production
  // OfficialApiGardenProvider assembles. If a future compute-provider.ts
  // change renames or restructures the turn_content field,
  // extractTurnContent silently falls through to hashing the WHOLE
  // userPrompt — which embeds the wall-clock run_id, making every run a
  // 100% cache miss and the committed fixture dead. These tests drive the
  // REAL provider so that shape change fails a test instead of silently
  // degrading the cache.

  it("the production provider's userPrompt carries turn_content as a top-level string", async () => {
    let capturedUserPrompt: string | null = null;
    const capturingExtractor: BenchSignalExtractor = {
      extract: async (input) => {
        capturedUserPrompt = input.userPrompt;
        return { rawJson: '{"signals":[]}' };
      }
    };
    const provider = new OfficialApiGardenProvider({
      apiKey: "test-key",
      model: "test-model",
      extractor: capturingExtractor
    });

    await provider.compile("I moved to Berlin last spring.", {
      workspace_id: "ws-1",
      run_id: "run-cq-abc-1700000000000",
      surface_id: null,
      turn_messages: []
    });

    expect(capturedUserPrompt).not.toBeNull();
    const parsed = JSON.parse(capturedUserPrompt as unknown as string) as Record<
      string,
      unknown
    >;
    // The cache key (createCachingSignalExtractor / extractTurnContent)
    // reads `turn_content`. If this assertion fails, the provider changed
    // its userPrompt shape and the bench cache must be updated in lockstep.
    expect(typeof parsed.turn_content).toBe("string");
    expect(parsed.turn_content).toBe("I moved to Berlin last spring.");
  });

  it("the cache hits for the same turn across a different run_id, end to end", async () => {
    // Full-chain check: the real provider builds the userPrompt, the real
    // caching extractor derives the key. A second compile() of the SAME
    // turn under a DIFFERENT wall-clock run_id must be served from the
    // fixture with zero delegate calls — only true if the key ignores
    // run_id, which depends on extractTurnContent recovering turn_content.
    const delegate: BenchSignalExtractor = {
      extract: vi.fn(async () => ({ rawJson: '{"signals":[]}' }))
    };
    const cachingExtractor = createCachingSignalExtractor({
      delegate,
      model: "test-model",
      cacheRoot
    });
    const provider = new OfficialApiGardenProvider({
      apiKey: "test-key",
      model: "test-model",
      extractor: cachingExtractor
    });

    await provider.compile("I moved to Berlin last spring.", {
      workspace_id: "ws-1",
      run_id: "run-cq-abc-1700000000000",
      surface_id: null,
      turn_messages: []
    });
    expect(delegate.extract).toHaveBeenCalledTimes(1);

    await provider.compile("I moved to Berlin last spring.", {
      workspace_id: "ws-1",
      run_id: "run-cq-abc-1799999999999",
      surface_id: null,
      turn_messages: []
    });
    // Still 1 — the second turn was a cache hit despite the new run_id.
    expect(delegate.extract).toHaveBeenCalledTimes(1);
  });
});

function makeSeed(memoryId: string): SeededMemoryResult {
  return {
    memoryId,
    signalId: `signal-${memoryId}`,
    proposalId: `proposal-${memoryId}`,
    evidenceId: `evidence-${memoryId}`,
    truncated: false,
    charsClipped: 0
  };
}

describe("computeNextTurnSeedRefs — D-1 single-id fan-out invariant", () => {
  // invariant: every assertion in this block guards the N x M edge-blowup
  // ceiling described in the helper anchor. A regression that re-introduces
  // the union-of-every-fact behavior must surface here, not in a
  // multi-hour bench.
  // see also: apps/bench-runner/src/longmemeval/compile-seed.ts
  //   computeNextTurnSeedRefs

  it("returns [] when the current turn produced no seeds", () => {
    expect(
      computeNextTurnSeedRefs({ seeds: [] })
    ).toEqual([]);
  });

  it("returns exactly the first seed id when the current turn has one fact", () => {
    expect(
      computeNextTurnSeedRefs({ seeds: [makeSeed("memory-a")] })
    ).toEqual(["memory-a"]);
  });

  it("returns only the first seed id when the current turn has many facts (no N-fact union)", () => {
    // invariant: length is always 0 or 1, never N. This is the load-bearing
    // bound for the WSL2 500q runs.
    const seeds = [
      makeSeed("memory-a"),
      makeSeed("memory-b"),
      makeSeed("memory-c"),
      makeSeed("memory-d")
    ];
    const refs = computeNextTurnSeedRefs({ seeds });
    expect(refs).toEqual(["memory-a"]);
    expect(refs.length).toBeLessThanOrEqual(1);
  });

  it("models a multi-turn session: refs grow at most 1-per-turn and first turn carries none", () => {
    // Caller pattern: previousTurnSeedMemoryIds starts [], updates via
    // computeNextTurnSeedRefs after each seedTurn. Turn 0 always emits
    // with sourceMemoryRefs omitted (the [] sentinel maps to undefined in
    // the spread); turn N>=1 emits with exactly one ref (its predecessor's
    // first seed).
    const turns = [
      { seeds: [makeSeed("t0-a"), makeSeed("t0-b")] },
      { seeds: [makeSeed("t1-a"), makeSeed("t1-b"), makeSeed("t1-c")] },
      { seeds: [makeSeed("t2-a"), makeSeed("t2-b")] },
      { seeds: [] }, // a turn that produced no facts at all
      { seeds: [makeSeed("t4-a")] }
    ];
    let prev: readonly string[] = [];
    const observedSourceRefs: (readonly string[] | undefined)[] = [];
    for (const turn of turns) {
      observedSourceRefs.push(prev.length === 0 ? undefined : prev);
      prev = computeNextTurnSeedRefs(turn);
    }
    expect(observedSourceRefs).toEqual([
      undefined,         // turn 0: no predecessor
      ["t0-a"],          // turn 1: only the FIRST seed of turn 0
      ["t1-a"],          // turn 2: only the FIRST seed of turn 1
      ["t2-a"],          // turn 3: only the FIRST seed of turn 2
      undefined          // turn 4: predecessor produced zero seeds -> reset
    ]);
    for (const refs of observedSourceRefs) {
      // invariant: cardinality is the load-bearing bound.
      expect((refs ?? []).length).toBeLessThanOrEqual(1);
    }
  });

  it("session-boundary semantics: caller resets prev to [] across sessions, first turn of session 2 is undefined", () => {
    // The bench runners hold `previousTurnSeedMemoryIds` in the per-session
    // scope. Re-entering the inner loop for a new session starts from [],
    // mirroring the very first turn of the run. This test pins that the
    // helper alone is consistent with that caller contract: a fresh [] in
    // produces a sourceMemoryRefs-undefined spread for the next call.
    const session1Refs = computeNextTurnSeedRefs({
      seeds: [makeSeed("s1-t0-a"), makeSeed("s1-t0-b")]
    });
    expect(session1Refs).toEqual(["s1-t0-a"]);
    // Caller flips to the next session, which re-initializes prev to [].
    const session2Prev: readonly string[] = [];
    expect(session2Prev.length).toBe(0);
    // The first turn of session 2 emits with undefined sourceMemoryRefs
    // (the runners use `prev.length === 0 ? {} : { sourceMemoryRefs: prev }`).
    const session2EmitSpread = session2Prev.length === 0
      ? ({} as { sourceMemoryRefs?: readonly string[] })
      : { sourceMemoryRefs: session2Prev };
    expect(session2EmitSpread.sourceMemoryRefs).toBeUndefined();
  });
});

// Phase A.1 instrument coverage: a seed-side extraction failure must drop one
// diagnostic JSON file carrying cache_key_prefix / model / provider so a
// Phase A.2 preflight reader can attribute the failure to a specific cache
// shard or live call without re-running the bench.
describe("compile-seed diagnostic dump (Phase A.1 instrument)", () => {
  let cacheRoot: string;
  let diagnosticDir: string;

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "compile-seed-diag-cache-"));
    diagnosticDir = await mkdtemp(join(tmpdir(), "compile-seed-diag-"));
  });

  afterEach(async () => {
    await rm(cacheRoot, { recursive: true, force: true });
    await rm(diagnosticDir, { recursive: true, force: true });
  });

  it("writes a compile-seed-*.json dump carrying cache_key_prefix when live extraction fails", async () => {
    const config: CompileSeedExtractionConfig = {
      providerUrl: "https://example.test/v1",
      model: "gpt-test-mini",
      apiKey: "test-key"
    };
    const daemon: CompileSeedDaemon = {
      proposeMemoryFromSignal: async (_input) => ({
        memoryId: "memory-1",
        signalId: "signal-memory-1",
        proposalId: "proposal-memory-1",
        evidenceId: "evidence-memory-1",
        truncated: false,
        charsClipped: 0
      }),
      proposeMemoriesFromCompileSignals: async () => ({ seeds: [], dropped: [] }),
      proposeSynthesis: async () => ({ synthesisId: null })
    };
    const runner = createCompileSeedRunner({
      config,
      cacheRoot,
      diagnosticDir,
      extractorFactory: () => ({
        extract: async () => {
          throw new Error("garden extraction HTTP 500 from provider");
        }
      })
    });

    await runner.seedTurn({
      daemon,
      turnContent: "Turn whose extraction blows up.",
      evidenceRefBase: "q1-s0-t0",
      seedIndex: 0,
      workspaceId: "ws-test",
      runId: "run-test"
    });

    const dumpFiles = readdirSync(diagnosticDir).filter(
      (f) => f.startsWith("compile-seed-") && f.endsWith(".json")
    );
    expect(dumpFiles).toHaveLength(1);
    const dump = JSON.parse(
      readFileSync(join(diagnosticDir, dumpFiles[0]!), "utf8")
    ) as Record<string, unknown>;

    expect(dump).toMatchObject({
      surface: "compile-seed",
      provider_kind: "official_api",
      model_id: "gpt-test-mini",
      workspace_id: "ws-test",
      run_id: "run-test",
      last_extraction_source: "live",
      live_extraction_failures: 1,
      cached_extraction_failures: 0
    });
    // cache_key_prefix is the 12-char SHA-256 prefix the caching extractor
    // recorded onto stats.lastCacheKey before the delegate threw.
    expect(typeof dump.cache_key_prefix).toBe("string");
    expect((dump.cache_key_prefix as string).length).toBe(12);
    expect((dump.cache_key_prefix as string)).toMatch(/^[0-9a-f]{12}$/u);
    expect(typeof dump.error_message).toBe("string");
    // The seed-side dump receives the wrapped GardenProviderError (the
    // OfficialApiGardenProvider maps the transport HTTP 500 onto
    // "invalid_response"). The underlying HTTP 500 is in the provider-side
    // dump's `response_status` field, not in the bench-side error_message
    // string.
    expect((dump.error_message as string)).toContain(
      "Official garden provider returned an invalid response."
    );
  });

  it("does not write a dump when diagnosticDir is null (instrument disabled)", async () => {
    const config: CompileSeedExtractionConfig = {
      providerUrl: "https://example.test/v1",
      model: "gpt-test-mini",
      apiKey: "test-key"
    };
    const daemon: CompileSeedDaemon = {
      proposeMemoryFromSignal: async () => ({
        memoryId: "memory-1",
        signalId: "signal-memory-1",
        proposalId: "proposal-memory-1",
        evidenceId: "evidence-memory-1",
        truncated: false,
        charsClipped: 0
      }),
      proposeMemoriesFromCompileSignals: async () => ({ seeds: [], dropped: [] }),
      proposeSynthesis: async () => ({ synthesisId: null })
    };
    const runner = createCompileSeedRunner({
      config,
      cacheRoot,
      diagnosticDir: null,
      extractorFactory: () => ({
        extract: async () => {
          throw new Error("garden extraction HTTP 502");
        }
      })
    });

    await runner.seedTurn({
      daemon,
      turnContent: "Another failing turn.",
      evidenceRefBase: "q2-s0-t0",
      seedIndex: 0,
      workspaceId: "ws-test",
      runId: "run-test"
    });

    // diagnosticDir was created by beforeEach but never written to.
    const dumpFiles = readdirSync(diagnosticDir).filter(
      (f) => f.startsWith("compile-seed-") && f.endsWith(".json")
    );
    expect(dumpFiles).toHaveLength(0);
    // The classification path still ran so liveExtractionFailures is bumped.
    expect(runner.stats.liveExtractionFailures).toBe(1);
  });
});

// invariant: the bench HTTP transport (createGardenHttpExtractor) must mirror
// the production pi-mono-extractor retry policy — 3 retries on 5xx / 429 /
// unknown transport, 1 retry on timeout, no retry on 4xx-non-429. Before
// v0.3.11 this layer had ZERO retries, so a transient yunwu.ai burst that the
// production transport would recover silently demoted the bench archive to
// the no-credentials fallback path.
// see also: packages/soul/src/garden/pi-mono-extractor.ts MAX_EXTRACTOR_RETRIES
describe("createGardenHttpExtractor retry policy", () => {
  const HTTP_CONFIG: CompileSeedExtractionConfig = {
    providerUrl: "https://example.test/v1",
    model: "test-model",
    apiKey: "sk-test"
  };

  function makeJsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" }
    });
  }

  it("retries 3 times on HTTP 5xx then succeeds with retryClassification=success_after_retry", async () => {
    // Models the dominant yunwu.ai outage shape: a brief 503 storm followed
    // by recovery. The 1-retry policy bench shipped with would have given up
    // after attempt 2 and demoted the turn to the fallback path; the 3-retry
    // budget gets it through.
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("svc unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("svc unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("svc unavailable", { status: 503 }))
      .mockResolvedValueOnce(
        makeJsonResponse({ choices: [{ message: { content: '{"signals":[]}' } }] })
      );
    const sleep = vi.fn(async () => undefined);
    const extractor = createGardenHttpExtractor(HTTP_CONFIG, {
      fetch: fetchMock,
      sleep,
      random: () => 0
    });
    const result = await extractor.extract({
      systemPrompt: "system",
      userPrompt: "turn"
    });
    expect(JSON.parse(result.rawJson)).toEqual({ signals: [] });
    expect(result.extractorMeta).toEqual({
      recoveryKind: "none",
      retryCount: 3,
      retryClassification: "success_after_retry"
    });
    // 4 = first attempt + 3 retries.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry on HTTP 401 (auth) and surfaces failure_non_retryable_4xx", async () => {
    // Auth / 4xx-non-429 is deterministic; retrying spends quota with no
    // chance of success. The thrown error carries the classification so
    // dumpSeedExtractionFailureDiagnostic can surface it in the archive
    // without re-deriving from the message.
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));
    const sleep = vi.fn(async () => undefined);
    const extractor = createGardenHttpExtractor(HTTP_CONFIG, {
      fetch: fetchMock,
      sleep,
      random: () => 0
    });
    let thrown: unknown = null;
    try {
      await extractor.extract({ systemPrompt: "s", userPrompt: "t" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const benchRetry = (thrown as { benchRetry?: { retryCount: number; retryClassification: string } })
      .benchRetry;
    expect(benchRetry).toEqual({
      retryCount: 0,
      retryClassification: "failure_non_retryable_4xx"
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries 429 (rate limit) and succeeds on the next attempt", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(
        makeJsonResponse({ choices: [{ message: { content: '{"signals":[]}' } }] })
      );
    const sleep = vi.fn(async () => undefined);
    const extractor = createGardenHttpExtractor(HTTP_CONFIG, {
      fetch: fetchMock,
      sleep,
      random: () => 0.5
    });
    const result = await extractor.extract({
      systemPrompt: "s",
      userPrompt: "t"
    });
    expect(result.extractorMeta?.retryClassification).toBe("success_after_retry");
    expect(result.extractorMeta?.retryCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caps the 5xx retry budget at MAX_RETRIES extra attempts (failure_max_retries)", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("svc unavailable", { status: 502 }));
    const sleep = vi.fn(async () => undefined);
    const extractor = createGardenHttpExtractor(HTTP_CONFIG, {
      fetch: fetchMock,
      sleep,
      random: () => 0
    });
    let thrown: unknown = null;
    try {
      await extractor.extract({ systemPrompt: "s", userPrompt: "t" });
    } catch (error) {
      thrown = error;
    }
    const benchRetry = (thrown as { benchRetry?: { retryCount: number; retryClassification: string } })
      .benchRetry;
    expect(benchRetry).toEqual({
      retryCount: 3,
      retryClassification: "failure_max_retries"
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  // invariant: the wall-clock guard inside createGardenHttpExtractor must
  // abort a hanging fetch even if the monotonic setTimeout has not yet fired.
  // Models the bench-runner host-suspend hang: fetch never resolves and the
  // operator-supplied timeoutMs is large enough that without the wall-clock
  // tick the test would time out.
  // see also: packages/soul/src/garden/wall-clock-timeout.ts
  it("aborts a hanging fetch via AbortController so timeout retry classification fires", async () => {
    // Fetch that resolves only when the abort signal fires. timeoutMs=20ms
    // ensures the per-attempt timer triggers fast; the goal is to prove the
    // abort path WIRES through to the fetch signal and exits the await.
    // First attempt times out, then second attempt times out — exhausts the
    // 1-timeout-retry budget and surfaces failure_timeout.
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      (_input, init) =>
        new Promise<Response>((_, reject) => {
          const signal = (init as RequestInit | undefined)?.signal as
            | AbortSignal
            | undefined;
          signal?.addEventListener("abort", () => {
            reject(new Error("The user aborted a request."));
          });
        })
    );
    const sleep = vi.fn(async () => undefined);
    const extractor = createGardenHttpExtractor(HTTP_CONFIG, {
      fetch: fetchMock,
      sleep,
      random: () => 0
    });
    let thrown: unknown = null;
    try {
      await extractor.extract({
        systemPrompt: "s",
        userPrompt: "t",
        timeoutMs: 20
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const benchRetry = (thrown as {
      benchRetry?: { retryCount: number; retryClassification: string };
    }).benchRetry;
    expect(benchRetry?.retryClassification).toBe("failure_timeout");
    // 2 = first attempt + 1 timeout retry (BENCH_HTTP_MAX_TIMEOUT_RETRIES).
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // invariant: root-cause regression. The previous test's fetch rejects when
  // its abort signal fires — i.e. it is abort-AWARE. The real wedge was a
  // STALLED undici socket that ignores controller.abort() on Node 24: the
  // timer fires, abort() is called, but the fetch promise never settles, so
  // `await fetchImpl(...)` hangs forever and the worker pool wedges with
  // failures=0. The Promise.race backstop must reject the attempt on the
  // timer even though this fetch ignores its signal. WITHOUT the fix this
  // test hangs until the vitest timeout; WITH the fix it surfaces
  // failure_timeout within budget.
  // see also: packages/soul/src/garden/wall-clock-timeout.ts
  it("settles a never-resolving fetch that ignores its abort signal via the timeout backstop", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      // Never settles and never reads the signal — the stalled-socket shape.
      .mockImplementation(() => new Promise<Response>(() => {}));
    const sleep = vi.fn(async () => undefined);
    const extractor = createGardenHttpExtractor(HTTP_CONFIG, {
      fetch: fetchMock,
      sleep,
      random: () => 0
    });
    let thrown: unknown = null;
    try {
      await extractor.extract({
        systemPrompt: "s",
        userPrompt: "t",
        timeoutMs: 20
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const benchRetry = (thrown as {
      benchRetry?: { retryCount: number; retryClassification: string };
    }).benchRetry;
    expect(benchRetry?.retryClassification).toBe("failure_timeout");
    // 2 = first attempt + 1 timeout retry (BENCH_HTTP_MAX_TIMEOUT_RETRIES);
    // each attempt is forced to settle by the backstop rather than hanging.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // invariant: an operator abort (input.abortSignal) must settle the attempt
  // PROMPTLY and classify failure_aborted (never retried) even when the fetch
  // ignores its abort signal and never settles. abort() alone does not settle
  // for that stalled-socket shape, so without the settlement reject the attempt
  // would wait the full budget and then misclassify as failure_timeout.
  // see also: packages/soul/src/garden/wall-clock-timeout.ts settleOperatorAbort.
  it("settles failure_aborted (no retry) on operator abort even when the fetch ignores its signal", async () => {
    const operator = new AbortController();
    const fetchMock = vi
      .fn<typeof fetch>()
      // Never settles and never reads the signal — the abort-ignoring stalled
      // socket. Without the operator-abort settlement this hangs to the full
      // budget; with it the race settles as soon as the operator aborts.
      .mockImplementation(() => {
        // Abort mid-flight, after the attempt has wired its listener.
        queueMicrotask(() => operator.abort());
        return new Promise<Response>(() => {});
      });
    const sleep = vi.fn(async () => undefined);
    const extractor = createGardenHttpExtractor(HTTP_CONFIG, {
      fetch: fetchMock,
      sleep,
      random: () => 0
    });
    let thrown: unknown = null;
    try {
      await extractor.extract({
        systemPrompt: "s",
        userPrompt: "t",
        // Large budget so a failure_timeout would only appear after 60s; the
        // test settling promptly proves the operator-abort settlement fired.
        timeoutMs: 60_000,
        abortSignal: operator.signal
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const benchRetry = (thrown as {
      benchRetry?: { retryCount: number; retryClassification: string };
    }).benchRetry;
    expect(benchRetry?.retryClassification).toBe("failure_aborted");
    // Operator abort is never retried: exactly one attempt, no backoff sleep.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does NOT abort a fetch that resolves within the timeout budget", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      makeJsonResponse({ choices: [{ message: { content: '{"signals":[]}' } }] })
    );
    const sleep = vi.fn(async () => undefined);
    const extractor = createGardenHttpExtractor(HTTP_CONFIG, {
      fetch: fetchMock,
      sleep,
      random: () => 0
    });
    const result = await extractor.extract({
      systemPrompt: "s",
      userPrompt: "t",
      timeoutMs: 60_000
    });
    expect(JSON.parse(result.rawJson)).toEqual({ signals: [] });
    expect(result.extractorMeta?.retryClassification).toBe("success_first_try");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

// invariant: yunwu.ai + gpt-5.4-mini answers chat/completions content ONLY as
// an SSE delta stream (`stream:true`); a non-stream request returns an empty
// `data: [DONE]\n\n` body. The extractor sends `stream:true` and parses the
// SSE body; a compliant provider's plain JSON body must still work
// (back-compat). The body read stays under the same wall-clock backstop as the
// fetch so a mid-stream stalled socket settles as a timeout, not a hang.
// see: .do-it/findings/garden-sse-streaming-rootcause.md
describe("createGardenHttpExtractor — SSE streaming body parse", () => {
  const HTTP_CONFIG: CompileSeedExtractionConfig = {
    providerUrl: "https://example.test/v1",
    model: "test-model",
    apiKey: "sk-test"
  };

  function makeSseResponse(body: string): Response {
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    });
  }

  function makeJsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" }
    });
  }

  it("sends stream:true in the request body", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        makeSseResponse(
          'data: {"choices":[{"delta":{"content":"{\\"signals\\":[]}"}}]}\n\ndata: [DONE]\n\n'
        )
      );
    const extractor = createGardenHttpExtractor(HTTP_CONFIG, {
      fetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      random: () => 0
    });
    await extractor.extract({ systemPrompt: "s", userPrompt: "t" });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const sentBody = JSON.parse(String(init?.body)) as { stream?: unknown };
    expect(sentBody.stream).toBe(true);
  });

  it("concatenates two SSE delta chunks before [DONE] into rawJson", async () => {
    // The dominant yunwu shape: the JSON object the extractor must recover is
    // delivered split across delta frames; only the concatenation parses.
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      makeSseResponse(
        'data: {"choices":[{"delta":{"content":"{\\"sig"}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"nals\\":[]}"}}]}\n\n' +
          "data: [DONE]\n\n"
      )
    );
    const extractor = createGardenHttpExtractor(HTTP_CONFIG, {
      fetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      random: () => 0
    });
    const result = await extractor.extract({
      systemPrompt: "s",
      userPrompt: "t"
    });
    expect(result.rawJson).toBe('{"signals":[]}');
    expect(JSON.parse(result.rawJson)).toEqual({ signals: [] });
    expect(result.extractorMeta?.retryClassification).toBe("success_first_try");
  });

  it("classifies a [DONE]-only empty SSE stream as no-content (NOT a hang)", async () => {
    // yunwu's non-stream / empty answer shape. The empty-content guard must
    // throw so the run blocks on a real content failure instead of silently
    // recording an empty extraction. A non-retryable content error surfaces.
    // A fresh Response per call: an empty-content error has no HTTP status so
    // the retry loop treats it as an unknown-transport failure and retries;
    // each attempt must read a fresh (unconsumed) body. The terminal wrapped
    // error preserves the "no content" cause message.
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => makeSseResponse("data: [DONE]\n\n"));
    const extractor = createGardenHttpExtractor(HTTP_CONFIG, {
      fetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      random: () => 0
    });
    let thrown: unknown = null;
    try {
      await extractor.extract({ systemPrompt: "s", userPrompt: "t" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(
      "garden extraction returned no content"
    );
  });

  it("skips a malformed mid-stream chunk but keeps surrounding content", async () => {
    // Partial keep-alive noise must not throw; a defensively-skipped bad frame
    // still yields the real content from the good frames.
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      makeSseResponse(
        ": keep-alive ping\n\n" +
          'data: {"choices":[{"delta":{"content":"{\\"signals"}}]}\n\n' +
          "data: {not valid json\n\n" +
          'data: {"choices":[{"delta":{"content":"\\":[]}"}}]}\n\n' +
          "data: [DONE]\n\n"
      )
    );
    const extractor = createGardenHttpExtractor(HTTP_CONFIG, {
      fetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      random: () => 0
    });
    const result = await extractor.extract({
      systemPrompt: "s",
      userPrompt: "t"
    });
    expect(JSON.parse(result.rawJson)).toEqual({ signals: [] });
  });

  it("throws on a truncated SSE stream (non-empty but unparseable) so it is never cached", async () => {
    // B1 regression: a provider/proxy delivers a PARTIAL SSE body then cleanly
    // closes the socket -> `response.text()` RESOLVES with partial bytes (no
    // stall, so the wall-clock backstop does NOT fire). The SSE parser keeps
    // the valid early delta and silently skips the truncated final frame,
    // accumulating `{"signals":[{"a"` — non-empty (passes the empty-content
    // guard) but unparseable. Pre-fix this returned success and the poison
    // shard was written to cache as a permanent 0-seed "success". The validity
    // gate (parseOfficialApiSignals, the same downstream consumer) must THROW
    // so the attempt routes to retry then a content/invalid terminal failure —
    // the extractor throws, so createCachingSignalExtractor never writes it.
    // A fresh Response per call: a content error has no HTTP status so the
    // retry loop treats it as unknown-transport and retries; each attempt
    // reads a fresh (unconsumed) body.
    // see: .do-it/findings/garden-sse-streaming-rootcause.md
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      makeSseResponse(
        'data: {"choices":[{"delta":{"content":"{\\"signals\\":[{\\"a"}}]}\n\n' +
          "data: {\"choices\":[{\"delta\":{\"content\":\"\\\":\\\"trunc"
      )
    );
    const extractor = createGardenHttpExtractor(HTTP_CONFIG, {
      fetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      random: () => 0
    });
    let thrown: unknown = null;
    let result: unknown = null;
    try {
      result = await extractor.extract({ systemPrompt: "s", userPrompt: "t" });
    } catch (error) {
      thrown = error;
    }
    // The extractor threw — it did NOT return a success_* result, so the
    // caching extractor never receives a rawJson to write.
    expect(result).toBeNull();
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(
      "garden extraction returned unparseable content"
    );
    // Terminal classification is a retryable content failure that exhausts
    // retries (mirrors the no-content style), NOT a hang or silent success.
    const benchRetry = (thrown as {
      benchRetry?: { retryCount: number; retryClassification: string };
    }).benchRetry;
    expect(benchRetry?.retryClassification).toBe("failure_max_retries");
    // 4 = first attempt + BENCH_HTTP_MAX_RETRIES (3); each settles on the
    // resolved poison bytes, never hangs.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("extracts a full message.content carried in a single SSE frame", async () => {
    // Some OpenAI-compatible providers emit the whole assistant message in one
    // frame as choices[0].message.content rather than streamed deltas.
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      makeSseResponse(
        'data: {"choices":[{"message":{"content":"{\\"signals\\":[]}"}}]}\n\n' +
          "data: [DONE]\n\n"
      )
    );
    const extractor = createGardenHttpExtractor(HTTP_CONFIG, {
      fetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      random: () => 0
    });
    const result = await extractor.extract({
      systemPrompt: "s",
      userPrompt: "t"
    });
    expect(JSON.parse(result.rawJson)).toEqual({ signals: [] });
  });

  it("still extracts a compliant plain-JSON body (application/json back-compat)", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        makeJsonResponse({
          choices: [{ message: { content: '{"signals":[]}' } }]
        })
      );
    const extractor = createGardenHttpExtractor(HTTP_CONFIG, {
      fetch: fetchMock,
      sleep: vi.fn(async () => undefined),
      random: () => 0
    });
    const result = await extractor.extract({
      systemPrompt: "s",
      userPrompt: "t"
    });
    expect(JSON.parse(result.rawJson)).toEqual({ signals: [] });
    expect(result.extractorMeta?.retryClassification).toBe("success_first_try");
  });

  // invariant: body-read backstop regression. A response whose body read
  // (`.text()`) NEVER settles and ignores abort is the post-fetch analogue of
  // the stalled-socket wedge. Racing the body read against the wall-clock
  // backstop must settle the attempt as failure_timeout within budget rather
  // than hanging until the vitest timeout. Mirrors the never-settling-fetch
  // regression but for the body read. WITHOUT the body-read race this hangs.
  // see also: packages/soul/src/garden/wall-clock-timeout.ts
  it("settles a never-resolving body read via the timeout backstop (not a hang)", async () => {
    // A real 200 OK response whose `.text()` never resolves and ignores abort.
    const stalledBodyResponse = {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "text/event-stream" }),
      // Never settles — the mid-stream stalled-socket shape on the body read.
      text: () => new Promise<string>(() => {})
    } as unknown as Response;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(stalledBodyResponse);
    const sleep = vi.fn(async () => undefined);
    const extractor = createGardenHttpExtractor(HTTP_CONFIG, {
      fetch: fetchMock,
      sleep,
      random: () => 0
    });
    let thrown: unknown = null;
    try {
      await extractor.extract({
        systemPrompt: "s",
        userPrompt: "t",
        timeoutMs: 20
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const benchRetry = (thrown as {
      benchRetry?: { retryCount: number; retryClassification: string };
    }).benchRetry;
    expect(benchRetry?.retryClassification).toBe("failure_timeout");
    // 2 = first attempt + 1 timeout retry; each settles via the backstop.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// invariant: the SSE-or-JSON content extraction is a pure helper so it is unit
// testable without a live fetch. Same parse the transport uses; covers the
// shapes the integration tests above exercise plus edge framing.
describe("extractContentFromChatCompletionBody", () => {
  it("concatenates delta content across data: frames up to [DONE]", () => {
    const body =
      'data: {"choices":[{"delta":{"content":"ab"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"cd"}}]}\n\n' +
      "data: [DONE]\n\n";
    expect(extractContentFromChatCompletionBody(body, "text/event-stream")).toBe(
      "abcd"
    );
  });

  it("detects SSE by leading data: even without an event-stream content-type", () => {
    const body = 'data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n';
    expect(extractContentFromChatCompletionBody(body, null)).toBe("x");
  });

  it("returns empty string for a [DONE]-only stream", () => {
    expect(
      extractContentFromChatCompletionBody("data: [DONE]\n\n", "text/event-stream")
    ).toBe("");
  });

  it("ignores blank lines and comment lines", () => {
    const body =
      ": ping\n\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n";
    expect(extractContentFromChatCompletionBody(body, "text/event-stream")).toBe(
      "ok"
    );
  });

  it("reads message.content from a compliant plain-JSON body", () => {
    const body = JSON.stringify({
      choices: [{ message: { content: "json-content" } }]
    });
    expect(extractContentFromChatCompletionBody(body, "application/json")).toBe(
      "json-content"
    );
  });

  it("skips a malformed chunk without throwing", () => {
    const body =
      "data: {bad\n\n" +
      'data: {"choices":[{"delta":{"content":"good"}}]}\n\n' +
      "data: [DONE]\n\n";
    expect(extractContentFromChatCompletionBody(body, "text/event-stream")).toBe(
      "good"
    );
  });

  it("N1: takes content ONCE when a frame carries both delta.content and message.content", () => {
    // A provider that echoes the running message.content alongside each delta
    // would double-count if both branches appended. The message.content branch
    // is an `else if` of the delta branch, so delta wins and content is taken
    // once — not "xx".
    const body =
      'data: {"choices":[{"delta":{"content":"x"},"message":{"content":"x"}}]}\n\n' +
      "data: [DONE]\n\n";
    expect(extractContentFromChatCompletionBody(body, "text/event-stream")).toBe(
      "x"
    );
  });
});

// invariant: a full-bench seed-extraction failure must (a) bump
// liveExtractionFailures, (b) drop a diagnostic dump whose
// retry_classification field surfaces the terminal outcome, (c) end up
// blocked via seedExtractionReleaseBlocker because
// live_extraction_failures > 0.
// see also: packages/eval/src/gates/seed-extraction-blocker.ts —
// evaluateSeedExtractionReleaseBlocker checks live_extraction_failures.
describe("dumpSeedExtractionFailureDiagnostic surfaces retry_classification", () => {
  let cacheRoot: string;
  let diagnosticDir: string;

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "compile-seed-cache-"));
    diagnosticDir = await mkdtemp(join(tmpdir(), "compile-seed-diag-"));
  });

  afterEach(async () => {
    await rm(cacheRoot, { recursive: true, force: true });
    await rm(diagnosticDir, { recursive: true, force: true });
  });

  it("dumps retry_classification=failure_non_retryable_4xx when a live extraction hits HTTP 401", async () => {
    // The extractor delegate models a chronic 401 — the retry loop must
    // bail on the first attempt and propagate the classification. The dump
    // file captured under diagnosticDir then carries retry_classification
    // so a Phase-F dump reader can attribute the fallback without re-running.
    const failingDelegate: BenchSignalExtractor = {
      async extract() {
        const err = new Error("garden extraction HTTP 401 unauthorized");
        (err as { status?: number }).status = 401;
        (err as { benchRetry?: unknown }).benchRetry = {
          retryCount: 0,
          retryClassification: "failure_non_retryable_4xx"
        };
        throw err;
      }
    };

    const runner = createCompileSeedRunner({
      config: CREDENTIALLED_CONFIG,
      cacheRoot,
      extractorFactory: () => failingDelegate,
      diagnosticDir
    });

    const daemon = buildCompileSeedDaemon((input) => ({
      memoryId: `memory-${input.distilledFact.slice(0, 4)}`,
      signalId: "signal-x",
      proposalId: "proposal-x",
      evidenceId: "evidence-x",
      truncated: false,
      charsClipped: 0
    }));

    await runner.seedTurn({
      daemon,
      turnContent: "the user prefers tea over coffee",
      evidenceRefBase: "evidence-1",
      seedIndex: 0,
      workspaceId: "ws-test",
      runId: "run-test"
    });

    // (a) liveExtractionFailures bumped — the blocker depends on this.
    expect(runner.stats.liveExtractionFailures).toBe(1);
    expect(runner.stats.offlineFallbacks).toBe(1);

    // (b) dump file written and carries retry_classification.
    const dumpFiles = readdirSync(diagnosticDir).filter(
      (f) => f.startsWith("compile-seed-") && f.endsWith(".json")
    );
    expect(dumpFiles).toHaveLength(1);
    const envelope = JSON.parse(
      readFileSync(join(diagnosticDir, dumpFiles[0]!), "utf8")
    ) as {
      retry_classification: string;
      retry_count: number | null;
      live_extraction_failures: number;
      last_extraction_source: string;
    };
    expect(envelope.retry_classification).toBe("failure_non_retryable_4xx");
    expect(envelope.retry_count).toBe(0);
    expect(envelope.live_extraction_failures).toBe(1);
    expect(envelope.last_extraction_source).toBe("live");
  });
});
