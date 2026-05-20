import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAtomicFactExtractor,
  resolveAtomicFactExtractionConfig,
  seedTurnAsAtomicFacts,
  type AtomicFactExtractionConfig,
  type AtomicFactSeedDaemon
} from "../longmemeval/atomic-fact-extraction.js";
import type { SeededMemoryResult } from "../harness/daemon.js";

const CREDENTIALLED_CONFIG: AtomicFactExtractionConfig = {
  providerUrl: "https://example.test/v1",
  model: "test-model",
  apiKey: "test-key"
};

const OFFLINE_CONFIG: AtomicFactExtractionConfig = {
  providerUrl: "https://example.test/v1",
  model: "test-model",
  apiKey: null
};

describe("atomic-fact-extraction", () => {
  let cacheRoot: string;

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "atomic-fact-cache-"));
  });

  afterEach(async () => {
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("extracts a list of atomic facts via the LLM on a cache miss", async () => {
    const llmComplete = vi
      .fn<[string, AtomicFactExtractionConfig], Promise<readonly string[]>>()
      .mockResolvedValue([
        "Alice lives in Berlin.",
        "Alice started her job on 2024-03-01."
      ]);
    const extractor = createAtomicFactExtractor({
      config: CREDENTIALLED_CONFIG,
      cacheRoot,
      llmComplete
    });

    const facts = await extractor.extract(
      "I moved to Berlin and I started my job in March 2024."
    );

    expect(facts).toEqual([
      "Alice lives in Berlin.",
      "Alice started her job on 2024-03-01."
    ]);
    expect(llmComplete).toHaveBeenCalledTimes(1);
    expect(extractor.stats.llmCalls).toBe(1);
    expect(extractor.stats.cacheHits).toBe(0);
    expect(extractor.stats.factsProduced).toBe(2);
  });

  it("serves a second run from the on-disk cache with zero LLM calls", async () => {
    const turn = "The deploy ran at 09:00 UTC and it succeeded.";
    const llmComplete = vi
      .fn<[string, AtomicFactExtractionConfig], Promise<readonly string[]>>()
      .mockResolvedValue(["The deploy ran at 09:00 UTC.", "The deploy succeeded."]);

    const firstRun = createAtomicFactExtractor({
      config: CREDENTIALLED_CONFIG,
      cacheRoot,
      llmComplete
    });
    await firstRun.extract(turn);
    expect(llmComplete).toHaveBeenCalledTimes(1);

    // A fresh extractor sharing the same cache fixture must not call the LLM.
    const secondRun = createAtomicFactExtractor({
      config: CREDENTIALLED_CONFIG,
      cacheRoot,
      llmComplete
    });
    const facts = await secondRun.extract(turn);

    expect(llmComplete).toHaveBeenCalledTimes(1);
    expect(secondRun.stats.llmCalls).toBe(0);
    expect(secondRun.stats.cacheHits).toBe(1);
    expect(facts).toEqual([
      "The deploy ran at 09:00 UTC.",
      "The deploy succeeded."
    ]);
  });

  it("falls back to the full turn as one fact when no credentials are configured", async () => {
    const turn = "First sentence. Second sentence. Third sentence with the answer.";
    const extractor = createAtomicFactExtractor({
      config: OFFLINE_CONFIG,
      cacheRoot
    });

    const facts = await extractor.extract(turn);

    expect(facts).toEqual([turn]);
    expect(extractor.stats.offlineFallbacks).toBe(1);
    expect(extractor.stats.llmCalls).toBe(0);
  });

  it("falls back to the full turn when the LLM call fails", async () => {
    const turn = "A turn whose extraction will fail.";
    const llmComplete = vi
      .fn<[string, AtomicFactExtractionConfig], Promise<readonly string[]>>()
      .mockRejectedValue(new Error("garden extraction HTTP 500"));
    const extractor = createAtomicFactExtractor({
      config: CREDENTIALLED_CONFIG,
      cacheRoot,
      llmComplete
    });

    const facts = await extractor.extract(turn);

    expect(facts).toEqual([turn]);
    expect(extractor.stats.offlineFallbacks).toBe(1);
  });

  it("dedupes and caps the extracted fact list", async () => {
    const llmComplete = vi
      .fn<[string, AtomicFactExtractionConfig], Promise<readonly string[]>>()
      .mockResolvedValue(["Same fact.", "same fact.", "  ", "Other fact."]);
    const extractor = createAtomicFactExtractor({
      config: CREDENTIALLED_CONFIG,
      cacheRoot,
      llmComplete
    });

    const facts = await extractor.extract("turn content");

    expect(facts).toEqual(["Same fact.", "Other fact."]);
  });

  it("resolves config from the environment, with a null key when no secret ref is set", () => {
    const config = resolveAtomicFactExtractionConfig({});
    expect(config.apiKey).toBeNull();
    expect(config.providerUrl).toBe("https://yunwu.ai/v1");
    expect(config.model).toBe("gpt-5.4-mini");
  });
});

describe("seedTurnAsAtomicFacts", () => {
  function buildSeed(memoryId: string): SeededMemoryResult {
    return {
      memoryId,
      signalId: `signal-${memoryId}`,
      proposalId: `proposal-${memoryId}`,
      truncated: false,
      charsClipped: 0
    };
  }

  it("calls proposeMemory once per fact and returns every seed (N-objects)", async () => {
    const calls: { content: string; evidenceRef: string; distilledFact?: string }[] =
      [];
    let counter = 0;
    const daemon: AtomicFactSeedDaemon = {
      proposeMemory: async (content, evidenceRef, options) => {
        calls.push({ content, evidenceRef, distilledFact: options?.distilledFact });
        counter += 1;
        return buildSeed(`memory-${counter}`);
      }
    };
    const extractor = createAtomicFactExtractor({
      config: OFFLINE_CONFIG,
      cacheRoot: await mkdtemp(join(tmpdir(), "seed-cache-")),
      llmComplete: async () => ["Fact one.", "Fact two.", "Fact three."]
    });

    const result = await seedTurnAsAtomicFacts({
      daemon,
      extractor,
      turnContent: "the original turn",
      evidenceRefBase: "q1-s0-t0",
      objectKind: "fact"
    });

    // Offline config => single full-turn fact regardless of llmComplete.
    expect(result.seeds).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.content).toBe("the original turn");
    expect(calls[0]?.distilledFact).toBe("the original turn");
  });

  it("emits N proposeMemory calls with distinct evidence refs and per-fact distilledFact", async () => {
    const calls: { evidenceRef: string; distilledFact?: string }[] = [];
    let counter = 0;
    const daemon: AtomicFactSeedDaemon = {
      proposeMemory: async (_content, evidenceRef, options) => {
        calls.push({ evidenceRef, distilledFact: options?.distilledFact });
        counter += 1;
        return buildSeed(`memory-${counter}`);
      }
    };
    const extractor = createAtomicFactExtractor({
      config: CREDENTIALLED_CONFIG,
      cacheRoot: await mkdtemp(join(tmpdir(), "seed-cache-")),
      llmComplete: async () => ["Fact A.", "Fact B.", "Fact C."]
    });

    const result = await seedTurnAsAtomicFacts({
      daemon,
      extractor,
      turnContent: "compound turn",
      evidenceRefBase: "q1-s0-t0",
      objectKind: "fact"
    });

    expect(result.seeds.map((seed) => seed.memoryId)).toEqual([
      "memory-1",
      "memory-2",
      "memory-3"
    ]);
    expect(calls.map((call) => call.evidenceRef)).toEqual([
      "q1-s0-t0-f0",
      "q1-s0-t0-f1",
      "q1-s0-t0-f2"
    ]);
    expect(calls.map((call) => call.distilledFact)).toEqual([
      "Fact A.",
      "Fact B.",
      "Fact C."
    ]);
  });
});
