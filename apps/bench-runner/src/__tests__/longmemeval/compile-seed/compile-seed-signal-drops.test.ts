// @ts-nocheck
import { inspectExtractionRawJson } from "../../../runs/extraction/content-closure.js";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildOfficialApiExtractionRequest,
  OFFICIAL_API_SYSTEM_PROMPT,
  OfficialApiGardenProvider,
  stringifyOfficialApiExtractionRequest
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
} from "../../../runs/compile-seed.js";
import type { BenchSignalSeedInput, SeededMemoryResult } from "../../../harness/daemon.js";
import { createUnscoredMaterializedSeedError } from "../../../harness/seeding/seed-errors.js";
import {
  buildCompileSeedDaemon,
  CREDENTIALLED_CONFIG,
  OFFLINE_CONFIG,
  makeSeed,
  providerBackedResult,
  signalsEnvelope,
  withOpenSemanticFactorGraph
} from "./compile-seed-fixture.js";
import {
  TEST_EXTRACTION_PROVIDER_URL,
  writeExtractionCacheTestManifest
} from "../extraction/extraction-cache-test-fixture.js";

describe("compile() signal-drop count is observable", () => {
  let cacheRoot: string;

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "compile-seed-drops-"));
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

  it("keeps malformed-sibling salvage diagnostic without completing or caching the response", async () => {
    const raw = JSON.stringify({ signals: [
      ...JSON.parse(signalsEnvelope([{ distilled: "I have a dog.", matched: "I have a dog." }])).signals,
      { confidence: "invalid" }
    ] });
    expect(inspectExtractionRawJson(raw)).toMatchObject({ rawSignalCount: 2, parsedDraftCount: 1 });
    const runner = createCompileSeedRunner({ config: CREDENTIALLED_CONFIG, cacheRoot, allowLiveExtraction: true,
      extractorFactory: () => ({ extract: async () => providerBackedResult(raw) }) });
    const daemon = buildCompileSeedDaemon(() => { throw new Error("incomplete response must not materialize"); });
    await expect(runner.seedTurn({ daemon, turnContent: "I have a dog.", evidenceRefBase: "q1-s0-t0",
      seedIndex: 0, workspaceId: "ws-test", runId: "run-test" })).rejects.toThrow("invalid response");
    expect(readdirSync(cacheRoot)).toEqual(["manifest.json"]);
  });

  it("isolates per-signal materialization drops by reason and keeps healthy batch-mates", async () => {
    // Each failed signal is attributed by reason without suppressing healthy
    // siblings from the same turn.
    const daemon: CompileSeedDaemon = {
      proposeMemoryFromSignal: async () => ({
        memoryId: "memory-fallback",
        signalId: "signal-fallback",
        proposalId: "proposal-fallback",
        evidenceId: "evidence-fallback",
        truncated: false,
        charsClipped: 0
      }),
      // The daemon returns one seeded signal plus two independent reason-coded drops.
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
          { reason: "materialization_drop", detail: "boom" }
        ]
      }),
      proposeSynthesis: async () => ({ synthesisId: null })
    };
    const runner = createCompileSeedRunner({
      config: CREDENTIALLED_CONFIG,
      cacheRoot,
      allowLiveExtraction: true,
      extractorFactory: () => ({
        extract: async () => ({
          ...providerBackedResult(""),
          rawJson: signalsEnvelope([
            { distilled: "Survivor.", matched: "Intro span" },
            { distilled: "Absent.", matched: "Middle span", assertionId: 2 },
            { distilled: "Threw.", matched: "Closing span", assertionId: 3 }
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
      materialization_drop: 1
    });
    // No extraction-stage drops on this clean envelope.
    expect(runner.stats.parseDropped).toBe(0);
    expect(runner.stats.compileOverflowDropped).toBe(0);

    // The per-reason ledger surfaces in the persisted KPI.
    const kpi = toSeedExtractionPathKpi(runner.stats);
    expect(kpi.signals_dropped_by_reason).toEqual({
      candidate_absent: 1,
      materialization_drop: 1
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
      allowLiveExtraction: true,
      extractorFactory: () => ({
        extract: async () => ({
          ...providerBackedResult(""),
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
      materialization_drop: 0
    });
  });

  it("fails closed in no-credentials fallback when a seed memory materializes but accept fails", async () => {
    await rm(join(cacheRoot, "manifest.json"), { force: true });
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
      materialization_drop: 0
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
    writeExtractionCacheTestManifest({ cacheRoot, model: "test-model", systemPrompt: "sys" });
    // A delegate whose response is large enough that a torn write would be
    // visibly partial. The write-tmp-then-rename discipline means the final
    // shard is always whole, parseable JSON with the complete raw_json.
    const bigRawJson = JSON.stringify({
      signals: Array.from({ length: 64 }, (_, i) => withOpenSemanticFactorGraph({
        signal_kind: "potential_preference",
        object_kind: "user_preference",
        confidence: 0.9,
        matched_text: "Atomic turn persists a complete shard.",
        source_locator: { contract_version: 2, kind: "assertion_catalog", assertion_id: 1 },
        distilled_fact: `Fact number ${i}.`
      }))
    });
    const delegate: BenchSignalExtractor = {
      extract: vi.fn(async () => ({
        rawJson: bigRawJson,
        responseMetadata: {
          finishReason: "stop",
          maxOutputTokens: 2048,
          completionContractVersion: 1,
          completionWitness: "message"
        },
        usage: { inputTokens: 17, outputTokens: 23, totalTokens: 40 }
      }))
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
    const userPrompt = stringifyOfficialApiExtractionRequest(
      buildOfficialApiExtractionRequest("Atomic turn persists a complete shard.", [])
    );
    await extractor.extract({ systemPrompt: "sys", userPrompt });

    const cacheKey = createHash("sha256")
      .update("test-model", "utf8")
      .update("\u0000", "utf8")
      .update("provider-default-v1", "utf8")
      .update("\u0000", "utf8")
      .update("sys", "utf8")
      .update("\u0000", "utf8")
      .update(userPrompt, "utf8")
      .digest("hex");
    const shardPath = join(cacheRoot, cacheKey.slice(0, 2), `${cacheKey}.json`);
    const onDisk = JSON.parse(readFileSync(shardPath, "utf8")) as {
      raw_json: string;
      response_metadata: unknown;
    };
    expect(onDisk.raw_json).toBe(bigRawJson);
    expect(onDisk.response_metadata).toEqual({
      finish_reason: "stop",
      max_output_tokens: 2048,
      completion_contract_version: 1,
      completion_witness: "message",
      usage: { input_tokens: 17, output_tokens: 23, total_tokens: 40 }
    });

    // The fixture is reused on a second extractor with zero LLM calls — only
    // possible if the shard landed whole.
    const reread = createCachingSignalExtractor({
      delegate,
      config: {
        model: "test-model", modelFamily: "test-model",
        providerUrl: TEST_EXTRACTION_PROVIDER_URL,
        requestProfile: "provider-default-v1"
      },
      cacheRoot
    });
    const second = await reread.extract({
      systemPrompt: "sys",
      userPrompt
    });
    expect(second.rawJson).toBe(bigRawJson);
    expect(delegate.extract).toHaveBeenCalledTimes(1);
  });
});
