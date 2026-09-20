import type { BenchSignalExtractor } from "../compile-seed-types.js";

export const EXTRACTION_REQUEST_TIMEOUT_MS = 60_000;
export const EXTRACTION_OUTPUT_TOKEN_QUANTUM = 2_048;

/** One generateContent attempt: 60s per 2048 output tokens, matching the fill-pool request budget. */
export function resolveExtractionRequestTimeoutMs(
  maxOutputTokens = EXTRACTION_OUTPUT_TOKEN_QUANTUM
): number {
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) {
    throw new Error("extraction output-token ceiling must be a positive integer");
  }
  const timeoutMs = EXTRACTION_REQUEST_TIMEOUT_MS * Math.ceil(
    maxOutputTokens / EXTRACTION_OUTPUT_TOKEN_QUANTUM
  );
  if (!Number.isSafeInteger(timeoutMs)) {
    throw new Error("extraction request timeout exceeds the safe integer range");
  }
  return timeoutMs;
}

type GardenHttpExtractInput = Parameters<BenchSignalExtractor["extract"]>[0];

export function withAttemptOutputTokenLimit(
  input: GardenHttpExtractInput,
  useCeiling: boolean
): GardenHttpExtractInput {
  if (input.maxOutputTokens === undefined) return input;
  const maxOutputTokens = useCeiling
    ? input.maxOutputTokens
    : Math.min(EXTRACTION_OUTPUT_TOKEN_QUANTUM, input.maxOutputTokens);
  return { ...input, maxOutputTokens };
}

export function resolveAttemptIdleTimeoutMs(input: GardenHttpExtractInput): number {
  return Math.min(
    input.timeoutMs ?? EXTRACTION_REQUEST_TIMEOUT_MS,
    EXTRACTION_REQUEST_TIMEOUT_MS
  );
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
