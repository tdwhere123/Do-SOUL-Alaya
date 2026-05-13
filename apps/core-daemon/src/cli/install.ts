import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  RuntimeGardenProviderKindSchema,
  type RuntimeGardenComputeConfig
} from "@do-soul/alaya-protocol";
import { initDatabase } from "@do-soul/alaya-storage";
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
import {
  ensurePrivateDirectory,
  writePrivateTextAtomic
} from "../services/private-file-service.js";
import { executeKeychainInstall } from "./install/keychain-install.js";
import {
  GARDEN_PROVIDER_KIND_ENV,
  detectBlockingPriorAudit,
  normalizeFile,
  readEnvValue,
  readOptional,
  readTomlBoolean,
  readTomlString,
  rollbackPartialState,
  sanitizeInstallError,
  writeInstallAudit,
  type InstallAnswers,
  type InstallArgs,
  type InstallCommandDependencies,
  type PartialStateEntry
} from "./install/support.js";

export type { InstallAnswers, InstallCommandDependencies } from "./install/support.js";

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
  if (args.keychain) {
    return await executeKeychainInstall(ctx, args, deps);
  }

  if (!args.nonInteractive || args.answers === null) {
    ctx.stderr.write("interactive install is not implemented in this build; use --non-interactive <json>\n");
    return { exitCode: ALAYA_SYSEXITS.USAGE };
  }

  const clock = deps.clock ?? (() => new Date().toISOString());
  const configDir = deps.configDirResolver?.(ctx) ?? resolveAlayaConfigDir({ env: ctx.env });
  const paths = resolveAlayaConfigPaths(configDir);
  const startedAt = clock();
  const auditPath = buildInstallAuditPath(paths, startedAt);
  const partialState: PartialStateEntry[] = [];
  let auditInitialized = false;

  try {
    await ensurePrivateDirectory(paths.configDir);
    await ensurePrivateDirectory(paths.auditDir);

    if (!args.force) {
      const blocking = await detectBlockingPriorAudit(paths);
      if (blocking !== null) {
        ctx.stderr.write(
          `previous install audit ${blocking.fileName} reports status="${blocking.status}"; ` +
            `partial_state may be unrecovered. Re-run with --force to override.\n`
        );
        return { exitCode: ALAYA_SYSEXITS.TEMPFAIL };
      }
    }

    await writeInstallAudit(auditPath, {
      status: "started",
      started_at: startedAt,
      finished_at: null,
      config_dir: paths.configDir,
      partial_state: [],
      error: null
    });
    auditInitialized = true;

    const existing = await readExistingInstallConfig(paths);
    const resolved = resolveInstallAnswers(args.answers, existing, paths);

    if (resolved.pasted_secret !== null) {
      await ensurePrivateDirectory(paths.secretsDir);
      const secretBefore = await readOptional(resolved.pasted_secret.path);
      await writePrivateTextAtomic(resolved.pasted_secret.path, `${resolved.pasted_secret.value.trimEnd()}\n`, 0o600);
      partialState.push({ path: resolved.pasted_secret.path, beforeContent: secretBefore ?? undefined });
    }

    const nextToml = renderAlayaToml(resolved);
    const nextEnv = renderEnvFile(resolved);
    const tomlBefore = await readOptional(paths.tomlPath);
    if (normalizeFile(tomlBefore) !== normalizeFile(nextToml)) {
      await writePrivateTextAtomic(paths.tomlPath, nextToml, 0o600);
      partialState.push({ path: paths.tomlPath, beforeContent: tomlBefore ?? undefined });
    }
    const envBefore = await readOptional(paths.envPath);
    if (normalizeFile(envBefore) !== normalizeFile(nextEnv)) {
      await writePrivateTextAtomic(paths.envPath, nextEnv, 0o600);
      partialState.push({ path: paths.envPath, beforeContent: envBefore ?? undefined });
    }

    // p5-system-review-r2 F-r2-003: open the configured SQLite DB and run
    // migrations now, so install reports readiness honestly. If migration
    // fails the catch branch unwinds the toml/env writes.
    await ensureSchemaReady(resolved.db_path);

    await writeInstallAudit(auditPath, {
      status: "succeeded",
      started_at: startedAt,
      finished_at: clock(),
      config_dir: paths.configDir,
      partial_state: partialState.map((entry) => entry.path),
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
    const rollbackErrors = await rollbackPartialState(partialState);
    if (auditInitialized) {
      await writeInstallAudit(auditPath, {
        status: "failed",
        started_at: startedAt,
        finished_at: clock(),
        config_dir: paths.configDir,
        partial_state: partialState.map((entry) => entry.path),
        error: sanitizeInstallError(error),
        rollback_errors: rollbackErrors.length > 0 ? rollbackErrors : undefined
      }).catch(() => undefined);
    }
    ctx.stderr.write(`${sanitizeInstallError(error)}\n`);
    return { exitCode: ALAYA_SYSEXITS.CANTCREAT };
  }
}

/**
 * Open the configured SQLite database and apply schema migrations.
 * Wrapper exists so install can report a real "schema ready" outcome
 * (p5-system-review-r2 F-r2-003) without leaking better-sqlite3 details
 * to install.ts.
 *
 * Importantly we do NOT close the database here: `initDatabase` is
 * cached per filename, and a long-running daemon process may already
 * hold the same StorageDatabase instance (e.g. the e2e harness boots a
 * runtime before invoking install). Closing the cached instance would
 * invalidate that runtime's prepared statements and surface as
 * "Failed to compute next event log revision" on the next mutation.
 * The cache itself owns the connection lifecycle.
 */
async function ensureSchemaReady(dbPath: string): Promise<void> {
  const dir = path.dirname(dbPath);
  if (dir.length > 0 && dbPath !== ":memory:") {
    await mkdir(dir, { recursive: true });
  }
  initDatabase({ filename: dbPath });
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
        return { success: true, data: { nonInteractive: false, answers: null, force: false, keychain: false } };
      }

      const tokens = [...input];
      const keychainIndex = tokens.indexOf("--keychain");
      const keychain = keychainIndex >= 0;
      if (keychain) {
        tokens.splice(keychainIndex, 1);
      }
      const forceIndex = tokens.indexOf("--force");
      const force = forceIndex >= 0;
      if (force) {
        tokens.splice(forceIndex, 1);
      }
      const nonInteractiveIndex = tokens.indexOf("--non-interactive");
      if (nonInteractiveIndex < 0) {
        if (keychain && tokens.length === 0) {
          return { success: true, data: { nonInteractive: false, answers: null, force, keychain: true } };
        }
        return {
          success: false,
          error: { issues: [{ path: [], message: "Usage: install [--keychain] | install --non-interactive [--json] [--force] <answers-json>" }] }
        };
      }
      tokens.splice(nonInteractiveIndex, 1);
      const jsonIndex = tokens.indexOf("--json");
      if (jsonIndex >= 0) {
        tokens.splice(jsonIndex, 1);
      }
      if (keychain) {
        if (tokens.length === 0) {
          return { success: true, data: { nonInteractive: true, answers: null, force, keychain: true } };
        }
        return {
          success: false,
          error: {
            issues: [
              {
                path: [],
                message: "install --keychain --non-interactive does not accept an answer JSON or secret argument."
              }
            ]
          }
        };
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
        return { success: true, data: { nonInteractive: true, answers: parsed as InstallAnswers, force, keychain } };
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
  readonly garden_provider_kind: string | null;
}

interface ResolvedInstallConfig {
  readonly db_path: string;
  readonly embedding_enabled: boolean;
  readonly provider_base_url: string | null;
  readonly model_id: string;
  readonly default_workspace: string;
  readonly worktree_enabled: boolean;
  readonly secret_ref: string | null;
  readonly garden_provider_kind: RuntimeGardenComputeConfig["provider_kind"] | null;
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
    secret_ref: env === null ? null : readEnvValue(env, "ALAYA_OPENAI_SECRET_REF"),
    garden_provider_kind: env === null ? null : readEnvValue(env, GARDEN_PROVIDER_KIND_ENV)
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
    ? resolveInstallSecretRef(answers, existing, pastedSecret)
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
    garden_provider_kind: resolveGardenProviderKind(answers.garden_provider_kind, existing.garden_provider_kind),
    pasted_secret: pastedSecret
  };
}

function resolveGardenProviderKind(
  answer: unknown,
  existing: string | null
): RuntimeGardenComputeConfig["provider_kind"] | null {
  if (answer !== undefined) {
    const parsed = RuntimeGardenProviderKindSchema.safeParse(answer);
    if (!parsed.success) {
      throw new Error('garden_provider_kind must be one of "official_api", "local_heuristics", or "host_worker"');
    }
    return parsed.data;
  }
  const carried = RuntimeGardenProviderKindSchema.safeParse(existing);
  return carried.success ? carried.data : null;
}

function resolveInstallSecretRef(
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
    lines.push(`ALAYA_OPENAI_SECRET_REF=${config.secret_ref}`);
  }
  lines.push(`OPENAI_EMBEDDING_MODEL=${config.model_id}`);
  if (config.provider_base_url !== null) {
    lines.push(`OPENAI_EMBEDDING_PROVIDER_URL=${config.provider_base_url}`);
  }
  if (config.garden_provider_kind !== null) {
    lines.push(`${GARDEN_PROVIDER_KIND_ENV}=${config.garden_provider_kind}`);
  }
  return `${lines.join("\n")}\n`;
}

function quoteTomlString(value: string): string {
  return JSON.stringify(value);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
