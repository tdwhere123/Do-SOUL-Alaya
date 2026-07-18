import type { BenchSignalExtractor } from "../compile-seed-types.js";

const INITIAL_EXTRACTION_OUTPUT_TOKENS = 2048;
type GardenHttpExtractInput = Parameters<BenchSignalExtractor["extract"]>[0];

export function withAttemptOutputTokenLimit(
  input: GardenHttpExtractInput,
  useCeiling: boolean
): GardenHttpExtractInput {
  if (input.maxOutputTokens === undefined) return input;
  const maxOutputTokens = useCeiling
    ? input.maxOutputTokens
    : Math.min(INITIAL_EXTRACTION_OUTPUT_TOKENS, input.maxOutputTokens);
  return { ...input, maxOutputTokens };
}

export function markOutputTokenTruncation(error: Error): Error {
  (error as { benchOutputTokenTruncation?: boolean }).benchOutputTokenTruncation = true;
  return error;
}

export function isOutputTokenTruncation(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    (error as { readonly benchOutputTokenTruncation?: unknown })
      .benchOutputTokenTruncation === true;
}
