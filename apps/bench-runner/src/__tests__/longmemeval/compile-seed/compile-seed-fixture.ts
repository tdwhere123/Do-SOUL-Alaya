import type { BenchSignalSeedInput, SeededMemoryResult } from "../../../harness/daemon.js";
import {
  type CompileSeedDaemon,
  type CompileSeedExtractionConfig
} from "../../../longmemeval/compile-seed.js";

/**
 * A test CompileSeedDaemon stub. The compile (credentialled) seed path
 * materializes a round's signals through proposeMemoriesFromCompileSignals
 * (the in-process signalService.receiveSignal seam); the no-credentials
 * fallback path uses proposeMemoryFromSignal. Both delegate to one per-signal
 * handler so tests can inspect every BenchSignalSeedInput regardless of path.
 */
export function buildCompileSeedDaemon(
  onSignal: (input: BenchSignalSeedInput) => SeededMemoryResult
): CompileSeedDaemon {
  return {
    proposeMemoryFromSignal: async (input) => onSignal(input),
    proposeMemoriesFromCompileSignals: async (inputs) => ({
      seeds: inputs.map(onSignal),
      dropped: []
    }),
    proposeSynthesis: async () => ({ synthesisId: null })
  };
}

export const CREDENTIALLED_CONFIG: CompileSeedExtractionConfig = {
  providerUrl: "https://example.test/v1",
  model: "test-model",
  requestProfile: "provider-default-v1",
  apiKey: "test-key"
};

export const OFFLINE_CONFIG: CompileSeedExtractionConfig = {
  providerUrl: "https://example.test/v1",
  model: "test-model",
  requestProfile: "provider-default-v1",
  apiKey: null
};

export function signalsEnvelope(
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

export function makeSeed(memoryId: string): SeededMemoryResult {
  return {
    memoryId,
    signalId: `signal-${memoryId}`,
    proposalId: `proposal-${memoryId}`,
    evidenceId: `evidence-${memoryId}`,
    truncated: false,
    charsClipped: 0
  };
}
