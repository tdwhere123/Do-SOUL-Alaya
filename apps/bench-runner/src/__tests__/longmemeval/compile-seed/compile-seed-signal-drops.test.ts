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
    const turnContent = `Intro sentence. ${oversizedSpan}. Closing sentence.`;
    const runner = createCompileSeedRunner({
      config: CREDENTIALLED_CONFIG,
      cacheRoot,
      allowLiveExtraction: true,
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
      allowLiveExtraction: true,
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
      signals: Array.from({ length: 200 }, (_, i) => ({
        signal_kind: "potential_preference",
        object_kind: "user_preference",
        confidence: 0.9,
        matched_text: `span ${i}`,
        distilled_fact: `Fact number ${i}.`
      }))
    });
    const delegate: BenchSignalExtractor = {
      extract: vi.fn(async () => ({
        rawJson: bigRawJson,
        responseMetadata: { finishReason: "stop", maxOutputTokens: 2048 },
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
    await extractor.extract({ systemPrompt: "sys", userPrompt: "atomic-turn" });

    const cacheKey = createHash("sha256")
      .update("test-model", "utf8")
      .update("\u0000", "utf8")
      .update("provider-default-v1", "utf8")
      .update("\u0000", "utf8")
      .update("sys", "utf8")
      .update("\u0000", "utf8")
      .update("atomic-turn", "utf8")
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
      userPrompt: "atomic-turn"
    });
    expect(second.rawJson).toBe(bigRawJson);
    expect(delegate.extract).toHaveBeenCalledTimes(1);
  });
});
