import type { BenchRetryClassification } from "../compile-seed-types.js";

export type BenchHttpError = {
  readonly classification: BenchRetryClassification;
  readonly retryable: boolean;
};

export function classifyBenchHttpError(
  error: unknown,
  status: number | null
): BenchHttpError {
  if (error instanceof Error && /abort/iu.test(error.name + error.message)) {
    return { classification: "failure_aborted", retryable: false };
  }
  if (status === 429 || (status !== null && status >= 500 && status < 600)) {
    return { classification: "failure_max_retries", retryable: true };
  }
  if (status !== null && status >= 400 && status < 500) {
    return { classification: "failure_non_retryable_4xx", retryable: false };
  }
  return { classification: "failure_max_retries", retryable: true };
}

export function readStatusFromBenchError(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const status = (error as { readonly status?: unknown }).status;
  if (typeof status === "number" && Number.isFinite(status)) return status;
  if (!(error instanceof Error)) return null;
  const match = /\bHTTP\s+(\d{3})\b/u.exec(error.message);
  if (match === null) return null;
  const parsed = Number.parseInt(match[1]!, 10);
  return Number.isFinite(parsed) ? parsed : null;
}
