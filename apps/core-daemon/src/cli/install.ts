import { access, mkdir, readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { EventPublisher } from "@do-soul/alaya-core";
import {
  GardenEventType,
  HealthEventKind,
  RuntimeGardenComputeConfigSchema,
  SoulHealthJournalRecordedPayloadSchema,
  type RuntimeGardenComputeConfig
} from "@do-soul/alaya-protocol";
import { initDatabase, SqliteConfigRepo, SqliteEventLogRepo } from "@do-soul/alaya-storage";
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
import { resolveSecretRef as resolveRuntimeSecretRef, type ResolveSecretError } from "../secrets.js";
import {
  checkPlatformKeychainAvailable,
  readPlatformKeychainSecret,
  writePlatformKeychainSecret,
  type KeychainAvailabilityResult,
  type KeychainReadResult,
  type KeychainWriteResult
} from "../secrets/keychain/index.js";

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
  // Declares the Garden compute mode in the env file; host_worker cannot be
  // reached through secret-presence inference, so it has to be set explicitly
  // here (or via the Inspector / ALAYA_GARDEN_PROVIDER_KIND).
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
}

interface InstallArgs {
  readonly nonInteractive: boolean;
  readonly answers: InstallAnswers | null;
  readonly force: boolean;
  readonly keychain: boolean;
}

interface PartialStateEntry {
  readonly path: string;
  // beforeContent === undefined means the file did not exist before; rollback unlinks.
  readonly beforeContent: string | undefined;
}

type GardenConfigAuditSnapshot = Pick<RuntimeGardenComputeConfig, "provider_kind" | "enabled" | "secret_ref">;

interface InstallAuditConfigChange {
  readonly key: string;
  readonly before: GardenConfigAuditSnapshot;
  readonly after: GardenConfigAuditSnapshot;
}

interface InstallAuditKeychainOrphan {
  readonly secret_ref: string;
  readonly service: string;
  readonly account: string;
  readonly remediation: string;
}

// invariant: install --keychain writes the dedicated Garden credential ref and
// leaves the legacy embedding ALAYA_OPENAI_SECRET_REF line untouched.
const KEYCHAIN_INSTALL_SERVICE = "alaya";
const KEYCHAIN_INSTALL_ACCOUNT = "openai";
const GARDEN_KEYCHAIN_SECRET_REF_ENV = "ALAYA_OFFICIAL_GARDEN_SECRET_REF";
const GARDEN_PROVIDER_KIND_ENV = "ALAYA_GARDEN_PROVIDER_KIND";
const RUNTIME_GARDEN_COMPUTE_CONFIG_KEY = "runtime:garden-compute";
const GardenProviderKindSchema = RuntimeGardenComputeConfigSchema.unwrap().shape.provider_kind;

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

async function executeKeychainInstall(
  ctx: AlayaCliContext,
  args: InstallArgs,
  deps: InstallCommandDependencies
): Promise<AlayaCliResult> {
  if (args.nonInteractive) {
    ctx.stderr.write("install --keychain requires interactive input; --non-interactive is not supported for keychain secrets.\n");
    return { exitCode: ALAYA_SYSEXITS.USAGE };
  }

  const service = KEYCHAIN_INSTALL_SERVICE;
  const account = KEYCHAIN_INSTALL_ACCOUNT;
  const keychainRef = `keychain:${service}:${account}`;
  const clock = deps.clock ?? (() => new Date().toISOString());
  const configDir = deps.configDirResolver?.(ctx) ?? resolveAlayaConfigDir({ env: ctx.env });
  const paths = resolveAlayaConfigPaths(configDir);
  const startedAt = clock();
  const auditPath = buildInstallAuditPath(paths, startedAt);
  const partialState: PartialStateEntry[] = [];
  let auditInitialized = false;
  let persistedGardenConfigBefore: RuntimeGardenComputeConfig | null | undefined;
  let persistedGardenConfigChange: InstallAuditConfigChange | undefined;
  let keychainOrphan: InstallAuditKeychainOrphan | undefined;

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

  const checkAvailable = deps.keychain?.checkAvailable ?? ((svc, acct) => checkPlatformKeychainAvailable(svc, acct));
  const writeKeychain = deps.keychain?.writeKeychain ?? ((svc, acct, value) => writePlatformKeychainSecret(svc, acct, value));
  const readKeychain = deps.keychain?.readKeychain ?? ((svc, acct) => readPlatformKeychainSecret(svc, acct));

  const availability = checkAvailable(service, account);
  if (!("ok" in availability)) {
    ctx.stderr.write(`${formatKeychainInstallError(availability)}\n`);
    return { exitCode: ALAYA_SYSEXITS.TEMPFAIL };
  }

  ctx.stderr.write(`Enter secret for ${keychainRef}: `);
  const secret = await readSecretLine(ctx.stdin, ctx.stderr, ctx.isTTY);
  if (secret.trim().length === 0) {
    ctx.stderr.write("install --keychain requires a non-empty secret value.\n");
    return { exitCode: ALAYA_SYSEXITS.USAGE };
  }

  try {
    await writeInstallAudit(auditPath, {
      status: "started",
      started_at: startedAt,
      finished_at: null,
      config_dir: paths.configDir,
      partial_state: [],
      error: null
    });
    auditInitialized = true;

    const writeResult = writeKeychain(service, account, secret);
    if (!("ok" in writeResult)) {
      throw new Error(formatKeychainInstallError(writeResult));
    }
    keychainOrphan = buildKeychainOrphanAudit(keychainRef, service, account);

    const verified = resolveRuntimeSecretRef(keychainRef, {
      readEnv: (name) => ctx.env[name],
      readFile: () => {
        throw new Error("unexpected file secret read during keychain verification");
      },
      readKeychain
    });
    if ("kind" in verified) {
      throw new Error(`keychain write verification failed: ${formatSecretRefVerificationError(verified)}`);
    }

    const envBefore = await readOptional(paths.envPath);
    const nextEnv = patchEnvWithGardenKeychainRef(envBefore, keychainRef);
    if (normalizeFile(envBefore) !== normalizeFile(nextEnv)) {
      await writePrivateTextAtomic(paths.envPath, nextEnv, 0o600);
      partialState.push({ path: paths.envPath, beforeContent: envBefore ?? undefined });
    }

    const existing = await readExistingInstallConfig(paths);
    const dbPath = path.resolve(existing.db_path ?? path.join(paths.configDir, "alaya.db"));
    const persistedPatch = await patchPersistedGardenSecretRefIfPresent(dbPath, keychainRef, startedAt);
    persistedGardenConfigBefore = persistedPatch?.before;
    persistedGardenConfigChange =
      persistedPatch === null
        ? undefined
        : {
            key: RUNTIME_GARDEN_COMPUTE_CONFIG_KEY,
            before: summarizeGardenConfigForInstallAudit(persistedPatch.before),
            after: summarizeGardenConfigForInstallAudit(persistedPatch.after)
          };

    await writeInstallAudit(auditPath, {
      status: "succeeded",
      started_at: startedAt,
      finished_at: clock(),
      config_dir: paths.configDir,
      partial_state: partialState.map((entry) => entry.path),
      error: null,
      config_changes: persistedGardenConfigChange === undefined ? undefined : [persistedGardenConfigChange]
    });

    if (ctx.jsonRequested !== true) {
      ctx.stdout.write(`installed Alaya keychain ref ${keychainRef} at ${paths.envPath}\n`);
    }
    return {
      exitCode: ALAYA_SYSEXITS.OK,
      json: {
        ok: true,
        config_dir: paths.configDir,
        env_path: paths.envPath,
        audit_path: auditPath,
        secret_ref: keychainRef
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
        rollback_errors: rollbackErrors.length > 0 ? rollbackErrors : undefined,
        keychain_orphan: keychainOrphan
      }).catch(() => undefined);
    }
    if (persistedGardenConfigBefore !== undefined) {
      await restorePersistedGardenConfig(paths, persistedGardenConfigBefore).catch(() => undefined);
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

async function rollbackPartialState(partialState: readonly PartialStateEntry[]): Promise<string[]> {
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

async function detectBlockingPriorAudit(
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
    const parsed = GardenProviderKindSchema.safeParse(answer);
    if (!parsed.success) {
      throw new Error('garden_provider_kind must be one of "official_api", "local_heuristics", or "host_worker"');
    }
    return parsed.data;
  }
  const carried = GardenProviderKindSchema.safeParse(existing);
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

function summarizeGardenConfigForInstallAudit(config: RuntimeGardenComputeConfig): GardenConfigAuditSnapshot {
  return {
    provider_kind: config.provider_kind,
    enabled: config.enabled,
    secret_ref: config.secret_ref
  };
}

function buildKeychainOrphanAudit(
  secretRef: string,
  service: string,
  account: string
): InstallAuditKeychainOrphan {
  return {
    secret_ref: secretRef,
    service,
    account,
    remediation:
      `Remove the stale keychain entry for service ${service} account ${account} ` +
      "with the platform keychain tool before retrying if desired."
  };
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
    readonly rollback_errors?: readonly string[];
    readonly config_changes?: readonly InstallAuditConfigChange[];
    readonly keychain_orphan?: InstallAuditKeychainOrphan;
  }>
): Promise<void> {
  await writePrivateTextAtomic(auditPath, `${JSON.stringify({ audit_version: 1, ...input })}\n`, 0o600);
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

async function readSecretLine(
  stdin: NodeJS.ReadableStream,
  stderr: NodeJS.WritableStream,
  isTTY: boolean
): Promise<string> {
  if (isTTY) {
    return await readMaskedTtySecretLine(stdin, stderr);
  }
  const readline = createInterface({ input: stdin, terminal: false });
  try {
    return await readline.question("");
  } finally {
    readline.close();
  }
}

async function readMaskedTtySecretLine(
  stdin: NodeJS.ReadableStream,
  stderr: NodeJS.WritableStream
): Promise<string> {
  type RawModeReadable = NodeJS.ReadableStream & {
    readonly isRaw?: boolean;
    setRawMode?: (mode: boolean) => RawModeReadable;
    setEncoding?: (encoding: BufferEncoding) => RawModeReadable;
    resume?: () => RawModeReadable;
    pause?: () => RawModeReadable;
  };
  const input = stdin as RawModeReadable;
  const hadRawMode = Boolean(input.isRaw);
  const canSetRawMode = typeof input.setRawMode === "function";
  if (canSetRawMode && !hadRawMode) {
    input.setRawMode?.(true);
  }
  input.setEncoding?.("utf8");
  input.resume?.();

  return await new Promise((resolve, reject) => {
    let secret = "";
    let settled = false;

    const cleanup = (): void => {
      input.off("data", onData);
      input.off("error", onError);
      if (canSetRawMode && !hadRawMode) {
        input.setRawMode?.(false);
      }
      input.pause?.();
      stderr.write("\n");
    };

    const finish = (value: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const onError = (error: Error): void => fail(error);
    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const char of text) {
        if (char === "\r" || char === "\n") {
          finish(secret);
          return;
        }
        if (char === "\u0003") {
          fail(new Error("install --keychain canceled"));
          return;
        }
        if (char === "\u007f" || char === "\b") {
          secret = secret.slice(0, -1);
          continue;
        }
        secret += char;
      }
    };

    input.on("data", onData);
    input.on("error", onError);
  });
}

async function patchPersistedGardenSecretRefIfPresent(
  dbPath: string,
  secretRef: string,
  occurredAt: string
): Promise<{ readonly before: RuntimeGardenComputeConfig; readonly after: RuntimeGardenComputeConfig } | null> {
  if (!(await fileExists(dbPath))) {
    return null;
  }
  const database = initDatabase({ filename: dbPath });
  const configRepo = new SqliteConfigRepo(database);
  const before = configRepo.get<RuntimeGardenComputeConfig>(RUNTIME_GARDEN_COMPUTE_CONFIG_KEY);
  if (before === null) {
    return null;
  }
  const parsedBefore = RuntimeGardenComputeConfigSchema.parse(before);
  const after = RuntimeGardenComputeConfigSchema.parse({
    ...parsedBefore,
    secret_ref: secretRef
  });
  const eventPublisher = new EventPublisher({
    eventLogRepo: new SqliteEventLogRepo(database),
    runHotStateService: { apply: () => undefined },
    runtimeNotifier: {
      notify: () => undefined,
      notifyEntry: () => undefined
    }
  });
  await eventPublisher.appendManyWithMutation(
    [
      {
        event_type: GardenEventType.SOUL_HEALTH_JOURNAL_RECORDED,
        entity_type: "runtime_config",
        entity_id: RUNTIME_GARDEN_COMPUTE_CONFIG_KEY,
        workspace_id: "runtime",
        run_id: null,
        caused_by: "install",
        payload_json: SoulHealthJournalRecordedPayloadSchema.parse({
          entry_id: `install-keychain:${occurredAt}`,
          event_kind: HealthEventKind.EMBEDDING_SUPPLEMENT,
          workspace_id: "runtime",
          occurred_at: occurredAt,
          change_summary: {
            fields_changed: ["secret_ref"],
            secret_ref_kind: "keychain"
          }
        })
      }
    ],
    () => {
      configRepo.set(RUNTIME_GARDEN_COMPUTE_CONFIG_KEY, after);
      return after;
    }
  );
  return { before: parsedBefore, after };
}

async function restorePersistedGardenConfig(
  paths: AlayaConfigPaths,
  config: RuntimeGardenComputeConfig | null
): Promise<void> {
  const existing = await readExistingInstallConfig(paths);
  const dbPath = path.resolve(existing.db_path ?? path.join(paths.configDir, "alaya.db"));
  if (!(await fileExists(dbPath)) || config === null) {
    return;
  }
  new SqliteConfigRepo(initDatabase({ filename: dbPath })).set(RUNTIME_GARDEN_COMPUTE_CONFIG_KEY, config);
}

async function fileExists(filePath: string): Promise<boolean> {
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

function patchEnvWithGardenKeychainRef(envBefore: string | null, keychainRef: string): string {
  const assignment = `${GARDEN_KEYCHAIN_SECRET_REF_ENV}=${keychainRef}`;
  if (normalizeFile(envBefore).length === 0) {
    return `${assignment}\n`;
  }

  const normalized = (envBefore ?? "").replace(/\r\n/gu, "\n");
  const lines = normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
  let replaced = false;
  const nextLines = lines.map((line) => {
    const separatorIndex = line.indexOf("=");
    const key = separatorIndex >= 0 ? line.slice(0, separatorIndex) : line;
    if (key === GARDEN_KEYCHAIN_SECRET_REF_ENV) {
      replaced = true;
      return assignment;
    }
    return line;
  });

  if (!replaced) {
    nextLines.push(assignment);
  }
  return `${nextLines.join("\n")}\n`;
}

type KeychainInstallFailure =
  | Exclude<KeychainAvailabilityResult, { readonly ok: true }>
  | Exclude<KeychainWriteResult, { readonly ok: true }>;

function formatKeychainInstallError(error: KeychainInstallFailure): string {
  switch (error.kind) {
    case "keychain_tooling_unavailable":
      return `keychain tooling unavailable for keychain:${error.service}:${error.account}: ${error.reason}`;
    case "keychain_write_failed":
      return `keychain write failed for keychain:${error.service}:${error.account}: ${error.reason}`;
  }
}

function formatSecretRefVerificationError(error: ResolveSecretError): string {
  switch (error.kind) {
    case "malformed":
      return error.reason;
    case "env_missing":
      return `environment variable ${error.var_name} is missing`;
    case "file_missing":
      return `secret file is missing: ${error.path}`;
    case "file_unreadable":
      return `secret file is unreadable: ${error.cause}`;
    case "keychain_tooling_unavailable":
      return `keychain tooling unavailable for keychain:${error.service}:${error.account}: ${error.reason}`;
    case "keychain_entry_not_found":
      return `keychain entry not found for keychain:${error.service}:${error.account}: ${error.reason}`;
    case "empty":
      return `${error.origin} secret is empty`;
  }
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
