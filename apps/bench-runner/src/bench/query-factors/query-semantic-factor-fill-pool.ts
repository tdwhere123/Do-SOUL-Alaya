export async function mapQueryFactorSourcesWithFailureScope<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<readonly unknown[]> {
  let cursor = 0;
  let providerFailure: unknown;
  const sourceLocalFailures: unknown[] = [];
  const pump = async (): Promise<void> => {
    while (providerFailure === undefined && cursor < items.length) {
      const index = cursor++;
      const item = items[index];
      if (item === undefined) continue;
      try {
        await worker(item, index);
      } catch (error) {
        if (hasResponseSchemaFailure(error)) {
          sourceLocalFailures.push(error);
          continue;
        }
        providerFailure ??= error;
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) }, pump
  ));
  if (providerFailure !== undefined) throw providerFailure;
  return Object.freeze(sourceLocalFailures);
}

function hasResponseSchemaFailure(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current !== null; depth += 1) {
    if (readTransportFailures(current).some((failure) =>
      readFailureKind(failure) === "response_schema_error")) return true;
    current = readCause(current);
  }
  return false;
}

function readTransportFailures(value: unknown): readonly unknown[] {
  if (typeof value !== "object" || value === null) return [];
  const retry = (value as { readonly benchRetry?: unknown }).benchRetry;
  if (typeof retry !== "object" || retry === null) return [];
  const failures = (retry as { readonly transportFailures?: unknown }).transportFailures;
  return Array.isArray(failures) ? failures : [];
}

function readFailureKind(value: unknown): unknown {
  return typeof value === "object" && value !== null
    ? (value as { readonly kind?: unknown }).kind
    : undefined;
}

function readCause(value: unknown): unknown {
  return typeof value === "object" && value !== null
    ? (value as { readonly cause?: unknown }).cause ?? null
    : null;
}
