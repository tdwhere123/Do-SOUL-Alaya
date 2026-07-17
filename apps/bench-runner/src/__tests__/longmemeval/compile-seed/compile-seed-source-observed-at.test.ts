import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import {
  createCompileSeedRunner,
  type BenchSignalExtractor,
  type CompileSeedDaemon
} from "../../../longmemeval/compile-seed.js";
import type { BenchSignalSeedInput } from "../../../harness/daemon.js";
import { CREDENTIALLED_CONFIG } from "./compile-seed-fixture.js";
import { writeExtractionCacheTestManifest } from "../extraction/extraction-cache-test-fixture.js";

describe("compile seed source observation", () => {
  let cacheRoot: string;

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "compile-seed-observed-"));
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

  it("reuses raw extraction while deriving relative dates per source time", async () => {
    const seeded: BenchSignalSeedInput[] = [];
    let extractCalls = 0;
    const extractor: BenchSignalExtractor = {
      extract: async () => {
        extractCalls += 1;
        return { rawJson: relativeSignalEnvelope() };
      }
    };
    const runner = createCompileSeedRunner({
      config: CREDENTIALLED_CONFIG,
      cacheRoot,
      extractorFactory: () => extractor,
      allowLiveExtraction: true,
      skipPreflight: true
    });
    const daemon = createDaemon(seeded);

    await seedAt(runner, daemon, "2024-06-15T14:30:00.000Z", 0);
    await seedAt(runner, daemon, "2024-06-16T14:30:00.000Z", 1);

    expect(extractCalls).toBe(1);
    expect(runner.stats.cacheHits).toBe(1);
    expect(seeded.map((signal) => signal.productionRawPayload?.temporal_projection)).toEqual([
      expect.objectContaining({ event_time_start: "2024-06-15T00:00:00.000Z" }),
      expect.objectContaining({ event_time_start: "2024-06-16T00:00:00.000Z" })
    ]);
    expect(seeded.map((signal) => signal.productionRawPayload?.distilled_fact)).toEqual([
      "I completed the review today.",
      "I completed the review today."
    ]);
  });
});

function relativeSignalEnvelope(): string {
  return JSON.stringify({
    signals: [{
      signal_kind: "potential_claim",
      object_kind: "activity",
      confidence: 0.9,
      matched_text: "I completed the review today.",
      distilled_fact: "The operator completed the review on 2025-03-27.",
      temporal_projection: {
        projection_schema_version: 1,
        event_time_start: "2025-03-27",
        event_time_end: "2025-03-27",
        time_precision: "day",
        time_source: "turn_text"
      }
    }]
  });
}

function createDaemon(seeded: BenchSignalSeedInput[]): CompileSeedDaemon {
  return {
    proposeMemoriesFromCompileSignals: async (signals) => {
      seeded.push(...signals);
      return {
        seeds: signals.map((_, index) => ({
          memoryId: `memory-${seeded.length}-${index}`,
          signalId: `signal-${seeded.length}-${index}`,
          proposalId: `proposal-${seeded.length}-${index}`,
          evidenceId: `evidence-${seeded.length}-${index}`,
          truncated: false,
          charsClipped: 0
        })),
        dropped: []
      };
    },
    proposeMemoryFromSignal: async () => { throw new Error("unexpected fallback"); },
    proposeSynthesis: async () => ({ synthesisId: null })
  };
}

async function seedAt(
  runner: ReturnType<typeof createCompileSeedRunner>,
  daemon: CompileSeedDaemon,
  sourceObservedAt: string,
  seedIndex: number
): Promise<void> {
  await runner.seedTurn({
    daemon,
    turnContent: "I completed the review today.",
    evidenceRefBase: `q-s-r-${seedIndex}`,
    seedIndex,
    workspaceId: "workspace-1",
    runId: "run-1",
    sourceObservedAt
  });
}
