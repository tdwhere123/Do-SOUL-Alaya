export const EXTRACTION_BENCH_MODES = ["precomputed_full", "lazy_field"] as const;
export type ExtractionBenchMode = (typeof EXTRACTION_BENCH_MODES)[number];

export interface PrecomputedFullMode {
  readonly mode: "precomputed_full";
  readonly corpusIdentity: string;
  readonly completeAuthority: true;
}

export interface LazyFieldMode {
  readonly mode: "lazy_field";
  readonly f0f2SubstrateIdentity: string;
  readonly startingCacheIdentity: string;
  readonly capabilityPolicy: readonly string[];
  readonly maxCalls: number;
}

export type ExtractionBenchModeConfig = PrecomputedFullMode | LazyFieldMode;

export function parseExtractionBenchMode(value: unknown): ExtractionBenchModeConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("extraction bench mode identity is missing");
  }
  const record = value as Record<string, unknown>;
  if (record.mode === "precomputed_full") {
    if (record.completeAuthority !== true || typeof record.corpusIdentity !== "string") {
      throw new Error("precomputed_full requires complete extraction authority");
    }
    return { mode: "precomputed_full", corpusIdentity: record.corpusIdentity, completeAuthority: true };
  }
  if (record.mode === "lazy_field") {
    if (typeof record.f0f2SubstrateIdentity !== "string" ||
        typeof record.startingCacheIdentity !== "string" ||
        !Array.isArray(record.capabilityPolicy) ||
        !record.capabilityPolicy.every((item) => typeof item === "string" && item.trim().length > 0) ||
        !Number.isSafeInteger(record.maxCalls) || (record.maxCalls as number) < 0) {
      throw new Error("lazy_field mode identity is incomplete");
    }
    return {
      mode: "lazy_field",
      f0f2SubstrateIdentity: record.f0f2SubstrateIdentity,
      startingCacheIdentity: record.startingCacheIdentity,
      capabilityPolicy: Object.freeze([...new Set(record.capabilityPolicy as string[])]),
      maxCalls: record.maxCalls as number
    };
  }
  throw new Error("unknown extraction bench mode");
}

export function assertRecallZeroLiveExtraction(input: {
  readonly providerExecutorEntries: number;
  readonly extractionWrites: number;
}): void {
  if (input.providerExecutorEntries !== 0 || input.extractionWrites !== 0) {
    throw new Error("recall campaign attempted live extraction");
  }
}
