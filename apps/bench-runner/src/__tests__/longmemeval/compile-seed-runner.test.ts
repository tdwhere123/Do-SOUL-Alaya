import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OFFICIAL_API_SYSTEM_PROMPT,
  OfficialApiGardenProvider
} from "@do-soul/alaya-soul";
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
import { writeExtractionCacheTestManifest } from "./extraction-cache-test-fixture.js";

describe("createCompileSeedRunner — compile-based seed", () => {
  let cacheRoot: string;
  const SEED_CONTEXT = {
    workspaceId: "ws-test",
    runId: "run-test"
  };

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "compile-seed-runner-"));
    writeExtractionCacheTestManifest({
      cacheRoot,
      model: CREDENTIALLED_CONFIG.model,
      providerUrl: CREDENTIALLED_CONFIG.providerUrl,
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
    });
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
      allowLiveExtraction: true,
      extractorFactory: () => ({
        extract: async () => ({
          rawJson: signalsEnvelope([
            { distilled: "Alice moved to Berlin.", matched: "Alice moved to Berlin." },
            {
              distilled: "Alice started her job on 2024-03-01.",
              matched: "Alice started her job on 2024-03-01."
            }
          ])
        })
      })
    });

    const result = await runner.seedTurn({
      daemon,
      turnContent: "Alice moved to Berlin. Alice started her job on 2024-03-01.",
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
    // Each extracted fact remains self-contained while the full turn is the
    // evidence boundary.
    expect(seeded.map((input) => input.distilledFact)).toEqual([
      "Alice moved to Berlin.",
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
      `"confidence":0.9,"matched_text":"I moved to Berlin","distilled_fact":"I moved to Berlin"},` +
      `{"signal_kind":"potential_preference","object_kind":"user_preference",` +
      `"confidence":0.8,"matched_text":"I\\'ll bring my dog","distilled_fact":"bad"},` +
      `{"signal_kind":"potential_preference","object_kind":"user_preference",` +
      `"confidence":0.9,"matched_text":"I started my job","distilled_fact":"I started my job"}` +
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
      allowLiveExtraction: true,
      extractorFactory: () => ({
        extract: async () => ({ rawJson: corruptEnvelope })
      })
    });

    const result = await runner.seedTurn({
      daemon,
      turnContent: "I moved to Berlin. I started my job.",
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
      "I moved to Berlin.",
      "I started my job."
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

  it("fails loudly when the credentialed extraction envelope is degenerate", async () => {
    // The only entry is truncated mid-string (max_tokens) — no complete
    // element survives salvage, so the credentialed extraction path must
    // reject instead of masking the failed live call as an offline fallback.
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
      allowLiveExtraction: true,
      extractorFactory: () => ({
        extract: async () => ({ rawJson: degenerate })
      })
    });

    await expect(
      runner.seedTurn({
        daemon,
        turnContent: "I moved to Berlin.",
        evidenceRefBase: "q1-s0-t0",
        seedIndex: 0,
        ...SEED_CONTEXT
      })
    ).rejects.toThrow();

    expect(seeded).toHaveLength(0);
    expect(runner.stats.offlineFallbacks).toBe(0);
    expect(runner.stats.liveExtractionFailures).toBe(1);
    expect(runner.stats.cachedExtractionFailures).toBe(0);
  });

  it("does not synthesize a memory when official extraction finds no candidates", async () => {
    const seeded: BenchSignalSeedInput[] = [];
    const daemon = buildCompileSeedDaemon((input) => {
      seeded.push(input);
      return buildSeed("memory-1");
    });
    const runner = createCompileSeedRunner({
      config: CREDENTIALLED_CONFIG,
      cacheRoot,
      allowLiveExtraction: true,
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

    expect(result.seeds).toHaveLength(0);
    expect(seeded).toHaveLength(0);
    expect(runner.stats.factsProduced).toBe(0);
    expect(runner.stats.offlineFallbacks).toBe(0);
  });

  it("falls back to the full turn as one fact when no credentials are configured", async () => {
    await rm(join(cacheRoot, "manifest.json"), { force: true });
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

  it("fails loudly when credentialed extraction throws", async () => {
    const seeded: BenchSignalSeedInput[] = [];
    const daemon = buildCompileSeedDaemon((input) => {
      seeded.push(input);
      return buildSeed("memory-1");
    });
    const runner = createCompileSeedRunner({
      config: CREDENTIALLED_CONFIG,
      cacheRoot,
      allowLiveExtraction: true,
      extractorFactory: () => ({
        extract: async () => {
          throw new Error("garden extraction HTTP 500");
        }
      })
    });

    await expect(
      runner.seedTurn({
        daemon,
        turnContent: "A turn whose extraction will fail.",
        evidenceRefBase: "q1-s0-t0",
        seedIndex: 0,
        ...SEED_CONTEXT
      })
    ).rejects.toThrow("Official garden provider returned an invalid response.");

    expect(seeded).toHaveLength(0);
    expect(runner.stats.offlineFallbacks).toBe(0);
    expect(runner.stats.cacheHits).toBe(0);
    expect(runner.stats.llmCalls).toBe(0);
    expect(runner.stats.liveExtractionFailures).toBe(1);
    expect(runner.stats.cachedExtractionFailures).toBe(0);
    expect(toSeedExtractionPathKpi(runner.stats)).toMatchObject({
      offline_fallbacks: 0,
      live_extraction_failures: 1,
      cached_extraction_failures: 0
    });
  });

  it("does not cache a semantically invalid live response", async () => {
    const turnContent = "A turn whose cached raw JSON is malformed.";
    const firstSeeded: BenchSignalSeedInput[] = [];
    const firstDaemon = buildCompileSeedDaemon((input) => {
      firstSeeded.push(input);
      return buildSeed("memory-1");
    });
    const firstRunner = createCompileSeedRunner({
      config: CREDENTIALLED_CONFIG,
      cacheRoot,
      allowLiveExtraction: true,
      extractorFactory: () => ({
        extract: async () => ({ rawJson: '{"not_signals":[]}' })
      })
    });
    await expect(
      firstRunner.seedTurn({
        daemon: firstDaemon,
        turnContent,
        evidenceRefBase: "q1-s0-t0",
        seedIndex: 0,
        ...SEED_CONTEXT
      })
    ).rejects.toThrow("Official garden provider returned an invalid response.");
    expect(firstSeeded).toHaveLength(0);
    expect(firstRunner.stats.liveExtractionFailures).toBe(1);

    const delegate = vi.fn(async () => ({ rawJson: signalsEnvelope([]) }));
    const seeded: BenchSignalSeedInput[] = [];
    const secondDaemon = buildCompileSeedDaemon((input) => {
      seeded.push(input);
      return buildSeed("memory-2");
    });
    const secondRunner = createCompileSeedRunner({
      config: CREDENTIALLED_CONFIG,
      cacheRoot,
      allowLiveExtraction: true,
      extractorFactory: () => ({ extract: delegate })
    });

    await secondRunner.seedTurn({
      daemon: secondDaemon,
      turnContent,
      evidenceRefBase: "q1-s0-t0",
      seedIndex: 0,
      ...SEED_CONTEXT
    });

    expect(seeded).toHaveLength(0);
    expect(delegate).toHaveBeenCalledOnce();
    expect(secondRunner.stats.cacheHits).toBe(0);
    expect(secondRunner.stats.llmCalls).toBe(1);
    expect(secondRunner.stats.offlineFallbacks).toBe(0);
    expect(secondRunner.stats.liveExtractionFailures).toBe(0);
    expect(secondRunner.stats.cachedExtractionFailures).toBe(0);
    expect(secondRunner.stats.factsProduced).toBe(0);
    expect(toSeedExtractionPathKpi(secondRunner.stats)).toMatchObject({
      cache_hits: 0,
      llm_calls: 1,
      offline_fallbacks: 0,
      live_extraction_failures: 0,
      cached_extraction_failures: 0
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
      allowLiveExtraction: true,
      extractorFactory: () => ({
        extract: async () => ({
          rawJson: signalsEnvelope([
            { distilled: "Fact A.", matched: "Fact A." },
            { distilled: "Fact B.", matched: "Fact B." },
            { distilled: "Fact C.", matched: "Fact C." }
          ])
        })
      })
    });

    const sidecar = new Map<string, { sessionId: string; hasAnswer: boolean }>();
    const result = await runner.seedTurn({
      daemon,
      turnContent: "Fact A. Fact B. Fact C.",
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
