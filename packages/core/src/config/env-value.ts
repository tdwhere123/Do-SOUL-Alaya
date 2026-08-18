import {
  parseEnvBoolean,
  parseEnvOptionalNonNegativeSafeInt,
  parseEnvOptionalNumber,
  parseEnvPositiveInt
} from "@do-soul/alaya-protocol";

export {
  parseEnvBoolean,
  parseEnvOptionalNonNegativeSafeInt,
  parseEnvOptionalNumber,
  parseEnvPositiveInt
};

const DEFAULT_ON_OFF = /^(?:0|false|off|no|disabled)$/u;
const DEFAULT_ON_ON = /^(?:1|true|on|yes|enabled)$/u;

export function parseSourceRefRobust(raw: string | undefined): boolean {
  return parseEnvBoolean(raw, "ALAYA_RECALL_SOURCE_REF_ROBUST");
}

export function parseDefaultOnFlag(raw: string | undefined, key: string): boolean {
  if (raw === undefined) return true;
  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0) return true;
  if (DEFAULT_ON_OFF.test(normalized)) return false;
  if (DEFAULT_ON_ON.test(normalized)) return true;
  throw new Error(`${key} must be on, off, true, false, 1, or 0`);
}
