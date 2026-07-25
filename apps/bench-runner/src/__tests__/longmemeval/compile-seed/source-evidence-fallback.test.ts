import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import {
  createCompileSeedRunner,
  type CompileSeedDaemon
} from "../../../longmemeval/compile-seed.js";
import type {
  BenchSignalSeedInput
} from "../../../harness/daemon.js";
import type { SeededObjectResult } from
  "../../../harness/daemon/seed/daemon-seed-types.js";
import {
  CREDENTIALLED_CONFIG,
  signalsEnvelope
} from "./compile-seed-fixture.js";
import { writeExtractionCacheTestManifest } from
  "../extraction/extraction-cache-test-fixture.js";

let cacheRoot: string | undefined;

afterEach(async () => {
  if (cacheRoot !== undefined) {
    await rm(cacheRoot, { recursive: true, force: true });
  }
  cacheRoot = undefined;
});

describe("compile seed source evidence fallback", () => {
  it("sends an empty official extraction through the evidence-only receive path", async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "compile-source-evidence-"));
    writeExtractionCacheTestManifest({
      cacheRoot,
      model: CREDENTIALLED_CONFIG.model,
      providerUrl: CREDENTIALLED_CONFIG.providerUrl,
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
    });
    const received: BenchSignalSeedInput[] = [];
    const evidence: SeededObjectResult = {
      kind: "evidence_capsule",
      evidenceId: "evidence-only",
      signalId: "signal-evidence-only",
      truncated: false,
      charsClipped: 0
    };
    const daemon: CompileSeedDaemon = {
      proposeMemoryFromSignal: async () => {
        throw new Error("degraded fallback must not run");
      },
      proposeMemoriesFromCompileSignals: async (inputs) => {
        received.push(...inputs);
        return { seeds: [evidence], dropped: [], createdEvidence: true };
      },
      proposeSynthesis: async () => ({ synthesisId: null })
    };
    const runner = createCompileSeedRunner({
      config: CREDENTIALLED_CONFIG,
      cacheRoot,
      allowLiveExtraction: true,
      extractorFactory: () => ({
        extract: async () => ({ rawJson: "{\"signals\":[]}" })
      })
    });

    const result = await runner.seedTurn({
      daemon,
      turnContent: "Assistant: Take the 7:15 train from Central Station.",
      turnMessages: [{
        message_id: "assistant-1",
        role: "assistant",
        content: "Take the 7:15 train from Central Station."
      }],
      evidenceRefBase: "q-source-s0-r0",
      seedIndex: 0,
      workspaceId: "workspace-source",
      runId: "run-source",
      sourceEvidenceFallback: "trusted_source_turn",
      sourceObservedAt: "2026-07-20T00:00:00.000Z"
    });

    expect(received).toEqual([
      expect.objectContaining({
        evidenceFallbackReason: "empty_extraction",
        turnContent: "Assistant: Take the 7:15 train from Central Station.",
        extractionProvider: "official_api_compile"
      })
    ]);
    expect(result.seeds).toEqual([evidence]);
    expect(runner.stats.factsProduced).toBe(0);
  });

  it("does not add fallback evidence when extraction materializes memory", async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "compile-source-memory-"));
    writeExtractionCacheTestManifest({
      cacheRoot,
      model: CREDENTIALLED_CONFIG.model,
      providerUrl: CREDENTIALLED_CONFIG.providerUrl,
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
    });
    const received: BenchSignalSeedInput[] = [];
    const daemon: CompileSeedDaemon = {
      proposeMemoryFromSignal: async () => {
        throw new Error("degraded fallback must not run");
      },
      proposeMemoriesFromCompileSignals: async (inputs) => {
        received.push(...inputs);
        return {
          seeds: [{
            kind: "memory_entry",
            memoryId: "memory-one",
            evidenceId: "evidence-one",
            signalId: "signal-one",
            proposalId: "proposal-one",
            truncated: false,
            charsClipped: 0
          }],
          dropped: [],
          createdEvidence: true
        };
      },
      proposeSynthesis: async () => ({ synthesisId: null })
    };
    const runner = createCompileSeedRunner({
      config: CREDENTIALLED_CONFIG,
      cacheRoot,
      allowLiveExtraction: true,
      extractorFactory: () => ({
        extract: async () => ({
          rawJson: signalsEnvelope([{
            distilled: "The user takes the 7:15 train.",
            matched: "I take the 7:15 train."
          }])
        })
      })
    });

    const result = await runner.seedTurn({
      daemon,
      turnContent: "I take the 7:15 train.",
      evidenceRefBase: "q-memory-s0-r0",
      seedIndex: 0,
      workspaceId: "workspace-memory",
      runId: "run-memory"
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.evidenceFallbackReason).toBeUndefined();
    expect(result.seeds).toEqual([
      expect.objectContaining({ kind: "memory_entry", memoryId: "memory-one" })
    ]);
  });

  it("adds the production no-evidence-created fallback after an unroutable batch", async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "compile-source-no-evidence-"));
    writeExtractionCacheTestManifest({
      cacheRoot,
      model: CREDENTIALLED_CONFIG.model,
      providerUrl: CREDENTIALLED_CONFIG.providerUrl,
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
    });
    const received: BenchSignalSeedInput[][] = [];
    const daemon: CompileSeedDaemon = {
      proposeMemoryFromSignal: async () => {
        throw new Error("degraded fallback must not run");
      },
      proposeMemoriesFromCompileSignals: async (inputs) => {
        received.push([...inputs]);
        if (received.length === 1) {
          return {
            seeds: [],
            dropped: [{
              reason: "candidate_absent",
              detail: "triage=deferred routing=n/a"
            }],
            createdEvidence: false
          };
        }
        return {
          seeds: [{
            kind: "evidence_capsule",
            evidenceId: "evidence-fallback",
            signalId: "signal-fallback",
            truncated: false,
            charsClipped: 0
          }],
          dropped: [],
          createdEvidence: true
        };
      },
      proposeSynthesis: async () => ({ synthesisId: null })
    };
    const runner = createRunnerWithOneClaim(cacheRoot);

    const result = await runner.seedTurn(seedInput(daemon));

    expect(received).toHaveLength(2);
    expect(received[0]?.[0]?.evidenceFallbackReason).toBeUndefined();
    expect(received[1]).toEqual([
      expect.objectContaining({
        evidenceFallbackReason: "no_evidence_created",
        signalKind: "potential_evidence_anchor",
        objectKind: "source_turn"
      })
    ]);
    expect(result.seeds).toEqual([
      expect.objectContaining({
        kind: "evidence_capsule",
        evidenceId: "evidence-fallback"
      })
    ]);
  });

  it("keeps ordinary evidence-only materialization dropped without relabeling it trusted", async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "compile-source-untrusted-"));
    writeExtractionCacheTestManifest({
      cacheRoot,
      model: CREDENTIALLED_CONFIG.model,
      providerUrl: CREDENTIALLED_CONFIG.providerUrl,
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
    });
    let calls = 0;
    const daemon: CompileSeedDaemon = {
      proposeMemoryFromSignal: async () => {
        throw new Error("degraded fallback must not run");
      },
      proposeMemoriesFromCompileSignals: async () => {
        calls += 1;
        return {
          seeds: [],
          dropped: [{
            reason: "candidate_absent",
            detail: "triage=evidence_only routing=evidence_only"
          }],
          createdEvidence: true
        };
      },
      proposeSynthesis: async () => ({ synthesisId: null })
    };
    const runner = createRunnerWithOneClaim(cacheRoot);

    const result = await runner.seedTurn(seedInput(daemon));

    expect(calls).toBe(1);
    expect(result.seeds).toEqual([]);
    expect(runner.stats.signalsDroppedByReason.candidate_absent).toBe(1);
  });

  it("does not create source-only objects when a consumer disables the fallback", async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "compile-source-disabled-"));
    writeExtractionCacheTestManifest({
      cacheRoot,
      model: CREDENTIALLED_CONFIG.model,
      providerUrl: CREDENTIALLED_CONFIG.providerUrl,
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
    });
    let compileSeedCalls = 0;
    const daemon: CompileSeedDaemon = {
      proposeMemoryFromSignal: async () => {
        throw new Error("degraded fallback must not run");
      },
      proposeMemoriesFromCompileSignals: async () => {
        compileSeedCalls += 1;
        return { seeds: [], dropped: [], createdEvidence: false };
      },
      proposeSynthesis: async () => ({ synthesisId: null })
    };
    const runner = createCompileSeedRunner({
      config: CREDENTIALLED_CONFIG,
      cacheRoot,
      allowLiveExtraction: true,
      extractorFactory: () => ({
        extract: async () => ({ rawJson: "{\"signals\":[]}" })
      })
    });

    const result = await runner.seedTurn({
      ...seedInput(daemon),
      sourceEvidenceFallback: "disabled"
    });

    expect(compileSeedCalls).toBe(0);
    expect(result.seeds).toEqual([]);
  });

  it("defaults source-only fallback to disabled without a trusted opt-in", async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "compile-source-default-closed-"));
    writeExtractionCacheTestManifest({
      cacheRoot,
      model: CREDENTIALLED_CONFIG.model,
      providerUrl: CREDENTIALLED_CONFIG.providerUrl,
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
    });
    let compileSeedCalls = 0;
    const daemon: CompileSeedDaemon = {
      proposeMemoryFromSignal: async () => {
        throw new Error("degraded fallback must not run");
      },
      proposeMemoriesFromCompileSignals: async () => {
        compileSeedCalls += 1;
        return { seeds: [], dropped: [], createdEvidence: false };
      },
      proposeSynthesis: async () => ({ synthesisId: null })
    };
    const runner = createCompileSeedRunner({
      config: CREDENTIALLED_CONFIG,
      cacheRoot,
      allowLiveExtraction: true,
      extractorFactory: () => ({
        extract: async () => ({ rawJson: "{\"signals\":[]}" })
      })
    });
    const result = await runner.seedTurn({
      daemon,
      turnContent: "I take the 7:15 train.",
      evidenceRefBase: "q-memory-s0-r0",
      seedIndex: 0,
      workspaceId: "workspace-memory",
      runId: "run-memory"
    });

    expect(compileSeedCalls).toBe(0);
    expect(result.seeds).toEqual([]);
  });
});

function createRunnerWithOneClaim(cacheRoot: string) {
  return createCompileSeedRunner({
    config: CREDENTIALLED_CONFIG,
    cacheRoot,
    allowLiveExtraction: true,
    extractorFactory: () => ({
      extract: async () => ({
        rawJson: signalsEnvelope([{
          distilled: "The user takes the 7:15 train.",
          matched: "I take the 7:15 train."
        }])
      })
    })
  });
}

function seedInput(daemon: CompileSeedDaemon) {
  return {
    daemon,
    turnContent: "I take the 7:15 train.",
    evidenceRefBase: "q-memory-s0-r0",
    seedIndex: 0,
    workspaceId: "workspace-memory",
    runId: "run-memory",
    sourceEvidenceFallback: "trusted_source_turn" as const
  };
}
