import type { RuntimeGardenComputeConfig } from "@do-soul/alaya-protocol";
import { ALAYA_SYSEXITS, type AlayaCliContext, type AlayaCliResult } from "../bridge.js";
import {
  buildInstallAuditPath,
  resolveAlayaConfigDir,
  resolveAlayaConfigPaths,
  type AlayaConfigPaths
} from "../config-files.js";
import { ensurePrivateDirectory, writePrivateTextAtomic } from "../../services/private-file-service.js";
import { resolveSecretRef as resolveRuntimeSecretRef, type ResolveSecretError } from "../../secrets/index.js";
import {
  checkPlatformKeychainAvailable,
  type KeychainReadResult,
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
  normalizeFile,
  readOptional,
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
import {
  patchPersistedGardenSecretRefIfPresent,
  restorePersistedGardenConfig,
  resolveExistingDbPath
} from "./keychain-install-garden-config.js";

export async function executeKeychainInstall(
  ctx: AlayaCliContext,
  args: InstallArgs,
  deps: InstallCommandDependencies
): Promise<AlayaCliResult> {
  if (args.nonInteractive) {
    return reportKeychainInstallUsage(ctx.stderr);
  }

  const session = await createKeychainInstallSession(ctx, deps);
  const preflightResult = await prepareKeychainInstall(session, args.force);
  if (preflightResult !== null) {
    const preflightJson = preflightResult.json;
    if (typeof preflightJson === "object" && preflightJson !== null && "error" in preflightJson) {
      ctx.stderr.write(`${String(preflightJson.error)}\n`);
    }
    return preflightResult;
  }

  const secret = await promptKeychainSecret(ctx, session.keychainRef);
  if (secret === null) {
    return reportEmptyKeychainSecret(ctx.stderr);
  }

  return await persistKeychainInstall(ctx, deps, session, secret);
}

interface KeychainInstallSession {
  readonly service: string;
  readonly account: string;
  readonly keychainRef: string;
  readonly clock: () => string;
  readonly paths: AlayaConfigPaths;
  readonly startedAt: string;
  readonly auditPath: string;
  readonly partialState: PartialStateEntry[];
  readonly checkAvailable: (service: string, account: string) => KeychainAvailabilityResult;
  readonly writeKeychain: (service: string, account: string, value: string) => KeychainWriteResult;
  readonly readKeychain: (service: string, account: string) => KeychainReadResult;
  readonly platform: NodeJS.Platform;
}

function reportKeychainInstallUsage(stderr: NodeJS.WritableStream): AlayaCliResult {
  stderr.write("install --keychain requires interactive input; --non-interactive is not supported for keychain secrets.\n");
  return { exitCode: ALAYA_SYSEXITS.USAGE };
}

async function createKeychainInstallSession(
  ctx: AlayaCliContext,
  deps: InstallCommandDependencies
): Promise<KeychainInstallSession> {
  const service = KEYCHAIN_INSTALL_SERVICE;
  const account = KEYCHAIN_INSTALL_ACCOUNT;
  const clock = deps.clock ?? (() => new Date().toISOString());
  const configDir = deps.configDirResolver?.(ctx) ?? resolveAlayaConfigDir({ env: ctx.env });
  const paths = resolveAlayaConfigPaths(configDir);
  const startedAt = clock();
  return {
    service,
    account,
    keychainRef: `keychain:${service}:${account}`,
    clock,
    paths,
    startedAt,
    auditPath: buildInstallAuditPath(paths, startedAt),
    partialState: [],
    checkAvailable:
      deps.keychain?.checkAvailable ??
      ((svc, acct) => checkPlatformKeychainAvailable(svc, acct)),
    writeKeychain:
      deps.keychain?.writeKeychain ??
      ((svc, acct, value) => writePlatformKeychainSecret(svc, acct, value)),
    readKeychain:
      deps.keychain?.readKeychain ??
      ((svc, acct) => readPlatformKeychainSecret(svc, acct)),
    platform: deps.platform ?? process.platform
  };
}

async function prepareKeychainInstall(
  session: KeychainInstallSession,
  force: boolean
): Promise<AlayaCliResult | null> {
  await Promise.all([
    ensurePrivateDirectory(session.paths.configDir),
    ensurePrivateDirectory(session.paths.auditDir)
  ]);
  if (!force) {
    const blocking = await detectBlockingPriorAudit(session.paths);
    if (blocking !== null) {
      return reportKeychainInstallTempfail(
        `previous install audit ${blocking.fileName} reports status=\"${blocking.status}\"; partial_state may be unrecovered. Re-run with --force to override.`
      );
    }
  }
  const availability = session.checkAvailable(session.service, session.account);
  if (!("ok" in availability)) {
    return reportKeychainInstallTempfail(formatKeychainInstallError(availability));
  }
  return null;
}

function reportKeychainInstallTempfail(message: string): AlayaCliResult {
  return {
    exitCode: ALAYA_SYSEXITS.TEMPFAIL,
    json: {
      ok: false,
      error: message
    }
  };
}

async function promptKeychainSecret(
  ctx: AlayaCliContext,
  keychainRef: string
): Promise<string | null> {
  ctx.stderr.write(`Enter secret for ${keychainRef}: `);
  const secret = await readSecretLine(ctx.stdin, ctx.stderr, ctx.isTTY);
  return secret.trim().length === 0 ? null : secret;
}

function reportEmptyKeychainSecret(stderr: NodeJS.WritableStream): AlayaCliResult {
  stderr.write("install --keychain requires a non-empty secret value.\n");
  return { exitCode: ALAYA_SYSEXITS.USAGE };
}

async function persistKeychainInstall(
  ctx: AlayaCliContext,
  deps: InstallCommandDependencies,
  session: KeychainInstallSession,
  secret: string
): Promise<AlayaCliResult> {
  const auditState = await initializeKeychainInstallAudit(session, deps.platform ?? process.platform);
  let persistedGardenConfigBefore: RuntimeGardenComputeConfig | null | undefined;
  try {
    writeAndVerifyKeychainSecret(ctx, session, secret);
    const persistedPatch = await persistKeychainInstallFiles(session);
    persistedGardenConfigBefore = persistedPatch?.before;
    const persistedGardenConfigChange = summarizePersistedGardenConfigChange(persistedPatch);
    await finalizeKeychainInstallSuccess(ctx, session, persistedGardenConfigChange);
    return buildKeychainInstallSuccessResult(session);
  } catch (error) {
    return await finalizeKeychainInstallFailure(
      ctx,
      session,
      auditState.auditInitialized,
      persistedGardenConfigBefore,
      auditState.keychainOrphan,
      error
    );
  }
}

function writeAndVerifyKeychainSecret(
  ctx: AlayaCliContext,
  session: KeychainInstallSession,
  secret: string
): void {
  const writeResult = session.writeKeychain(session.service, session.account, secret);
  if (!("ok" in writeResult)) {
    throw new Error(formatKeychainInstallError(writeResult));
  }
  verifyKeychainSecretRef(ctx, session);
}

function verifyKeychainSecretRef(
  ctx: AlayaCliContext,
  session: KeychainInstallSession
): void {
  const verified = resolveRuntimeSecretRef(session.keychainRef, {
    readEnv: (name) => ctx.env[name],
    readFile: () => {
      throw new Error("unexpected file secret read during keychain verification");
    },
    readKeychain: session.readKeychain
  });
  if ("kind" in verified) {
    throw new Error(`keychain write verification failed: ${formatSecretRefVerificationError(verified)}`);
  }
}

async function persistKeychainInstallFiles(
  session: KeychainInstallSession
): Promise<{ readonly before: RuntimeGardenComputeConfig; readonly after: RuntimeGardenComputeConfig } | null> {
  const envBefore = await readOptional(session.paths.envPath);
  const nextEnv = patchEnvWithGardenKeychainRef(envBefore, session.keychainRef);
  if (normalizeFile(envBefore) !== normalizeFile(nextEnv)) {
    await writePrivateTextAtomic(session.paths.envPath, nextEnv, 0o600);
    session.partialState.push({ path: session.paths.envPath, beforeContent: envBefore ?? undefined });
  }
  const dbPath = await resolveExistingDbPath(session.paths);
  return await patchPersistedGardenSecretRefIfPresent(dbPath, session.keychainRef, session.startedAt);
}

async function initializeKeychainInstallAudit(
  session: KeychainInstallSession,
  platform: NodeJS.Platform
): Promise<Readonly<{ auditInitialized: true; keychainOrphan: InstallAuditKeychainOrphan }>> {
  await writeInstallAudit(session.auditPath, {
    status: "started",
    started_at: session.startedAt,
    finished_at: null,
    config_dir: session.paths.configDir,
    partial_state: [],
    error: null
  });
  return {
    auditInitialized: true,
    keychainOrphan: buildKeychainOrphanAudit(session.keychainRef, session.service, session.account, platform)
  };
}

function summarizePersistedGardenConfigChange(
  persistedPatch: { readonly before: RuntimeGardenComputeConfig; readonly after: RuntimeGardenComputeConfig } | null
): InstallAuditConfigChange | undefined {
  if (persistedPatch === null) {
    return undefined;
  }
  return {
    key: RUNTIME_GARDEN_COMPUTE_CONFIG_KEY,
    before: summarizeGardenConfigForInstallAudit(persistedPatch.before),
    after: summarizeGardenConfigForInstallAudit(persistedPatch.after)
  };
}

async function finalizeKeychainInstallSuccess(
  ctx: AlayaCliContext,
  session: KeychainInstallSession,
  persistedGardenConfigChange: InstallAuditConfigChange | undefined
): Promise<void> {
  await writeInstallAudit(session.auditPath, {
    status: "succeeded",
    started_at: session.startedAt,
    finished_at: session.clock(),
    config_dir: session.paths.configDir,
    partial_state: session.partialState.map((entry) => entry.path),
    error: null,
    config_changes: persistedGardenConfigChange === undefined ? undefined : [persistedGardenConfigChange]
  });
  if (ctx.jsonRequested !== true) {
    ctx.stdout.write(`installed Alaya keychain ref ${session.keychainRef} at ${session.paths.envPath}\n`);
  }
}

function buildKeychainInstallSuccessResult(session: KeychainInstallSession): AlayaCliResult {
  return {
    exitCode: ALAYA_SYSEXITS.OK,
    json: {
      ok: true,
      config_dir: session.paths.configDir,
      env_path: session.paths.envPath,
      audit_path: session.auditPath,
      secret_ref: session.keychainRef
    }
  };
}

async function finalizeKeychainInstallFailure(
  ctx: AlayaCliContext,
  session: KeychainInstallSession,
  auditInitialized: boolean,
  persistedGardenConfigBefore: RuntimeGardenComputeConfig | null | undefined,
  keychainOrphan: InstallAuditKeychainOrphan | undefined,
  error: unknown
): Promise<AlayaCliResult> {
  const rollbackErrors = await rollbackPartialState(session.partialState);
  if (auditInitialized) {
    await writeInstallAudit(session.auditPath, {
      status: "failed",
      started_at: session.startedAt,
      finished_at: session.clock(),
      config_dir: session.paths.configDir,
      partial_state: session.partialState.map((entry) => entry.path),
      error: sanitizeInstallError(error),
      rollback_errors: rollbackErrors.length > 0 ? rollbackErrors : undefined,
      keychain_orphan: keychainOrphan
    }).catch(() => undefined);
  }
  if (persistedGardenConfigBefore !== undefined) {
    await restorePersistedGardenConfig(session.paths, persistedGardenConfigBefore).catch(() => undefined);
  }
  ctx.stderr.write(`${sanitizeInstallError(error)}\n`);
  return { exitCode: ALAYA_SYSEXITS.CANTCREAT };
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
