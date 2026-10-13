import path from "node:path";
import { resolveAlayaConfigDir as resolveConfigDir } from "../../../../../scripts/configured-paths.mjs";
import { processEnvLookup } from "../../runtime/config/daemon-config-environment.js";

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

export function resolveAlayaConfigDir(options: ResolveConfigDirOptions = {}): string {
  return resolveConfigDir(options.env ?? processEnvLookup(), options.platform, options.homeDir);
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

function sanitizeAuditLabel(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}
