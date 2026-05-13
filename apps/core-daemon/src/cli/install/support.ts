import { access, readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import type { RuntimeGardenComputeConfig } from "@do-soul/alaya-protocol";
import type { AlayaCliContext } from "../bridge.js";
import type { AlayaConfigPaths } from "../config-files.js";
import { writePrivateTextAtomic } from "../../services/private-file-service.js";
import type {
  KeychainAvailabilityResult,
  KeychainReadResult,
  KeychainWriteResult
} from "../../secrets/keychain/index.js";

export interface InstallAnswers {
  readonly db_path?: string;
  readonly embedding_enabled?: boolean;
  readonly provider_base_url?: string | null;
  readonly model_id?: string;
  readonly api_key_source?: "env" | "file" | "paste";
  readonly env_var_name?: string;
  readonly key_file_path?: string;
  readonly pasted_key?: string;
  readonly default_workspace?: string;
  readonly worktree_enabled?: boolean;
  readonly garden_provider_kind?: RuntimeGardenComputeConfig["provider_kind"];
}

export interface InstallCommandDependencies {
  readonly clock?: () => string;
  readonly configDirResolver?: (ctx: AlayaCliContext) => string;
  readonly keychain?: {
    readonly checkAvailable?: (service: string, account: string) => KeychainAvailabilityResult;
    readonly writeKeychain?: (service: string, account: string, value: string) => KeychainWriteResult;
    readonly readKeychain?: (service: string, account: string) => KeychainReadResult;
  };
  readonly platform?: NodeJS.Platform;
}

export interface InstallArgs {
  readonly nonInteractive: boolean;
  readonly answers: InstallAnswers | null;
  readonly force: boolean;
  readonly keychain: boolean;
}

export interface PartialStateEntry {
  readonly path: string;
  // beforeContent === undefined means the file did not exist before; rollback unlinks.
  readonly beforeContent: string | undefined;
}

export type GardenConfigAuditSnapshot = Pick<RuntimeGardenComputeConfig, "provider_kind" | "enabled" | "secret_ref">;

export interface InstallAuditConfigChange {
  readonly key: string;
  readonly before: GardenConfigAuditSnapshot;
  readonly after: GardenConfigAuditSnapshot;
}

export interface InstallAuditKeychainOrphan {
  readonly secret_ref: string;
  readonly service: string;
  readonly account: string;
  readonly remediation: string;
}

export const KEYCHAIN_INSTALL_SERVICE = "alaya";
export const KEYCHAIN_INSTALL_ACCOUNT = "openai";
export const GARDEN_KEYCHAIN_SECRET_REF_ENV = "ALAYA_OFFICIAL_GARDEN_SECRET_REF";
export const GARDEN_PROVIDER_KIND_ENV = "ALAYA_GARDEN_PROVIDER_KIND";
export const RUNTIME_GARDEN_COMPUTE_CONFIG_KEY = "runtime:garden-compute";

export async function rollbackPartialState(partialState: readonly PartialStateEntry[]): Promise<string[]> {
  const errors: string[] = [];
  for (let i = partialState.length - 1; i >= 0; i -= 1) {
    const entry = partialState[i]!;
    try {
      if (entry.beforeContent === undefined) {
        await unlink(entry.path).catch((err) => {
          if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
            return;
          }
          throw err;
        });
      } else {
        await writePrivateTextAtomic(entry.path, entry.beforeContent, 0o600);
      }
    } catch (rollbackError) {
      errors.push(`${entry.path}: ${sanitizeInstallError(rollbackError)}`);
    }
  }
  return errors;
}

export async function detectBlockingPriorAudit(
  paths: AlayaConfigPaths
): Promise<{ readonly fileName: string; readonly status: string } | null> {
  let entries: string[];
  try {
    entries = await readdir(paths.auditDir);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const installFiles = entries.filter((name) => name.startsWith("install-") && name.endsWith(".json")).sort();
  if (installFiles.length === 0) {
    return null;
  }
  const latest = installFiles[installFiles.length - 1]!;
  const content = await readFile(path.join(paths.auditDir, latest), "utf8").catch(() => null);
  if (content === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(content) as { readonly status?: unknown };
    if (parsed.status === "started" || parsed.status === "failed") {
      return { fileName: latest, status: parsed.status };
    }
  } catch {
    return null;
  }
  return null;
}

export async function writeInstallAudit(
  auditPath: string,
  input: Readonly<{
    readonly status: "started" | "succeeded" | "failed";
    readonly started_at: string;
    readonly finished_at: string | null;
    readonly config_dir: string;
    readonly partial_state: readonly string[];
    readonly error: string | null;
    readonly rollback_errors?: readonly string[];
    readonly config_changes?: readonly InstallAuditConfigChange[];
    readonly keychain_orphan?: InstallAuditKeychainOrphan;
  }>
): Promise<void> {
  await writePrivateTextAtomic(auditPath, `${JSON.stringify({ audit_version: 1, ...input })}\n`, 0o600);
}

export async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function readTomlString(content: string, sectionName: string, key: string): string | null {
  const value = readTomlValue(content, sectionName, key);
  if (value === null || !value.startsWith("\"") || !value.endsWith("\"")) {
    return null;
  }
  return value.slice(1, -1).replaceAll("\\\"", "\"").replaceAll("\\\\", "\\");
}

export function readTomlBoolean(content: string, sectionName: string, key: string): boolean | null {
  const value = readTomlValue(content, sectionName, key);
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

export function readEnvValue(content: string, key: string): string | null {
  for (const rawLine of content.split(/\r?\n/u)) {
    const [rawKey, ...valueParts] = rawLine.split("=");
    if (rawKey === key) {
      const value = valueParts.join("=").trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

export function normalizeFile(value: string | null): string {
  return (value ?? "").replace(/\r\n/gu, "\n").trimEnd();
}

export function sanitizeInstallError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  return "install failed";
}

function readTomlValue(content: string, sectionName: string, key: string): string | null {
  let section: string | null = null;
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const sectionMatch = /^\[([^\]]+)\]$/u.exec(line);
    if (sectionMatch !== null) {
      section = sectionMatch[1] ?? null;
      continue;
    }
    if (section !== sectionName) continue;
    const kvMatch = new RegExp(`^${key}\\s*=\\s*(.+)$`, "u").exec(line);
    if (kvMatch !== null) {
      return kvMatch[1]?.trim() ?? null;
    }
  }
  return null;
}
