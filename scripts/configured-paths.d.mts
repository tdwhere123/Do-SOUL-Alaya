export function resolveAlayaConfigDir(environment: NodeJS.ProcessEnv, platform?: NodeJS.Platform, homeDir?: string): string;
export function resolveConfiguredDatabasePath(tomlPath: string, environment: NodeJS.ProcessEnv, fallbackPath: string, launchCwd?: string): string;
export function parseStorageDbPathFromToml(tomlContent: string): string | null;
