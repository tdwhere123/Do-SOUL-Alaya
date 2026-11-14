import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { CoreError, DEFAULT_LOCAL_ONNX_MODEL_ID } from "@do-soul/alaya-core";
import { resolveContainedFileSecretPath } from "../../secrets/file-secret-path.js";
import { mergeOwnedEnvEntries } from "../../services/env-file/env-file-format.js";
import { withRuntimeEmbeddingFileLock } from "../../services/env-file/env-file-io.js";
import {
  RuntimeGardenProviderKindSchema,
  formatFileSecretRef,
  type EmbeddingProviderKind,
  type RuntimeGardenComputeConfig
} from "@do-soul/alaya-protocol";
import { initDatabase } from "@do-soul/alaya-storage";
import {
  buildInstallAuditPath,
  resolveAlayaConfigDir,
  resolveAlayaConfigPaths,
  type AlayaConfigPaths
} from "../support/config-files.js";
import {
  ALAYA_SYSEXITS,
  type AlayaCliContext,
  type AlayaCliResult,
  type AlayaSubcommandSpec
} from "../bridge.js";
import {
  ensurePrivateDirectory,
  writePrivateTextAtomic
} from "../../services/support/private-file-service.js";
import { assertPasteSecretSupported } from "../../services/support/paste-secret-platform.js";
import { executeKeychainInstall } from "./keychain-install.js";
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
} from "./support.js";
import { installArgsSchema } from "./args.js";
import { INSTALL_ENV_KEYS, renderAlayaToml, buildInstallEnvEntries, type ResolvedInstallConfig } from "./render-install-config.js";

export type { InstallAnswers, InstallCommandDependencies } from "./support.js";

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
    return reportStructuredInstallUsage(ctx);
  }

  return await runNonInteractiveInstall(ctx, args, deps);
}

/**
 * Open the configured SQLite database and apply schema migrations.
 * Wrapper exists so install can report a real "schema ready" outcome
 * without leaking better-sqlite3 details to install.ts.
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

interface ExistingInstallConfig {
  readonly db_path: string | null;
  readonly embedding_enabled: boolean | null;
  readonly embedding_provider: EmbeddingProviderKind | null;
  readonly provider_base_url: string | null;
  readonly model_id: string | null;
  readonly default_workspace: string | null;
  readonly worktree_enabled: boolean | null;
  readonly secret_ref: string | null;
  readonly garden_provider_kind: string | null;
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
    embedding_provider: env === null ? null : readEmbeddingProviderEnv(env),
    garden_provider_kind: env === null ? null : readEnvValue(env, GARDEN_PROVIDER_KIND_ENV)
  };
}

function readEmbeddingProviderEnv(env: string): EmbeddingProviderKind | null {
  const raw = readEnvValue(env, "ALAYA_EMBEDDING_PROVIDER");
  if (raw === null) return null;
  const normalized = raw.toLowerCase();
  if (normalized === "local_onnx" || normalized === "openai") return normalized;
  throw new Error("ALAYA_EMBEDDING_PROVIDER must be openai or local_onnx when set.");
}

function resolveInstallAnswers(
  answers: InstallAnswers,
  existing: ExistingInstallConfig,
  paths: AlayaConfigPaths
): ResolvedInstallConfig {
  const embeddingProvider: EmbeddingProviderKind =
    answers.embedding_provider ??
    (answers.api_key_source !== undefined ? "openai" : existing.embedding_provider ?? "local_onnx");
  const usesOpenAi = embeddingProvider === "openai";
  const providerUnchanged = existing.embedding_provider === embeddingProvider;
  const embeddingEnabled =
    answers.embedding_enabled ?? existing.embedding_enabled ?? embeddingProvider === "local_onnx";
  const keySource = answers.api_key_source ?? (existing.secret_ref === null ? "env" : undefined);
  const pastedSecret =
    embeddingEnabled && usesOpenAi && keySource === "paste"
      ? {
          path: path.join(paths.secretsDir, "openai"),
          value: requireNonEmpty(answers.pasted_key, "pasted_key")
        }
      : null;
  const secretRef = usesOpenAi
    ? embeddingEnabled
      ? resolveInstallSecretRef(answers, existing, pastedSecret, paths.secretsDir)
      : existing.secret_ref
    : null;
  const defaultModelId = usesOpenAi ? "text-embedding-3-small" : DEFAULT_LOCAL_ONNX_MODEL_ID;
  const carriedModelId = providerUnchanged ? existing.model_id : null;
  const carriedBaseUrl = providerUnchanged ? existing.provider_base_url : null;

  return {
    db_path: path.resolve(answers.db_path ?? existing.db_path ?? path.join(paths.configDir, "alaya.db")),
    embedding_enabled: embeddingEnabled,
    embedding_provider: embeddingProvider,
    provider_base_url: usesOpenAi
      ? normalizeNullableString(answers.provider_base_url, carriedBaseUrl)
      : null,
    model_id: requireNonEmpty(answers.model_id ?? carriedModelId ?? defaultModelId, "model_id"),
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
  pastedSecret: ResolvedInstallConfig["pasted_secret"],
  secretsDir: string
): string | null {
  if (pastedSecret !== null) {
    return formatFileSecretRef(pastedSecret.path);
  }
  if (answers.api_key_source === "file") {
    const containedPath = resolveContainedFileSecretPath(requireNonEmpty(answers.key_file_path, "key_file_path"), secretsDir);
    if (containedPath === null) {
      throw new CoreError("VALIDATION", "key_file_path must resolve inside the configured secrets directory.");
    }
    return formatFileSecretRef(containedPath);
  }
  if (answers.api_key_source === "env" || existing.secret_ref === null) {
    return `env:${requireNonEmpty(answers.env_var_name ?? "OPENAI_API_KEY", "env_var_name")}`;
  }
  return existing.secret_ref;
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

function reportStructuredInstallUsage(ctx: AlayaCliContext): AlayaCliResult {
  // invariant: `alaya install` is configuration-as-data — the supported form
  // is `--non-interactive <answers-json>` (or `--keychain` for the guided
  // secret prompt). There is no free-text TTY wizard; surface the JSON form
  // with a runnable example rather than a "not implemented" dead-end.
  // cross-file: README.md §Quickstart, apps/core-daemon/src/cli/install/support.ts InstallAnswers
  ctx.stderr.write(
    "alaya install takes its answers as JSON.\n" +
      "Run:  alaya install --non-interactive '<answers-json>'\n" +
      "      alaya install --keychain                 # guided secret prompt\n" +
      "Example answers JSON:\n" +
      '  {"embedding_provider":"local_onnx","default_workspace":"default"}\n' +
      "Custom db_path and key_file_path values must use absolute paths; ~ is not expanded.\n" +
      "Fields are documented in README.md §Quickstart.\n"
  );
  return { exitCode: ALAYA_SYSEXITS.USAGE };
}

async function runNonInteractiveInstall(
  ctx: AlayaCliContext,
  args: InstallArgs,
  deps: InstallCommandDependencies
): Promise<AlayaCliResult> {
  const session = createInstallSession(ctx, deps);
  try {
    await ensurePrivateDirectory(session.paths.configDir);
    // Same OS-level lock as runtime/Inspector and keychain writers. Never steal
    // an orphaned lock: an interrupted publication needs operator reconciliation.
    return await withRuntimeEmbeddingFileLock(session.paths.envPath, { timeoutMs: 0 }, async () =>
      await runInstallUnderLock(ctx, args, deps, session)
    );
  } catch (error) {
    ctx.stderr.write(`${sanitizeInstallError(error)}\n`);
    return { exitCode: ALAYA_SYSEXITS.TEMPFAIL };
  }
}

async function runInstallUnderLock(
  ctx: AlayaCliContext,
  args: InstallArgs,
  deps: InstallCommandDependencies,
  session: ReturnType<typeof createInstallSession>
): Promise<AlayaCliResult> {
  const partialState: PartialStateEntry[] = [];
  let auditInitialized = false;

  try {
    const blockingMessage = await prepareInstallSession(session, args.force);
    if (blockingMessage !== null) {
      ctx.stderr.write(`${blockingMessage}\n`);
      return { exitCode: ALAYA_SYSEXITS.TEMPFAIL };
    }
    await writeInstallAudit(session.auditPath, {
      status: "started",
      started_at: session.startedAt,
      finished_at: null,
      config_dir: session.paths.configDir,
      partial_state: [],
      error: null
    });
    auditInitialized = true;
    await applyInstallConfig(args.answers!, session.paths, partialState, deps.platform ?? process.platform);
    await finalizeInstallSuccess(ctx, session, partialState);
    return buildInstallSuccessResult(session.paths, session.auditPath);
  } catch (error) {
    return await finalizeInstallFailure(ctx, session, partialState, auditInitialized, error);
  }
}

function createInstallSession(
  ctx: AlayaCliContext,
  deps: InstallCommandDependencies
) {
  const clock = deps.clock ?? (() => new Date().toISOString());
  const configDir = deps.configDirResolver?.(ctx) ?? resolveAlayaConfigDir({ env: ctx.env });
  const paths = resolveAlayaConfigPaths(configDir);
  const startedAt = clock();
  return {
    clock,
    paths,
    startedAt,
    auditPath: buildInstallAuditPath(paths, startedAt)
  };
}

async function prepareInstallSession(
  session: ReturnType<typeof createInstallSession>,
  force: boolean
): Promise<string | null> {
  await ensurePrivateDirectory(session.paths.configDir);
  await ensurePrivateDirectory(session.paths.auditDir);
  if (force) {
    return null;
  }
  const blocking = await detectBlockingPriorAudit(session.paths);
  if (blocking === null) {
    return null;
  }
  return (
    `previous install audit ${blocking.fileName} reports status="${blocking.status}"; ` +
    "partial_state may be unrecovered. Re-run with --force to override."
  );
}

async function applyInstallConfig(
  answers: InstallAnswers,
  paths: AlayaConfigPaths,
  partialState: PartialStateEntry[],
  platform: NodeJS.Platform
): Promise<void> {
  const existing = await readExistingInstallConfig(paths);
  const resolved = resolveInstallAnswers(answers, existing, paths);
  if (resolved.secret_ref?.startsWith("file:")
    && resolveContainedFileSecretPath(resolved.secret_ref.slice("file:".length), paths.secretsDir) === null) {
    throw new CoreError("VALIDATION", "File secret ref must resolve inside the configured secrets directory.");
  }
  await persistPastedSecret(paths, resolved.pasted_secret, partialState, platform);
  await persistInstallTextFiles(paths, resolved, partialState);
  await ensureSchemaReady(resolved.db_path);
}

async function persistPastedSecret(
  paths: AlayaConfigPaths,
  pastedSecret: ResolvedInstallConfig["pasted_secret"],
  partialState: PartialStateEntry[],
  platform: NodeJS.Platform
): Promise<void> {
  if (pastedSecret === null) {
    return;
  }
  assertPasteSecretSupported(platform);
  await ensurePrivateDirectory(paths.secretsDir);
  const secretBefore = await readOptional(pastedSecret.path);
  const afterContent = `${pastedSecret.value.trimEnd()}\n`;
  partialState.push({ path: pastedSecret.path, beforeContent: secretBefore ?? undefined, afterContent });
  await writePrivateTextAtomic(pastedSecret.path, afterContent, 0o600);
}

async function persistInstallTextFiles(
  paths: AlayaConfigPaths,
  resolved: ResolvedInstallConfig,
  partialState: PartialStateEntry[]
): Promise<void> {
  const nextToml = renderAlayaToml(resolved);
  const nextEnv = mergeOwnedEnvEntries(
    await readOptional(paths.envPath),
    INSTALL_ENV_KEYS,
    buildInstallEnvEntries(resolved)
  );
  await persistInstallFile(paths.tomlPath, nextToml, partialState);
  await persistInstallFile(paths.envPath, nextEnv, partialState);
}

async function persistInstallFile(
  filePath: string,
  nextContent: string,
  partialState: PartialStateEntry[]
): Promise<void> {
  const before = await readOptional(filePath);
  if (normalizeFile(before) === normalizeFile(nextContent)) {
    await chmod(filePath, 0o600);
    return;
  }
  partialState.push({ path: filePath, beforeContent: before ?? undefined, afterContent: nextContent });
  await writePrivateTextAtomic(filePath, nextContent, 0o600);
}

async function finalizeInstallSuccess(
  ctx: AlayaCliContext,
  session: ReturnType<typeof createInstallSession>,
  partialState: readonly PartialStateEntry[]
): Promise<void> {
  await writeInstallAudit(session.auditPath, {
    status: "succeeded",
    started_at: session.startedAt,
    finished_at: session.clock(),
    config_dir: session.paths.configDir,
    partial_state: partialState.map((entry) => entry.path),
    error: null
  });
  if (ctx.jsonRequested !== true) {
    ctx.stdout.write(`installed Alaya config at ${session.paths.configDir}\n`);
  }
}

function buildInstallSuccessResult(paths: AlayaConfigPaths, auditPath: string): AlayaCliResult {
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
}

async function finalizeInstallFailure(
  ctx: AlayaCliContext,
  session: ReturnType<typeof createInstallSession>,
  partialState: readonly PartialStateEntry[],
  auditInitialized: boolean,
  error: unknown
): Promise<AlayaCliResult> {
  const rollbackErrors = await rollbackPartialState(partialState);
  if (auditInitialized) {
    await writeInstallAudit(session.auditPath, {
      status: "failed",
      started_at: session.startedAt,
      finished_at: session.clock(),
      config_dir: session.paths.configDir,
      partial_state: partialState.map((entry) => entry.path),
      error: sanitizeInstallError(error),
      rollback_errors: rollbackErrors.length > 0 ? rollbackErrors : undefined
    }).catch(() => undefined);
  }
  ctx.stderr.write(`${sanitizeInstallError(error)}\n`);
  return { exitCode: ALAYA_SYSEXITS.CANTCREAT };
}
