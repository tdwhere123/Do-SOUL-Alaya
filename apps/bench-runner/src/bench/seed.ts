import {
  createCompileSeedRunner,
  resolveBenchAllowLiveExtraction,
  type CompileSeedExtractionStats,
  type CompileSeedRunner
} from "./compile-seed.js";

export function createCampaignSeedRunner(input: {
  readonly requiredTurnContents: readonly string[];
  readonly offset: number;
  readonly windowLength: number;
}): CompileSeedRunner {
  return createCompileSeedRunner({
    requiredTurnContents: input.requiredTurnContents,
    requiredQuestionWindow: { offset: input.offset, limit: input.windowLength },
    ...(resolveBenchAllowLiveExtraction() ? { allowLiveExtraction: true } : {})
  });
}

export function logSeedExtractionStats(
  label: string,
  stats: CompileSeedExtractionStats
): void {
  process.stdout.write(
    `[${label} compile-seed] path=${stats.path} ` +
      `cache_hits=${stats.cacheHits} ` +
      `llm_calls=${stats.llmCalls} ` +
      `offline_fallbacks=${stats.offlineFallbacks} ` +
      `facts=${stats.factsProduced} ` +
      `signals_dropped=${stats.signalsDropped}\n`
  );
}
