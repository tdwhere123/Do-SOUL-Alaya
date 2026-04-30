import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildInstallAuditPath,
  resolveAlayaConfigDir,
  resolveAlayaConfigPaths,
  type AlayaConfigPaths
} from "./config-files.js";
import {
  ALAYA_SYSEXITS,
  type AlayaCliArgsSchema,
  type AlayaCliContext,
  type AlayaCliResult,
  type AlayaSubcommandSpec
} from "./bridge.js";

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
}

export interface InstallCommandDependencies {
  readonly clock?: () => string;
  readonly configDirResolver?: (ctx: AlayaCliContext) => string;
}

interface InstallArgs {
  readonly nonInteractive: boolean;
  readonly answers: InstallAnswers | null;
}

export function createInstallCommand(deps: InstallCommandDependencies = {}): AlayaSubcommandSpec<InstallArgs> {
  return {
    name: "install",
    description: "Create or patch local Alaya config, secret refs, and install audit rows.",
    argsSchema: installArgsSchema(),
    requiresDaemonReady: false,
    handler: async (ctx, args) => await executeInstall(ctx, args, deps)
  };
}

async function executeInstall(
  ctx: AlayaCliContext,
  args: InstallArgs,
  deps: InstallCommandDependencies
): Promise<AlayaCliResult> {
  if (!args.nonInteractive || args.answers === null) {
    ctx.stderr.write("interactive install is not implemented in this build; use --non-interactive <json>\n");
    return { exitCode: ALAYA_SYSEXITS.USAGE };
  }

  const clock = deps.clock ?? (() => new Date().toISOString());
  const configDir = deps.configDirResolver?.(ctx) ?? resolveAlayaConfigDir({ env: ctx.env });
  const paths = resolveAlayaConfigPaths(configDir);
  const startedAt = clock();
  const auditPath = buildInstallAuditPath(paths, startedAt);
  const partialState: string[] = [];

  try {
    await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
    await mkdir(paths.auditDir, { recursive: true, mode: 0o700 });
    await writeInstallAudit(auditPath, {
      status: "started",
      started_at: startedAt,
      finished_at: null,
      config_dir: paths.configDir,
      partial_state: [],
      error: null
    });

    const existing = await readExistingInstallConfig(paths);
    const resolved = resolveInstallAnswers(args.answers, existing, paths);

    if (resolved.pasted_secret !== null) {
      await mkdir(paths.secretsDir, { recursive: true, mode: 0o700 });
      await writeTextAtomic(resolved.pasted_secret.path, `${resolved.pasted_secret.value.trimEnd()}\n`, 0o600);
      partialState.push(resolved.pasted_secret.path);
    }

    const nextToml = renderAlayaToml(resolved);
    const nextEnv = renderEnvFile(resolved);
    if (normalizeFile(await readOptional(paths.tomlPath)) !== normalizeFile(nextToml)) {
      await writeTextAtomic(paths.tomlPath, nextToml, 0o600);
      partialState.push(paths.tomlPath);
    }
    if (normalizeFile(await readOptional(paths.envPath)) !== normalizeFile(nextEnv)) {
      await writeTextAtomic(paths.envPath, nextEnv, 0o600);
      partialState.push(paths.envPath);
    }

    await writeInstallAudit(auditPath, {
      status: "succeeded",
      started_at: startedAt,
      finished_at: clock(),
      config_dir: paths.configDir,
      partial_state: partialState,
      error: null
    });
    if (ctx.jsonRequested !== true) {
      ctx.stdout.write(`installed Alaya config at ${paths.configDir}\n`);
    }
    return {
      exitCode: ALAYA_SYSEXITS.OK,
      json: {
        ok: true,
        config_dir: paths.configDir,
        toml_path: paths.tomlPath,
        env_path: paths.envPath,
        audit_path: auditPath
      }
    };
  } catch (error) {
    await writeInstallAudit(auditPath, {
      status: "failed",
      started_at: startedAt,
      finished_at: clock(),
      config_dir: paths.configDir,
      partial_state: partialState,
      error: sanitizeInstallError(error)
    }).catch(() => undefined);
    ctx.stderr.write(`${sanitizeInstallError(error)}\n`);
    return { exitCode: ALAYA_SYSEXITS.CANTCREAT };
  }
}

function installArgsSchema(): AlayaCliArgsSchema<InstallArgs> {
  return {
    safeParse(input) {
      if (!Array.isArray(input) || input.some((token) => typeof token !== "string")) {
        return {
          success: false,
          error: { issues: [{ path: [], message: "Expected a string argument list." }] }
        };
      }

      if (input.length === 0) {
        return { success: true, data: { nonInteractive: false, answers: null } };
      }

      const tokens = [...input];
      const nonInteractiveIndex = tokens.indexOf("--non-interactive");
      if (nonInteractiveIndex < 0) {
        return {
          success: false,
          error: { issues: [{ path: [], message: "Usage: install --non-interactive [--json] <answers-json>" }] }
        };
      }
      tokens.splice(nonInteractiveIndex, 1);
      const jsonIndex = tokens.indexOf("--json");
      if (jsonIndex >= 0) {
        tokens.splice(jsonIndex, 1);
      }
      if (tokens.length !== 1) {
        return {
          success: false,
          error: { issues: [{ path: [], message: "install --non-interactive requires one JSON answer object." }] }
        };
      }

      try {
        const parsed = JSON.parse(tokens[0]!) as unknown;
        if (!isRecord(parsed)) {
          throw new Error("answers must be an object");
        }
        return { success: true, data: { nonInteractive: true, answers: parsed as InstallAnswers } };
      } catch (error) {
        return {
          success: false,
          error: { issues: [{ path: [], message: sanitizeInstallError(error) }] }
        };
      }
    }
  };
}

interface ExistingInstallConfig {
  readonly db_path: string | null;
  readonly embedding_enabled: boolean | null;
  readonly provider_base_url: string | null;
  readonly model_id: string | null;
  readonly default_workspace: string | null;
  readonly worktree_enabled: boolean | null;
  readonly secret_ref: string | null;
}

interface ResolvedInstallConfig {
  readonly db_path: string;
  readonly embedding_enabled: boolean;
  readonly provider_base_url: string | null;
  readonly model_id: string;
  readonly default_workspace: string;
  readonly worktree_enabled: boolean;
  readonly secret_ref: string | null;
  readonly pasted_secret: Readonly<{ readonly path: string; readonly value: string }> | null;
}

async function readExistingInstallConfig(paths: AlayaConfigPaths): Promise<ExistingInstallConfig> {
  const toml = await readOptional(paths.tomlPath);
  const env = await readOptional(paths.envPath);
  return {
    db_path: toml === null ? null : readTomlString(toml, "storage", "db_path"),
    embedding_enabled: toml === null ? null : readTomlBoolean(toml, "embedding", "enabled"),
    provider_base_url: toml === null ? null : readTomlString(toml, "embedding", "provider_base_url"),
    model_id: toml === null ? null : readTomlString(toml, "embedding", "model_id"),
    default_workspace: toml === null ? null : readTomlString(toml, "runtime", "default_workspace"),
    worktree_enabled: toml === null ? null : readTomlBoolean(toml, "runtime", "worktree_enabled"),
    secret_ref: env === null ? null : readEnvValue(env, "OPENAI_API_KEY")
  };
}

function resolveInstallAnswers(
  answers: InstallAnswers,
  existing: ExistingInstallConfig,
  paths: AlayaConfigPaths
): ResolvedInstallConfig {
  const embeddingEnabled = answers.embedding_enabled ?? existing.embedding_enabled ?? false;
  const keySource = answers.api_key_source ?? (existing.secret_ref === null ? "env" : undefined);
  const pastedSecret =
    embeddingEnabled && keySource === "paste"
      ? {
          path: path.join(paths.secretsDir, "openai"),
          value: requireNonEmpty(answers.pasted_key, "pasted_key")
        }
      : null;
  const secretRef = embeddingEnabled
    ? resolveSecretRef(answers, existing, pastedSecret)
    : existing.secret_ref;

  return {
    db_path: path.resolve(answers.db_path ?? existing.db_path ?? path.join(paths.configDir, "alaya.db")),
    embedding_enabled: embeddingEnabled,
    provider_base_url: normalizeNullableString(answers.provider_base_url, existing.provider_base_url),
    model_id: requireNonEmpty(answers.model_id ?? existing.model_id ?? "text-embedding-3-small", "model_id"),
    default_workspace: requireNonEmpty(
      answers.default_workspace ?? existing.default_workspace ?? "default",
      "default_workspace"
    ),
    worktree_enabled: answers.worktree_enabled ?? existing.worktree_enabled ?? false,
    secret_ref: secretRef,
    pasted_secret: pastedSecret
  };
}

function resolveSecretRef(
  answers: InstallAnswers,
  existing: ExistingInstallConfig,
  pastedSecret: ResolvedInstallConfig["pasted_secret"]
): string | null {
  if (pastedSecret !== null) {
    return `file:${pastedSecret.path}`;
  }
  if (answers.api_key_source === "file") {
    return `file:${path.resolve(requireNonEmpty(answers.key_file_path, "key_file_path"))}`;
  }
  if (answers.api_key_source === "env" || existing.secret_ref === null) {
    return `env:${requireNonEmpty(answers.env_var_name ?? "OPENAI_API_KEY", "env_var_name")}`;
  }
  return existing.secret_ref;
}

function renderAlayaToml(config: ResolvedInstallConfig): string {
  const lines = [
    "[storage]",
    `db_path = ${quoteTomlString(config.db_path)}`,
    "",
    "[runtime]",
    `default_workspace = ${quoteTomlString(config.default_workspace)}`,
    `worktree_enabled = ${config.worktree_enabled ? "true" : "false"}`,
    "",
    "[embedding]",
    `enabled = ${config.embedding_enabled ? "true" : "false"}`,
    `model_id = ${quoteTomlString(config.model_id)}`
  ];
  if (config.provider_base_url !== null) {
    lines.push(`provider_base_url = ${quoteTomlString(config.provider_base_url)}`);
  }
  return `${lines.join("\n")}\n`;
}

function renderEnvFile(config: ResolvedInstallConfig): string {
  const lines = [`ALAYA_ENABLE_EMBEDDING_SUPPLEMENT=${config.embedding_enabled ? "true" : "false"}`];
  if (config.secret_ref !== null) {
    lines.push(`OPENAI_API_KEY=${config.secret_ref}`);
  }
  return `${lines.join("\n")}\n`;
}

async function writeInstallAudit(
  auditPath: string,
  input: Readonly<{
    readonly status: "started" | "succeeded" | "failed";
    readonly started_at: string;
    readonly finished_at: string | null;
    readonly config_dir: string;
    readonly partial_state: readonly string[];
    readonly error: string | null;
  }>
): Promise<void> {
  await writeTextAtomic(auditPath, `${JSON.stringify({ audit_version: 1, ...input })}\n`, 0o600);
}

async function writeTextAtomic(filePath: string, content: string, mode: number): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, content, { mode, encoding: "utf8" });
  await rename(tempPath, filePath);
}

async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function readTomlString(content: string, sectionName: string, key: string): string | null {
  const value = readTomlValue(content, sectionName, key);
  if (value === null || !value.startsWith("\"") || !value.endsWith("\"")) {
    return null;
  }
  return value.slice(1, -1).replaceAll("\\\"", "\"").replaceAll("\\\\", "\\");
}

function readTomlBoolean(content: string, sectionName: string, key: string): boolean | null {
  const value = readTomlValue(content, sectionName, key);
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
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

function readEnvValue(content: string, key: string): string | null {
  for (const rawLine of content.split(/\r?\n/u)) {
    const [rawKey, ...valueParts] = rawLine.split("=");
    if (rawKey === key) {
      const value = valueParts.join("=").trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

function quoteTomlString(value: string): string {
  return JSON.stringify(value);
}

function normalizeFile(value: string | null): string {
  return (value ?? "").replace(/\r\n/gu, "\n").trimEnd();
}

function normalizeNullableString(
  value: string | null | undefined,
  fallback: string | null
): string | null {
  if (value === undefined) return fallback;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed === "keep" ? null : trimmed;
}

function requireNonEmpty(value: string | undefined, label: string): string {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) {
    throw new Error(`${label} is required`);
  }
  return trimmed;
}

function sanitizeInstallError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  return "install failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
