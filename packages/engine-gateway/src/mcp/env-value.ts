const ENV_POSITIVE_INT = /^[1-9][0-9]*$/u;

// engine-gateway depends only on protocol, so it cannot import core's
// env-value owner. Keep this parser identical to
// packages/core/src/runtime/config/env-value.ts#parseEnvPositiveInt.
// Delete when a protocol env-value helper exists.
export function parseEnvPositiveInt(
  raw: string | undefined,
  key: string
): number | undefined {
  if (raw === undefined) return undefined;
  const normalized = raw.trim();
  if (normalized.length === 0 || !ENV_POSITIVE_INT.test(normalized)) {
    throw new Error(`${key} must be a positive integer`);
  }
  const value = Number(normalized);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${key} must be a positive integer`);
  }
  return value;
}
