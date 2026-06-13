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
import { createUnscoredMaterializedSeedError } from "../../harness/seed-errors.js";
import {
  buildCompileSeedDaemon,
  CREDENTIALLED_CONFIG,
  OFFLINE_CONFIG,
  makeSeed,
  signalsEnvelope
} from "./compile-seed-fixture.js";

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
