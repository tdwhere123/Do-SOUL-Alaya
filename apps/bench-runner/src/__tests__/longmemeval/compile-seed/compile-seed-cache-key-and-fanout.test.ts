import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OFFICIAL_API_SYSTEM_PROMPT, OfficialApiGardenProvider } from "@do-soul/alaya-soul";
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
} from "../../../longmemeval/compile-seed.js";
import type { BenchSignalSeedInput, SeededMemoryResult } from "../../../harness/daemon.js";
import { createUnscoredMaterializedSeedError } from "../../../harness/seeding/seed-errors.js";
import {
  buildCompileSeedDaemon,
  CREDENTIALLED_CONFIG,
  OFFLINE_CONFIG,
  makeSeed,
  signalsEnvelope
} from "./compile-seed-fixture.js";
import {
  TEST_EXTRACTION_PROVIDER_URL,
  writeExtractionCacheTestManifest
} from "../extraction/extraction-cache-test-fixture.js";

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
    writeExtractionCacheTestManifest({
      cacheRoot,
      model: "test-model",
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
    });
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
      config: {
        model: "test-model", modelFamily: "test-model",
        providerUrl: TEST_EXTRACTION_PROVIDER_URL,
        requestProfile: "provider-default-v1"
      },
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
    // The first strict-empty live result is rechecked once because the real
    // provider prompt carries a non-empty source assertion catalog.
    expect(delegate.extract).toHaveBeenCalledTimes(2);

    await provider.compile("I moved to Berlin last spring.", {
      workspace_id: "ws-1",
      run_id: "run-cq-abc-1799999999999",
      surface_id: null,
      turn_messages: []
    });
    // Still 2 — the second turn was a cache hit despite the new run_id.
    expect(delegate.extract).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a shard when the trusted role corpus changes", async () => {
    writeExtractionCacheTestManifest({
      cacheRoot,
      model: "test-model",
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
    });
    const delegate: BenchSignalExtractor = {
      extract: vi.fn(async () => ({ rawJson: '{"signals":[]}' }))
    };
    const provider = new OfficialApiGardenProvider({
      apiKey: "test-key",
      model: "test-model",
      extractor: createCachingSignalExtractor({
        delegate,
        config: {
          model: "test-model", modelFamily: "test-model",
          providerUrl: TEST_EXTRACTION_PROVIDER_URL,
          requestProfile: "provider-default-v1"
        },
        cacheRoot
      })
    });
    const turnContent = "User: A.\nAssistant: B.";

    await provider.compile(turnContent, {
      workspace_id: "ws-1", run_id: "run-1", surface_id: null,
      turn_messages: [
        { message_id: "m1", role: "user", content: "A." },
        { message_id: "m2", role: "assistant", content: "B." }
      ]
    });
    await provider.compile(turnContent, {
      workspace_id: "ws-1", run_id: "run-2", surface_id: null,
      turn_messages: [
        { message_id: "m3", role: "assistant", content: "A." },
        { message_id: "m4", role: "user", content: "B." }
      ]
    });

    expect(delegate.extract).toHaveBeenCalledTimes(2);
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
    writeExtractionCacheTestManifest({
      cacheRoot,
      model: "gpt-test-mini",
      providerUrl: "https://example.test/v1",
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
    });
  });

  afterEach(async () => {
    await rm(cacheRoot, { recursive: true, force: true });
    await rm(diagnosticDir, { recursive: true, force: true });
  });

  it("writes a compile-seed-*.json dump carrying cache_key_prefix when live extraction fails", async () => {
    const config: CompileSeedExtractionConfig = {
      providerUrl: "https://example.test/v1",
      model: "gpt-test-mini",
      requestProfile: "provider-default-v1",
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
      allowLiveExtraction: true,
      diagnosticDir,
      extractorFactory: () => ({
        extract: async () => {
          throw new Error("garden extraction HTTP 500 from provider");
        }
      })
    });

    await expect(
      runner.seedTurn({
        daemon,
        turnContent: "Turn whose extraction blows up.",
        evidenceRefBase: "q1-s0-t0",
        seedIndex: 0,
        workspaceId: "ws-test",
        runId: "run-test"
      })
    ).rejects.toThrow("Official garden provider returned an invalid response.");

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
      requestProfile: "provider-default-v1",
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
      allowLiveExtraction: true,
      diagnosticDir: null,
      extractorFactory: () => ({
        extract: async () => {
          throw new Error("garden extraction HTTP 502");
        }
      })
    });

    await expect(
      runner.seedTurn({
        daemon,
        turnContent: "Another failing turn.",
        evidenceRefBase: "q2-s0-t0",
        seedIndex: 0,
        workspaceId: "ws-test",
        runId: "run-test"
      })
    ).rejects.toThrow();

    // diagnosticDir was created by beforeEach but never written to.
    const dumpFiles = readdirSync(diagnosticDir).filter(
      (f) => f.startsWith("compile-seed-") && f.endsWith(".json")
    );
    expect(dumpFiles).toHaveLength(0);
    // The classification path still ran so liveExtractionFailures is bumped.
    expect(runner.stats.liveExtractionFailures).toBe(1);
  });
});
