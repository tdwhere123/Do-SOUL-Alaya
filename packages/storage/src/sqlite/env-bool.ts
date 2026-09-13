const ENV_FLAG_OFF = new Set(["0", "false", "off", "no", "disabled"]);
const ENV_FLAG_ON = new Set(["1", "true", "on", "yes", "enabled"]);

// Storage copy of the env-flag primitive. Storage cannot import core; keep
// token sets in lockstep with packages/core/src/runtime/config/env-value.ts.
// Delete when a protocol env-value helper exists.
/** True when the raw env value is an explicit disable token. */
export function isEnvFlagDisabled(raw: string | undefined, key = "env flag"): boolean {
  if (raw === undefined) {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0) {
    return false;
  }
  if (ENV_FLAG_OFF.has(normalized)) {
    return true;
  }
  if (ENV_FLAG_ON.has(normalized)) {
    return false;
  }
  throw new Error(`${key} must be on, off, true, false, 1, or 0`);
}
