export { createCachingSignalExtractor } from "./compile-seed/compile-seed-cache.js";
export {
  EXTRACTION_CACHE_ROOT,
  resolveBenchAllowLiveExtraction,
  resolveCompileSeedExtractionConfig,
  resolveEffectiveExtractionCacheRoot,
  toSeedExtractionPathKpi
} from "./compile-seed/compile-seed-config.js";
export {
  createGardenHttpExtractor,
  extractContentFromChatCompletionBody
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
 * turn is run through production garden extraction from a validated cache or
 * an explicitly enabled live transport. The full-turn fallback is reserved
 * for the manifest-less no-credentials path. The runner keeps one stats object
 * for the whole bench run so archive KPIs disclose the actual extraction path
 * and every drop stage.
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
