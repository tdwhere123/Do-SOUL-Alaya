const ENV_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;
const ENV_POSITIVE_INT = /^[1-9][0-9]*$/u;
const ENV_NON_NEGATIVE_SAFE_INT = /^[0-9]+$/u;

/** Shared public-flag vocabulary. `2` and other tokens are invalid, not truthy. */
export const ENV_BOOLEAN_TRUE_TOKENS = ["1", "true", "on", "yes", "enabled"] as const;
export const ENV_BOOLEAN_FALSE_TOKENS = ["0", "false", "off", "no", "disabled"] as const;
export const ENV_BOOLEAN_VOCABULARY_ERROR =
  "must be true, false, 1, 0, on, off, yes, no, enabled, or disabled";

const ENV_FLAG_ON = new Set<string>(ENV_BOOLEAN_TRUE_TOKENS);
const ENV_FLAG_OFF = new Set<string>(ENV_BOOLEAN_FALSE_TOKENS);

export function parseEnvBoolean(
  raw: string | undefined,
  key: string,
  unset = false
): boolean {
  const normalized = normalizeEnvFlag(raw);
  if (normalized === undefined) return unset;
  if (ENV_FLAG_ON.has(normalized)) return true;
  if (ENV_FLAG_OFF.has(normalized)) return false;
  throw new Error(`${key} ${ENV_BOOLEAN_VOCABULARY_ERROR}`);
}

export function parseEnvOptionalBoolean(
  raw: string | undefined,
  key: string
): boolean | undefined {
  if (normalizeEnvFlag(raw) === undefined) return undefined;
  return parseEnvBoolean(raw, key);
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

export function parseSourceRefRobust(raw: string | undefined): boolean {
  return parseEnvBoolean(raw, "ALAYA_RECALL_SOURCE_REF_ROBUST");
}

export function parseDefaultOnFlag(raw: string | undefined, key: string): boolean {
  return parseEnvBoolean(raw, key, true);
}

/** True when the raw env value is an explicit disable token. Unset/empty is not disabled. */
export function isEnvFlagDisabled(raw: string | undefined, key = "env flag"): boolean {
  const normalized = normalizeEnvFlag(raw);
  if (normalized === undefined) return false;
  if (ENV_FLAG_OFF.has(normalized)) return true;
  if (ENV_FLAG_ON.has(normalized)) return false;
  throw new Error(`${key} ${ENV_BOOLEAN_VOCABULARY_ERROR}`);
}

function normalizeEnvFlag(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const normalized = raw.trim().toLowerCase();
  return normalized.length === 0 ? undefined : normalized;
}
