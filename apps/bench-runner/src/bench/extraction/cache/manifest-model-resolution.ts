export const BENCH_EXTRACTION_MODEL_ENV = "OFFICIAL_API_GARDEN_MODEL";

export function resolveBenchExtractionModel(
  env: NodeJS.ProcessEnv = process.env,
  manifest?: { readonly extraction_model: string }
): string {
  const model = readNonEmptyEnv(env[BENCH_EXTRACTION_MODEL_ENV]) ??
    manifest?.extraction_model;
  if (model === undefined || model.trim().length === 0) {
    throw new Error(
      "bench extraction model is unresolved: neither env " +
        `${BENCH_EXTRACTION_MODEL_ENV} is set nor does the extraction cache manifest ` +
        "declare extraction_model. Export the extraction model env var " +
        "in the bench environment or build the cache manifest first. Refusing to " +
        "fall back to a default model — a wrong default silently misses every " +
        "cache key and degrades to a full live extraction."
    );
  }
  return model;
}

function readNonEmptyEnv(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
