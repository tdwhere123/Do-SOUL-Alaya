export const EXTRACTION_FILL_DEFAULT_CONCURRENCY = 32;
export const EXTRACTION_FILL_MAX_CONCURRENCY = 32;

export function resolveExtractionFillConcurrency(raw: number | undefined): number {
  const value = raw ?? EXTRACTION_FILL_DEFAULT_CONCURRENCY;
  if (!Number.isSafeInteger(value) || value < 1 || value > EXTRACTION_FILL_MAX_CONCURRENCY) {
    throw new Error(
      `extraction-fill concurrency must be an integer from 1 to ${EXTRACTION_FILL_MAX_CONCURRENCY}`
    );
  }
  return value;
}

export function resolveExtractionFillInitialConcurrency(
  raw: number | undefined,
  maximum: number
): number {
  const value = raw ?? maximum;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(
      `extraction-fill initial concurrency must be an integer from 1 to ${maximum}`
    );
  }
  return value;
}
