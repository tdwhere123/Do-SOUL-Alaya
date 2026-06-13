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
} from "../../longmemeval/compile-seed.js";
import type { BenchSignalSeedInput, SeededMemoryResult } from "../../harness/daemon.js";
import {
  buildCompileSeedDaemon,
  CREDENTIALLED_CONFIG,
  OFFLINE_CONFIG,
  signalsEnvelope
} from "./compile-seed-fixture.js";

import { createUnscoredMaterializedSeedError } from "../../harness/seed-errors.js";

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
