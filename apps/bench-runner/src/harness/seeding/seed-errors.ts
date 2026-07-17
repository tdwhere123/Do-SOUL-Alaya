export const UNSCORED_MATERIALIZED_SEED_KIND = "unscored_materialized_seed";

export interface UnscoredMaterializedSeedError extends Error {
  readonly benchSeedErrorKind: typeof UNSCORED_MATERIALIZED_SEED_KIND;
  readonly memoryId: string;
  readonly evidenceRef: string;
}

export function createUnscoredMaterializedSeedError(input: {
  readonly memoryId: string;
  readonly evidenceRef: string;
  readonly cause: unknown;
}): UnscoredMaterializedSeedError {
  const detail = input.cause instanceof Error ? input.cause.message : String(input.cause);
  const error = new Error(
    `bench seed accept failed after memory_entry=${input.memoryId} materialized; ` +
      `refusing to score a run with recallable unscored seed memory: ${detail}`
  ) as UnscoredMaterializedSeedError;
  error.name = "UnscoredMaterializedSeedError";
  Object.defineProperties(error, {
    benchSeedErrorKind: {
      value: UNSCORED_MATERIALIZED_SEED_KIND,
      enumerable: true
    },
    memoryId: {
      value: input.memoryId,
      enumerable: true
    },
    evidenceRef: {
      value: input.evidenceRef,
      enumerable: true
    }
  });
  return error;
}

export function isUnscoredMaterializedSeedError(
  error: unknown
): error is UnscoredMaterializedSeedError {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { readonly benchSeedErrorKind?: unknown }).benchSeedErrorKind ===
      UNSCORED_MATERIALIZED_SEED_KIND
  );
}
