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
import { computeExtractionRawJsonSha256 } from "../../../longmemeval/compile-seed/compile-seed-cache.js";

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
    writeExtractionCacheTestManifest({ cacheRoot, model: "test-model", systemPrompt: "sys" });
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
      signalsDroppedByReason: { candidate_absent: 0, materialization_drop: 0 },
      parseDropped: 0,
      compileOverflowDropped: 0,
      lastTurnRawSignalCount: 0,
      lastTurnDraftCount: 0,
      lastExtractionSource: null,
      lastRawJsonSha256: null
    };
    const firstRun = createCachingSignalExtractor({
      delegate,
      config: {
        model: "test-model", modelFamily: "test-model",
        providerUrl: TEST_EXTRACTION_PROVIDER_URL,
        requestProfile: "provider-default-v1"
      },
      cacheRoot,
      stats: firstStats
    });
    await firstRun.extract({
      systemPrompt: "sys",
      userPrompt: userPromptFor("I moved to Berlin.", "run-cq-abc-1700000000000")
    });
    expect(delegate.extract).toHaveBeenCalledTimes(1);
    expect(firstStats.llmCalls).toBe(1);
    expect(firstStats.lastRawJsonSha256)
      .toBe(computeExtractionRawJsonSha256('{"signals":[]}'));

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
      signalsDroppedByReason: { candidate_absent: 0, materialization_drop: 0 },
      parseDropped: 0,
      compileOverflowDropped: 0,
      lastTurnRawSignalCount: 0,
      lastTurnDraftCount: 0,
      lastExtractionSource: null,
      lastRawJsonSha256: null
    };
    const secondRun = createCachingSignalExtractor({
      delegate,
      config: {
        model: "test-model", modelFamily: "test-model",
        providerUrl: TEST_EXTRACTION_PROVIDER_URL,
        requestProfile: "provider-default-v1"
      },
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
    expect(secondStats.lastRawJsonSha256).toBe(firstStats.lastRawJsonSha256);
    expect(cached.rawJson).toBe('{"signals":[]}');
  });

  it("still misses when the turn_content itself changes", async () => {
    writeExtractionCacheTestManifest({ cacheRoot, model: "test-model", systemPrompt: "sys" });
    const firstRaw = signalsEnvelope([{ distilled: "Fact A.", matched: "A" }]);
    const secondRaw = signalsEnvelope([{ distilled: "Fact B.", matched: "B" }]);
    const delegate: BenchSignalExtractor = {
      extract: vi
        .fn<BenchSignalExtractor["extract"]>()
        .mockResolvedValueOnce({ rawJson: firstRaw })
        .mockResolvedValueOnce({ rawJson: secondRaw })
    };
    const extractor = createCachingSignalExtractor({
      delegate,
      config: {
        model: "test-model", modelFamily: "test-model",
        providerUrl: TEST_EXTRACTION_PROVIDER_URL,
        requestProfile: "provider-default-v1"
      },
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

  it("does not settle a provider outcome when authorization stopped before transport", async () => {
    writeExtractionCacheTestManifest({ cacheRoot, model: "test-model", systemPrompt: "sys" });
    const stopped = new Error("operator stopped before provider transport");
    const onLiveExtractionOutcome = vi.fn();
    const onLiveExtractionFailed = vi.fn();
    const extractor = createCachingSignalExtractor({
      delegate: {
        extract: async (input) => {
          await input.onTransportAttempt?.(input.abortSignal);
          return { rawJson: '{"signals":[]}' };
        }
      },
      config: {
        model: "test-model", modelFamily: "test-model",
        providerUrl: TEST_EXTRACTION_PROVIDER_URL,
        requestProfile: "provider-default-v1"
      },
      cacheRoot,
      onTransportAttempt: async () => {
        throw stopped;
      },
      onLiveExtractionOutcome,
      onLiveExtractionFailed
    });

    await expect(extractor.extract({
      systemPrompt: "sys",
      userPrompt: userPromptFor("Stopped before a request.", "run-abort")
    })).rejects.toBe(stopped);

    expect(onLiveExtractionOutcome).not.toHaveBeenCalled();
    expect(onLiveExtractionFailed).toHaveBeenCalledOnce();
  });
});

describe("bench evidence capsule — production-faithful span", () => {
  let cacheRoot: string;

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "compile-seed-evidence-"));
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
      allowLiveExtraction: true,
      extractorFactory: () => ({
        extract: async () => ({
          rawJson: signalsEnvelope([
            { distilled: "Alice lives in Berlin.", matched: "I moved to Berlin" }
          ])
        })
      })
    });

    const fullTurn =
      "Yesterday I moved to Berlin. It has been a long week of unpacking.";
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
    // The bench forwards compile()'s source-assertion raw_payload but strips
    // the schema-grounding block (it pins detected_object.object_kind to the
    // pre-canonicalization extracted kind — see stripSchemaGrounding). The
    // The complete source assertion survives and is narrower than the turn.
    expect(raw?.matched_text).toBe("Yesterday I moved to Berlin.");
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
    await rm(join(cacheRoot, "manifest.json"), { force: true });
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
