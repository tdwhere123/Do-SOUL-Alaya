const ENV_DISABLED_TOKENS = new Set(["0", "false", "off", "no", "disabled"]);

/** True when the raw env value is an explicit disable token. */
export function isEnvFlagDisabled(raw: string | undefined): boolean {
  if (raw === undefined) {
    return false;
  }
  return ENV_DISABLED_TOKENS.has(raw.trim().toLowerCase());
}
