import type {
  BenchSignalSeedInput,
  SeededMemoryResult
} from "../../../harness/daemon.js";
import type { SeededObjectResult } from
  "../../../harness/daemon/seed/daemon-seed-types.js";
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
    proposeMemoriesFromCompileSignals: async (inputs) => {
      const seeds = inputs.map((input) => seedCompileInput(input, onSignal));
      return {
        seeds,
        dropped: [],
        createdEvidence: seeds.some(seedCreatedEvidence)
      };
    },
    proposeSynthesis: async () => ({ synthesisId: null })
  };
}

function seedCreatedEvidence(seed: SeededObjectResult): boolean {
  return seed.kind === "evidence_capsule" || seed.evidenceId !== null;
}

function seedCompileInput(
  input: BenchSignalSeedInput,
  onSignal: (input: BenchSignalSeedInput) => SeededMemoryResult
): SeededObjectResult {
  if (input.evidenceFallbackReason === undefined) return onSignal(input);
  return {
    kind: "evidence_capsule",
    evidenceId: `evidence-${input.evidenceRef}`,
    signalId: `signal-${input.evidenceRef}`,
    truncated: false,
    charsClipped: 0
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
    signals: facts.map((fact) => withOpenSemanticFactorGraph({
      signal_kind: "potential_preference",
      object_kind: "user_preference",
      confidence: 0.9,
      matched_text: fact.matched,
      distilled_fact: fact.distilled,
      source_locator: {
        contract_version: 2,
        kind: "assertion_catalog",
        assertion_id: 1
      }
    }))
  });
}

export function withOpenSemanticFactorGraph<T extends Readonly<{
  readonly matched_text: string;
}>>(signal: T): T & Readonly<{ semantic_factor_graph: Readonly<Record<string, unknown>> }> {
  const surface = signal.matched_text.slice(0, 64);
  return {
    ...signal,
    semantic_factor_graph: {
      schema_version: 1,
      source_kind: "evidence",
      factors: [{
        factor_id: "fact",
        semantic_identity: surface.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase(),
        surface,
        source_occurrence: 0
      }],
      variables: [],
      result_variable_ids: [],
      propositions: [{
        proposition_id: "fact-proposition",
        predicate_factor_id: "fact",
        arguments: [{
          position: 0,
          binding_identity: "fact",
          reference_kind: "factor",
          reference_id: "fact"
        }]
      }]
    }
  };
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
