type VersionedConfig = Record<string, unknown> & { readonly config_version?: number };

/** Legacy reads fill only absence; explicit versions (even invalid ones) reach schema validation. */
export function normalizeLegacyConfigVersion(value: unknown, configVersion: number): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || "config_version" in value && value.config_version !== undefined) return value;
  return { ...value, config_version: configVersion };
}

/** Owning schemas supply the fallback stamp; explicit patch versions survive validation. */
export function withConfigVersion<T extends VersionedConfig>(
  patch: Partial<T>,
  configVersion: number
): Partial<T> {
  return { ...patch, config_version: patch.config_version === undefined ? configVersion : patch.config_version };
}
