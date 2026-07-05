export { createCachingSignalExtractor } from "./compile-seed-cache.js";
export {
  EXTRACTION_CACHE_ROOT,
  resolveBenchAllowLiveExtraction,
  resolveCompileSeedExtractionConfig,
  toSeedExtractionPathKpi
} from "./compile-seed-config.js";
export {
  createGardenHttpExtractor,
  extractContentFromChatCompletionBody
} from "./compile-seed-http.js";
export { preflightExtractionCache } from "./compile-seed-preflight.js";
export {
  resolveBenchExtractionCacheMinCoverage,
  resolveBenchRequireExtractionCacheManifest
} from "./compile-seed-config.js";
export { collectBenchSeedFuelInventory } from "./seed-fuel-collector.js";
export { toSeedFuelInventoryKpi } from "./seed-fuel-inventory-kpi.js";
export {
  buildSessionSynthesisInput,
  computeNextTurnSeedRefs,
  type SessionSeededTurn
} from "./compile-seed-session.js";
export type {
  BenchRetryClassification,
  BenchSignalExtractor,
  BenchSignalExtractorMeta,
  CompileSeedDaemon,
  CompileSeedExtractionConfig,
  CompileSeedExtractionStats,
  CompileSeedResult,
  CompileSeedRunner,
  CompileSeedRunnerOptions,
  CompileSeedTurnInput,
  SeedExtractionPathKpi
} from "./compile-seed-types.js";
import type {
  CompileSeedRunner,
  CompileSeedRunnerOptions
} from "./compile-seed-types.js";
import { createCompileSeedRunnerContext } from "./compile-seed-runner-context.js";
import { seedCompileTurn } from "./compile-seed-turn.js";

/**
 * @anchor longmemeval-compile-seed
 *
 * Field-standard ingestion for the LongMemEval bench seed path. Each haystack
 * turn is run through production garden extraction when credentials exist, or
 * the explicit no-credentials full-turn fallback when they do not. The runner
 * keeps one stats object for the whole bench run so archive KPIs disclose the
 * actual extraction path and every drop stage.
 */
export function createCompileSeedRunner(
  options?: CompileSeedRunnerOptions
): CompileSeedRunner {
  const context = createCompileSeedRunnerContext(options);
  return {
    stats: context.stats,
    seedTurn: (input) => seedCompileTurn(context, input)
  };
}
