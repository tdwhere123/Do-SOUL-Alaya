import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import {
  inspectCachedExtraction,
  type CachedExtractionInspection
} from "./cache-shard.js";
import type {
  CompileSeedExtractionConfig,
  RawShardInspectionDiagnostics,
  RawShardInspectionPhase
} from "../compile-seed-types.js";

interface MutablePhaseDiagnostics {
  physicalReads: number;
  parseMisses: number;
  memoHits: number;
  inspectionMs: number;
}

export interface RunnerRawShardInspectionInput {
  readonly phase: RawShardInspectionPhase;
  readonly cacheRoot: string;
  readonly cacheKey: string;
  readonly model: string;
  readonly requestProfile: CompileSeedExtractionConfig["requestProfile"];
}

export interface RunnerRawShardInspector {
  readonly diagnostics: RawShardInspectionDiagnostics;
  inspect(input: RunnerRawShardInspectionInput): CachedExtractionInspection;
}

export function createRunnerRawShardInspector(): RunnerRawShardInspector {
  const phases = {
    primary: mutablePhaseDiagnostics(),
    supplement: mutablePhaseDiagnostics()
  };
  const memo = new Map<string, CachedExtractionInspection>();
  return Object.freeze({
    diagnostics: diagnosticsView(phases),
    inspect(input: RunnerRawShardInspectionInput): CachedExtractionInspection {
      const cacheRoot = resolve(input.cacheRoot);
      const identity = JSON.stringify([
        cacheRoot,
        input.cacheKey,
        input.model,
        input.requestProfile
      ]);
      const phase = phases[input.phase];
      const memoized = memo.get(identity);
      if (memoized !== undefined) {
        phase.memoHits += 1;
        return memoized;
      }
      const startedAt = performance.now();
      const inspected = inspectCachedExtraction(
        cacheRoot,
        input.cacheKey,
        input.model,
        input.requestProfile,
        {
          onPhysicalRead: () => { phase.physicalReads += 1; },
          onParseMiss: () => { phase.parseMisses += 1; }
        }
      );
      phase.inspectionMs += performance.now() - startedAt;
      if (inspected.status !== "hit") return inspected;
      const verified = Object.freeze({ ...inspected });
      memo.set(identity, verified);
      return verified;
    }
  });
}

function mutablePhaseDiagnostics(): MutablePhaseDiagnostics {
  return { physicalReads: 0, parseMisses: 0, memoHits: 0, inspectionMs: 0 };
}

function diagnosticsView(
  phases: Readonly<Record<RawShardInspectionPhase, MutablePhaseDiagnostics>>
): RawShardInspectionDiagnostics {
  return Object.freeze({
    primary: phaseView(phases.primary),
    supplement: phaseView(phases.supplement)
  });
}

function phaseView(phase: MutablePhaseDiagnostics) {
  return Object.freeze({
    get physicalReads() { return phase.physicalReads; },
    get parseMisses() { return phase.parseMisses; },
    get memoHits() { return phase.memoHits; },
    get inspectionMs() { return phase.inspectionMs; }
  });
}
