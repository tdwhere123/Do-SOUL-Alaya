import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OfficialApiGardenProvider } from "@do-soul/alaya-soul";
import {
  createCachingSignalExtractor,
  createCompileSeedRunner,
  resolveCompileSeedExtractionConfig,
  type BenchSignalExtractor,
  type CompileSeedDaemon,
  type CompileSeedExtractionConfig,
  type CompileSeedExtractionStats
} from "../longmemeval/compile-seed.js";
import type { BenchSignalSeedInput, SeededMemoryResult } from "../harness/daemon.js";

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
    proposeMemoriesFromCompileSignals: async (inputs) => inputs.map(onSignal)
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
      factsProduced: 0,
      signalsDropped: 0,
      parseDropped: 0,
      compileOverflowDropped: 0,
      lastTurnRawSignalCount: 0,
      lastTurnDraftCount: 0
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
      factsProduced: 0,
      signalsDropped: 0,
      parseDropped: 0,
      compileOverflowDropped: 0,
      lastTurnRawSignalCount: 0,
      lastTurnDraftCount: 0
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
      factsProduced: 0,
      signalsDropped: 0,
      parseDropped: 0,
      compileOverflowDropped: 0,
      lastTurnRawSignalCount: 0,
      lastTurnDraftCount: 0
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
    const config = resolveCompileSeedExtractionConfig({});
    expect(config.apiKey).toBeNull();
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
      factsProduced: 0,
      signalsDropped: 0,
      parseDropped: 0,
      compileOverflowDropped: 0,
      lastTurnRawSignalCount: 0,
      lastTurnDraftCount: 0
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
      factsProduced: 0,
      signalsDropped: 0,
      parseDropped: 0,
      compileOverflowDropped: 0,
      lastTurnRawSignalCount: 0,
      lastTurnDraftCount: 0
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
