import { homedir } from "node:os";
import path from "node:path";

export interface AlayaConfigPaths {
  readonly configDir: string;
  readonly tomlPath: string;
  readonly envPath: string;
  readonly auditDir: string;
  readonly secretsDir: string;
  readonly operationsDir: string;
}

export interface ResolveConfigDirOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
}

const APP_NAME = "alaya";

export function resolveAlayaConfigDir(options: ResolveConfigDirOptions = {}): string {
  const env = options.env ?? process.env;
  const overrideDir = env.ALAYA_CONFIG_DIR?.trim();
  if (overrideDir && overrideDir.length > 0) {
    return path.resolve(overrideDir);
  }

  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const appData = env.APPDATA?.trim();
    if (appData && appData.length > 0) {
      return path.resolve(appData, APP_NAME);
    }
    return path.resolve(resolveHomeDirectory(env, options.homeDir), "AppData", "Roaming", APP_NAME);
  }

  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
  if (xdgConfigHome && xdgConfigHome.length > 0) {
    return path.resolve(xdgConfigHome, APP_NAME);
  }

  return path.resolve(resolveHomeDirectory(env, options.homeDir), ".config", APP_NAME);
}

export function resolveAlayaConfigPaths(configDir: string): AlayaConfigPaths {
  const normalizedConfigDir = path.resolve(configDir);
  return Object.freeze({
    configDir: normalizedConfigDir,
    tomlPath: path.join(normalizedConfigDir, "alaya.toml"),
    envPath: path.join(normalizedConfigDir, ".env"),
    auditDir: path.join(normalizedConfigDir, "audit"),
    secretsDir: path.join(normalizedConfigDir, "secrets"),
    operationsDir: path.join(normalizedConfigDir, "operations")
  });
}

export function toAuditTimestampLabel(isoTimestamp: string): string {
  return isoTimestamp.replace(/:/g, "-");
}

export function buildInstallAuditPath(paths: AlayaConfigPaths, isoTimestamp: string): string {
  return path.join(paths.auditDir, `install-${toAuditTimestampLabel(isoTimestamp)}.json`);
}

export function buildOperationAuditPath(
  paths: AlayaConfigPaths,
  operation: "backup" | "export" | "import",
  isoTimestamp: string
): string {
  return path.join(paths.auditDir, `${operation}-${toAuditTimestampLabel(isoTimestamp)}.json`);
}

export function buildProfileMutationAuditPath(
  paths: AlayaConfigPaths,
  target: string,
  direction: string,
  isoTimestamp: string
): string {
  return path.join(paths.auditDir, `profile-${sanitizeAuditLabel(target)}-${sanitizeAuditLabel(direction)}-${toAuditTimestampLabel(isoTimestamp)}.json`);
}

function resolveHomeDirectory(env: NodeJS.ProcessEnv, fallbackHomeDir?: string): string {
  const home = env.HOME?.trim() ?? fallbackHomeDir ?? homedir();
  return home.length > 0 ? home : homedir();
}

function sanitizeAuditLabel(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}
