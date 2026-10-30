export { createCachingSignalExtractor } from "./compile-seed/compile-seed-cache.js";
export {
  EXTRACTION_CACHE_ROOT,
  resolveCompileSeedExtractionConfig,
  resolveEffectiveExtractionCacheRoot,
  toSeedExtractionPathKpi
} from "./compile-seed/compile-seed-config.js";
export {
  createGardenHttpExtractor
} from "./compile-seed/compile-seed-http.js";
// Bench HTTP extractor surface; git workspace rate limits live in core-daemon
// (createWorkspaceGitRateLimiter), not here.
export { preflightExtractionCache } from "./compile-seed/compile-seed-preflight.js";
export {
  resolveBenchExtractionCacheMinCoverage,
  resolveBenchRequireExtractionCacheManifest
} from "./compile-seed/compile-seed-config.js";
export { collectBenchSeedFuelInventory } from "./extraction/seed-fuel/seed-fuel-collector.js";
export { toSeedFuelInventoryKpi } from "./extraction/seed-fuel/seed-fuel-inventory-kpi.js";
export {
  buildSessionSynthesisInput,
  computeNextTurnSeedRefs,
  type SessionSeededTurn
} from "./compile-seed/compile-seed-session.js";
export type {
  BenchRetryClassification,
  BenchProviderUsage,
  BenchSignalExtractor,
  BenchSignalExtractorMeta,
  BenchTerminalRetryClassification,
  CompileSeedDaemon,
  CompileSeedExtractionConfig,
  CompileSeedExtractionStats,
  CompileSeedResult,
  CompileSeedRunner,
  CompileSeedRunnerOptions,
  CompileSeedTurnInput,
  SeedExtractionPathKpi
} from "./compile-seed/compile-seed-types.js";
import type {
  CompileSeedRunner,
  CompileSeedRunnerOptions
} from "./compile-seed/compile-seed-types.js";
import { createCompileSeedRunnerContext } from "./compile-seed/compile-seed-runner-context.js";
import { seedCompileTurn } from "./compile-seed/compile-seed-turn.js";

/**
 * @anchor longmemeval-compile-seed
 *
 * Field-standard ingestion for the LongMemEval bench seed path. Each haystack
 * turn is run through production garden extraction from a validated cache.
 * Live extraction belongs to extraction-fill's receipt/attempt authority.
 * The full-turn fallback is reserved
 * for the manifest-less no-credentials path. The runner keeps one stats object
 * for the whole bench run so archive KPIs disclose the actual extraction path
 * and every drop stage.
 */
export function createCompileSeedRunner(
  options?: CompileSeedRunnerOptions
): CompileSeedRunner {
  const context = createCompileSeedRunnerContext(options);
  let pending = Promise.resolve();
  return {
    stats: context.stats,
    ...(context.extractionCachePreflightProof === undefined ? {} : {
      extractionCachePreflightProof: context.extractionCachePreflightProof
    }),
    seedTurn: (input) => {
      const captured = { ...input,
        ...(input.turnMessages === undefined ? {} : { turnMessages: structuredClone(input.turnMessages) }),
        ...(input.sourceSession === undefined ? {} : { sourceSession: structuredClone(input.sourceSession) }),
        ...(input.sourceSessionRounds === undefined ? {} : { sourceSessionRounds: structuredClone(input.sourceSessionRounds) }) };
      const result = pending.then(() => seedCompileTurn(context, captured));
      pending = result.then(() => undefined, () => undefined);
      return result;
    }
  };
}
