const ENV_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;
const ENV_POSITIVE_INT = /^[1-9][0-9]*$/u;
const ENV_NON_NEGATIVE_SAFE_INT = /^[0-9]+$/u;

export function parseEnvBoolean(raw: string | undefined, key: string): boolean {
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0) return false;
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  throw new Error(`${key} must be true, false, 1, or 0`);
}

export function parseEnvOptionalNumber(
  raw: string | undefined,
  key: string
): number | undefined {
  if (raw === undefined) return undefined;
  const normalized = raw.trim();
  if (normalized.length === 0 || !ENV_NUMBER.test(normalized)) {
    throw new Error(`${key} must be a finite number`);
  }
  const value = Number(normalized);
  if (!Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number`);
  }
  return value;
}

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

export function parseEnvOptionalNonNegativeSafeInt(
  raw: string | undefined,
  key: string
): number | undefined {
  if (raw === undefined) return undefined;
  const normalized = raw.trim();
  const value = Number(normalized);
  if (!ENV_NON_NEGATIVE_SAFE_INT.test(normalized) || !Number.isSafeInteger(value)) {
    throw new Error(`${key} must be a non-negative safe integer`);
  }
  return value;
}
