import { parseCoreConfigFromEnv, type CoreConfig } from "./core-config.js";

let installedCoreConfig: CoreConfig | null = null;
let configFrozen = false;

export function installCoreConfig(config: CoreConfig): void {
  installedCoreConfig = config;
  configFrozen = true;
}

export function getCoreConfig(): CoreConfig {
  if (configFrozen && installedCoreConfig !== null) {
    return installedCoreConfig;
  }
  return parseCoreConfigFromEnv(process.env);
}

export function resetCoreConfigForTests(): void {
  installedCoreConfig = null;
  configFrozen = false;
}

export function installCoreConfigFromProcessEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  configEnv?: ReadonlyMap<string, string>
): CoreConfig {
  const merged: Record<string, string | undefined> = { ...env };
  if (configEnv !== undefined) {
    for (const [key, value] of configEnv.entries()) {
      if (merged[key] === undefined) {
        merged[key] = value;
      }
    }
  }
  const config = parseCoreConfigFromEnv(merged);
  installCoreConfig(config);
  return config;
}
