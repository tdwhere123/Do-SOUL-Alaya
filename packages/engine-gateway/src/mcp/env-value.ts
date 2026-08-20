const ENV_POSITIVE_INT = /^[1-9][0-9]*$/u;

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
