import path from "node:path";
import { EventPublisher } from "@do-soul/alaya-core";
import {
  GardenEventType,
  HealthEventKind,
  RuntimeGardenComputeConfigSchema,
  SoulHealthJournalRecordedPayloadSchema,
  type RuntimeGardenComputeConfig
} from "@do-soul/alaya-protocol";
import { initDatabase, SqliteConfigRepo, SqliteEventLogRepo } from "@do-soul/alaya-storage";
import { ALAYA_SYSEXITS, type AlayaCliContext, type AlayaCliResult } from "../bridge.js";
import {
  buildInstallAuditPath,
  resolveAlayaConfigDir,
  resolveAlayaConfigPaths,
  type AlayaConfigPaths
} from "../config-files.js";
import { ensurePrivateDirectory, writePrivateTextAtomic } from "../../services/private-file-service.js";
import { resolveSecretRef as resolveRuntimeSecretRef, type ResolveSecretError } from "../../secrets.js";
import {
  checkPlatformKeychainAvailable,
  readPlatformKeychainSecret,
  writePlatformKeychainSecret,
  type KeychainAvailabilityResult,
  type KeychainWriteResult
} from "../../secrets/keychain/index.js";
import { readSecretLine } from "./masked-stdin.js";
import {
  GARDEN_KEYCHAIN_SECRET_REF_ENV,
  KEYCHAIN_INSTALL_ACCOUNT,
  KEYCHAIN_INSTALL_SERVICE,
  RUNTIME_GARDEN_COMPUTE_CONFIG_KEY,
  detectBlockingPriorAudit,
  fileExists,
  normalizeFile,
  readOptional,
  readTomlString,
  rollbackPartialState,
  sanitizeInstallError,
  writeInstallAudit,
  type GardenConfigAuditSnapshot,
  type InstallArgs,
  type InstallAuditConfigChange,
  type InstallAuditKeychainOrphan,
  type InstallCommandDependencies,
  type PartialStateEntry
} from "./support.js";

export async function executeKeychainInstall(
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

  await Promise.all([ensurePrivateDirectory(paths.configDir), ensurePrivateDirectory(paths.auditDir)]);

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
    keychainOrphan = buildKeychainOrphanAudit(keychainRef, service, account, deps.platform ?? process.platform);

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

    const dbPath = await resolveExistingDbPath(paths);
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
  account: string,
  platform: NodeJS.Platform
): InstallAuditKeychainOrphan {
  return {
    secret_ref: secretRef,
    service,
    account,
    remediation: buildKeychainOrphanRemediation(platform, service, account)
  };
}

function buildKeychainOrphanRemediation(
  platform: NodeJS.Platform,
  service: string,
  account: string
): string {
  switch (platform) {
    case "darwin":
      return `Remove the orphaned macOS Keychain item with: security delete-generic-password -s ${service} -a ${account}.`;
    case "linux":
      return `Remove the orphaned libsecret item with: secret-tool clear service ${service} account ${account}.`;
    case "win32":
      return `Remove the orphaned Windows Credential Manager item via the Credential Manager UI or by removing the Windows.Security.Credentials.PasswordCredential for service ${service} account ${account}.`;
    default:
      return `Remove the stale keychain entry for service ${service} account ${account} with the platform keychain tool before retrying if desired.`;
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
  const dbPath = await resolveExistingDbPath(paths);
  if (!(await fileExists(dbPath)) || config === null) {
    return;
  }
  new SqliteConfigRepo(initDatabase({ filename: dbPath })).set(RUNTIME_GARDEN_COMPUTE_CONFIG_KEY, config);
}

async function resolveExistingDbPath(paths: AlayaConfigPaths): Promise<string> {
  const toml = await readOptional(paths.tomlPath);
  const dbPath = toml === null ? null : readTomlString(toml, "storage", "db_path");
  return path.resolve(dbPath ?? path.join(paths.configDir, "alaya.db"));
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
