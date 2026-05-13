import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { CoreError } from "@do-soul/alaya-core";
import {
  RuntimeEmbeddingConfigPatchSchema,
  RuntimeGardenComputeConfigPatchSchema,
  type RuntimeEmbeddingConfig,
  type RuntimeEmbeddingConfigPatch,
  type RuntimeGardenComputeConfig,
  type RuntimeGardenComputeConfigPatch
} from "@do-soul/alaya-protocol";
import type { AlayaConfigPaths } from "../cli/config-files.js";
import {
  ensurePrivateDirectory,
  isNodeErrorWithCode,
  syncDirectory,
  writePrivateTextAtomic
} from "./private-file-service.js";

export const ALAYA_OPENAI_SECRET_REF_ENV = "ALAYA_OPENAI_SECRET_REF";
export const ALAYA_OFFICIAL_GARDEN_SECRET_REF_ENV = "ALAYA_OFFICIAL_GARDEN_SECRET_REF";
export const OFFICIAL_API_GARDEN_MODEL_ENV = "OFFICIAL_API_GARDEN_MODEL";
export const OFFICIAL_API_GARDEN_PROVIDER_URL_ENV = "OFFICIAL_API_GARDEN_PROVIDER_URL";
// Garden compute mode is otherwise inferred from secret presence; this env key
// lets an operator (or a fresh install) declare it explicitly, including the
// host_worker mode that the inference path can never produce.
export const ALAYA_GARDEN_PROVIDER_KIND_ENV = "ALAYA_GARDEN_PROVIDER_KIND";

const ENV_SECRET_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

type SecretRefMode = "env" | "file" | "paste";

type RawRuntimeEmbeddingConfigPatch = RuntimeEmbeddingConfigPatch & {
  readonly secret_ref_mode?: SecretRefMode;
  readonly secret_value?: string | null;
};

type MutableRuntimeEmbeddingConfigPatch = {
  -readonly [K in keyof RuntimeEmbeddingConfig]?: RuntimeEmbeddingConfig[K];
};

type RawRuntimeGardenComputeConfigPatch = RuntimeGardenComputeConfigPatch & {
  readonly secret_ref_mode?: SecretRefMode;
  readonly secret_value?: string | null;
};

type MutableRuntimeGardenComputeConfigPatch = {
  -readonly [K in keyof RuntimeGardenComputeConfig]?: RuntimeGardenComputeConfig[K];
};

export type NormalizedRuntimeEmbeddingConfigPatch = Readonly<{
  readonly patch: Partial<RuntimeEmbeddingConfig>;
  readonly pastedSecret: Readonly<{ readonly path: string; readonly value: string }> | null;
}>;

export type NormalizedRuntimeGardenComputeConfigPatch = Readonly<{
  readonly patch: Partial<RuntimeGardenComputeConfig>;
  readonly pastedSecret: Readonly<{ readonly path: string; readonly value: string }> | null;
}>;

export function normalizeRuntimeEmbeddingConfigPatch(
  patch: unknown,
  paths: AlayaConfigPaths,
  platform: NodeJS.Platform
): NormalizedRuntimeEmbeddingConfigPatch {
  const parsedPatch = parseRuntimeEmbeddingConfigPatchWithSecretControls(patch);
  const normalized: MutableRuntimeEmbeddingConfigPatch = {};

  if (parsedPatch.provider_url !== undefined) normalized.provider_url = parsedPatch.provider_url;
  if (parsedPatch.model_id !== undefined) normalized.model_id = parsedPatch.model_id;
  if (parsedPatch.embedding_enabled !== undefined) normalized.embedding_enabled = parsedPatch.embedding_enabled;

  if (parsedPatch.secret_ref_mode === undefined) {
    if (parsedPatch.secret_value !== undefined) {
      throw invalidRuntimeEmbeddingPatch();
    }
    if (parsedPatch.secret_ref !== undefined) {
      normalized.secret_ref =
        parsedPatch.secret_ref === null ? null : normalizeSecretRef(parsedPatch.secret_ref);
    }
    return { patch: normalized, pastedSecret: null };
  }

  if (parsedPatch.secret_ref === null) {
    normalized.secret_ref = null;
    return { patch: normalized, pastedSecret: null };
  }

  const secretValue = parsedPatch.secret_value;
  if (typeof secretValue !== "string" || secretValue.trim().length === 0) {
    throw invalidRuntimeEmbeddingPatch();
  }

  if (parsedPatch.secret_ref_mode === "env") {
    const envName = secretValue.trim();
    if (!ENV_SECRET_REF_PATTERN.test(envName)) {
      throw invalidRuntimeEmbeddingPatch();
    }
    normalized.secret_ref = `env:${envName}`;
    return { patch: normalized, pastedSecret: null };
  }

  if (parsedPatch.secret_ref_mode === "file") {
    const filePath = secretValue.trim();
    if (!path.isAbsolute(filePath)) {
      throw invalidRuntimeEmbeddingPatch();
    }
    normalized.secret_ref = `file:${filePath}`;
    return { patch: normalized, pastedSecret: null };
  }

  if (platform === "win32") {
    throw new CoreError("VALIDATION", "paste mode is not supported on win32");
  }

  const secretPath = path.join(paths.secretsDir, "openai");
  normalized.secret_ref = `file:${secretPath}`;
  return {
    patch: normalized,
    pastedSecret: {
      path: secretPath,
      value: secretValue
    }
  };
}

export function normalizeRuntimeGardenComputeConfigPatch(
  patch: unknown,
  paths: AlayaConfigPaths,
  platform: NodeJS.Platform
): NormalizedRuntimeGardenComputeConfigPatch {
  const parsedPatch = parseRuntimeGardenComputeConfigPatchWithSecretControls(patch);
  const normalized: MutableRuntimeGardenComputeConfigPatch = {};

  if (parsedPatch.provider_kind !== undefined) normalized.provider_kind = parsedPatch.provider_kind;
  if (parsedPatch.provider_url !== undefined) normalized.provider_url = parsedPatch.provider_url;
  if (parsedPatch.model_id !== undefined) normalized.model_id = parsedPatch.model_id;
  if (parsedPatch.enabled !== undefined) normalized.enabled = parsedPatch.enabled;

  if (parsedPatch.secret_ref_mode === undefined) {
    if (parsedPatch.secret_value !== undefined) {
      throw invalidRuntimeGardenComputePatch();
    }
    if (parsedPatch.secret_ref !== undefined) {
      normalized.secret_ref =
        parsedPatch.secret_ref === null ? null : normalizeSecretRef(parsedPatch.secret_ref);
    }
    return { patch: normalized, pastedSecret: null };
  }

  if (parsedPatch.secret_ref === null) {
    normalized.secret_ref = null;
    return { patch: normalized, pastedSecret: null };
  }

  const secretValue = parsedPatch.secret_value;
  if (typeof secretValue !== "string" || secretValue.trim().length === 0) {
    throw invalidRuntimeGardenComputePatch();
  }

  if (parsedPatch.secret_ref_mode === "env") {
    const envName = secretValue.trim();
    if (!ENV_SECRET_REF_PATTERN.test(envName)) {
      throw invalidRuntimeGardenComputePatch();
    }
    normalized.secret_ref = `env:${envName}`;
    return { patch: normalized, pastedSecret: null };
  }

  if (parsedPatch.secret_ref_mode === "file") {
    const filePath = secretValue.trim();
    if (!path.isAbsolute(filePath)) {
      throw invalidRuntimeGardenComputePatch();
    }
    normalized.secret_ref = `file:${filePath}`;
    return { patch: normalized, pastedSecret: null };
  }

  if (platform === "win32") {
    throw new CoreError("VALIDATION", "paste mode is not supported on win32");
  }

  const secretPath = path.join(paths.secretsDir, "official-garden");
  normalized.secret_ref = `file:${secretPath}`;
  return {
    patch: normalized,
    pastedSecret: {
      path: secretPath,
      value: secretValue
    }
  };
}

export async function applyRuntimeEmbeddingConfigFiles<T>(input: {
  readonly paths: AlayaConfigPaths;
  readonly normalized: NormalizedRuntimeEmbeddingConfigPatch;
  readonly generateTempId: () => string;
  readonly persist: () => Promise<T>;
  readonly lockTimeoutMs?: number;
  readonly lockRetryMs?: number;
}): Promise<T> {
  return await withRuntimeEmbeddingConfigLock(input.paths.envPath, async () =>
    await withRuntimeEmbeddingFileLock(
      input.paths.envPath,
      {
        timeoutMs: input.lockTimeoutMs,
        retryMs: input.lockRetryMs
      },
      async () => await applyRuntimeEmbeddingConfigFilesLocked(input)
    )
  );
}

export async function applyRuntimeGardenComputeConfigFiles<T>(input: {
  readonly paths: AlayaConfigPaths;
  readonly normalized: NormalizedRuntimeGardenComputeConfigPatch;
  readonly generateTempId: () => string;
  readonly persist: () => Promise<T>;
  readonly lockTimeoutMs?: number;
  readonly lockRetryMs?: number;
}): Promise<T> {
  return await withRuntimeEmbeddingConfigLock(input.paths.envPath, async () =>
    await withRuntimeEmbeddingFileLock(
      input.paths.envPath,
      {
        timeoutMs: input.lockTimeoutMs,
        retryMs: input.lockRetryMs
      },
      async () => await applyRuntimeGardenComputeConfigFilesLocked(input)
    )
  );
}

async function applyRuntimeEmbeddingConfigFilesLocked<T>(input: {
  readonly paths: AlayaConfigPaths;
  readonly normalized: NormalizedRuntimeEmbeddingConfigPatch;
  readonly generateTempId: () => string;
  readonly persist: () => Promise<T>;
}): Promise<T> {
  const previousEnv = await readOptional(input.paths.envPath);
  const previousSecret =
    input.normalized.pastedSecret === null ? null : await readOptional(input.normalized.pastedSecret.path);

  if (input.normalized.pastedSecret !== null) {
    await ensurePrivateDirectory(input.paths.secretsDir);
  }

  try {
    if (input.normalized.pastedSecret !== null) {
      await writeTextAtomicLocked(
        input.normalized.pastedSecret.path,
        `${trimTrailingLineBreaks(input.normalized.pastedSecret.value)}\n`,
        0o600,
        input.generateTempId
      );
    }

    await patchRuntimeEmbeddingEnvFile(input.paths, input.normalized.patch, input.generateTempId);
    return await input.persist();
  } catch (error) {
    await restoreRuntimeEmbeddingFiles(
      input.paths,
      previousEnv,
      input.normalized.pastedSecret,
      previousSecret,
      input.generateTempId
    );
    throw error;
  }
}

async function applyRuntimeGardenComputeConfigFilesLocked<T>(input: {
  readonly paths: AlayaConfigPaths;
  readonly normalized: NormalizedRuntimeGardenComputeConfigPatch;
  readonly generateTempId: () => string;
  readonly persist: () => Promise<T>;
}): Promise<T> {
  const previousEnv = await readOptional(input.paths.envPath);
  const previousSecret =
    input.normalized.pastedSecret === null ? null : await readOptional(input.normalized.pastedSecret.path);

  if (input.normalized.pastedSecret !== null) {
    await ensurePrivateDirectory(input.paths.secretsDir);
  }

  try {
    if (input.normalized.pastedSecret !== null) {
      await writeTextAtomicLocked(
        input.normalized.pastedSecret.path,
        `${trimTrailingLineBreaks(input.normalized.pastedSecret.value)}\n`,
        0o600,
        input.generateTempId
      );
    }

    await patchRuntimeGardenComputeEnvFile(input.paths, input.normalized.patch, input.generateTempId);
    return await input.persist();
  } catch (error) {
    await restoreRuntimeEmbeddingFiles(
      input.paths,
      previousEnv,
      input.normalized.pastedSecret,
      previousSecret,
      input.generateTempId
    );
    throw error;
  }
}

export function parseEnv(content: string | null): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of (content ?? "").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;

    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    entries.set(key, parseEnvValue(rawValue));
  }
  return entries;
}

export function renderEnv(entries: ReadonlyMap<string, string>): string {
  return `${Array.from(entries.entries()).map(([key, value]) => `${renderEnvKey(key)}=${renderEnvValue(value)}`).join("\n")}\n`;
}

async function patchRuntimeEmbeddingEnvFile(
  paths: AlayaConfigPaths,
  patch: Partial<RuntimeEmbeddingConfig>,
  generateTempId: () => string
): Promise<void> {
  const existing = parseEnv(await readOptional(paths.envPath));
  const next = new Map(existing);

  if (patch.embedding_enabled !== undefined) {
    next.set("ALAYA_ENABLE_EMBEDDING_SUPPLEMENT", patch.embedding_enabled ? "true" : "false");
  }
  if (patch.secret_ref !== undefined) {
    if (patch.secret_ref === null) {
      next.delete(ALAYA_OPENAI_SECRET_REF_ENV);
    } else {
      next.set(ALAYA_OPENAI_SECRET_REF_ENV, patch.secret_ref);
    }
  }
  if (patch.model_id !== undefined) {
    setOrDelete(next, "OPENAI_EMBEDDING_MODEL", patch.model_id);
  }
  if (patch.provider_url !== undefined) {
    setOrDelete(next, "OPENAI_EMBEDDING_PROVIDER_URL", patch.provider_url);
  }

  await writeTextAtomicLocked(paths.envPath, renderEnv(next), 0o600, generateTempId);
}

function parseRuntimeEmbeddingConfigPatchWithSecretControls(patch: unknown): RawRuntimeEmbeddingConfigPatch {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    throw invalidRuntimeEmbeddingPatch();
  }

  const record = patch as Record<string, unknown>;
  const protocolPatch: Record<string, unknown> = {};
  const allowedKeys = new Set([
    "provider_url",
    "secret_ref",
    "model_id",
    "embedding_enabled",
    "secret_ref_mode",
    "secret_value"
  ]);

  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new CoreError("VALIDATION", `Unknown runtime embedding config field: ${key}`);
    }
    if (key !== "secret_ref_mode" && key !== "secret_value") {
      protocolPatch[key] = record[key];
    }
  }

  const parsedProtocolPatch = RuntimeEmbeddingConfigPatchSchema.safeParse(protocolPatch);
  if (!parsedProtocolPatch.success) {
    throw new CoreError("VALIDATION", "Invalid runtime embedding config patch", {
      cause: parsedProtocolPatch.error
    });
  }

  return {
    ...parsedProtocolPatch.data,
    ...("secret_ref_mode" in record ? { secret_ref_mode: parseSecretRefMode(record.secret_ref_mode) } : {}),
    ...("secret_value" in record ? { secret_value: parseNullableRawString(record.secret_value, "secret_value") } : {})
  };
}

function parseNullableRawString(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new CoreError("VALIDATION", `${field} must be a string or null`);
  }
  return value;
}

function parseSecretRefMode(value: unknown): SecretRefMode {
  if (value === "env" || value === "file" || value === "paste") {
    return value;
  }
  throw invalidRuntimeEmbeddingPatch();
}

function normalizeSecretRef(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("env:")) {
    const envName = trimmed.slice("env:".length);
    if (ENV_SECRET_REF_PATTERN.test(envName)) {
      return trimmed;
    }
  }
  if (trimmed.startsWith("file:")) {
    const filePath = trimmed.slice("file:".length);
    if (path.isAbsolute(filePath)) {
      return trimmed;
    }
  }
  if (trimmed.startsWith("keychain:")) {
    const segments = trimmed.slice("keychain:".length).split(":");
    if (segments.length === 2 && segments[0] !== "" && segments[1] !== "") {
      return trimmed;
    }
  }
  throw invalidRuntimeEmbeddingPatch();
}

function parseEnvValue(rawValue: string): string {
  if (rawValue.startsWith("\"")) {
    if (!rawValue.endsWith("\"") || rawValue.length === 1) {
      throw new CoreError("VALIDATION", "Invalid quoted .env value");
    }
    return rawValue.slice(1, -1).replace(/\\(["\\])/gu, "$1");
  }
  return rawValue;
}

function renderEnvKey(key: string): string {
  if (!ENV_KEY_PATTERN.test(key)) {
    throw new CoreError("VALIDATION", `Invalid .env key: ${key}`);
  }
  return key;
}

function renderEnvValue(value: string): string {
  if (/[\r\n]/u.test(value)) {
    throw new CoreError("VALIDATION", ".env values must be single-line");
  }
  if (value.includes("#")) {
    return `"${value.replace(/["\\]/gu, "\\$&")}"`;
  }
  return value;
}

async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}

async function restoreRuntimeEmbeddingFiles(
  paths: AlayaConfigPaths,
  previousEnv: string | null,
  pastedSecret: Readonly<{ readonly path: string; readonly value: string }> | null,
  previousSecret: string | null,
  generateTempId: () => string
): Promise<void> {
  await restoreTextFile(paths.envPath, previousEnv, 0o600, generateTempId);
  if (pastedSecret !== null) {
    await restoreTextFile(pastedSecret.path, previousSecret, 0o600, generateTempId);
  }
}

async function restoreTextFile(
  filePath: string,
  previousContent: string | null,
  mode: number,
  generateTempId: () => string
): Promise<void> {
  if (previousContent === null) {
    await unlink(filePath).catch((error) => {
      if (!isNodeErrorWithCode(error, "ENOENT")) {
        throw error;
      }
    });
    await syncDirectory(path.dirname(filePath)).catch(() => undefined);
    return;
  }

  await writeTextAtomicLocked(filePath, previousContent, mode, generateTempId);
}

function setOrDelete(map: Map<string, string>, key: string, value: string | null): void {
  if (value === null) {
    map.delete(key);
  } else {
    map.set(key, value);
  }
}

const pathWriteLocks = new Map<string, Promise<unknown>>();
const runtimeEmbeddingConfigLocks = new Map<string, Promise<unknown>>();
const RUNTIME_EMBEDDING_CONFIG_LOCK_SUFFIX = ".runtime-embedding.lock";
const DEFAULT_RUNTIME_EMBEDDING_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_RUNTIME_EMBEDDING_LOCK_RETRY_MS = 10;

async function withRuntimeEmbeddingConfigLock<T>(lockKey: string, operation: () => Promise<T>): Promise<T> {
  const previous = runtimeEmbeddingConfigLocks.get(lockKey) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  runtimeEmbeddingConfigLocks.set(lockKey, current);
  try {
    return await current;
  } finally {
    if (runtimeEmbeddingConfigLocks.get(lockKey) === current) {
      runtimeEmbeddingConfigLocks.delete(lockKey);
    }
  }
}

async function withRuntimeEmbeddingFileLock<T>(
  lockKey: string,
  options: {
    readonly timeoutMs?: number;
    readonly retryMs?: number;
  },
  operation: () => Promise<T>
): Promise<T> {
  const lockPath = `${lockKey}${RUNTIME_EMBEDDING_CONFIG_LOCK_SUFFIX}`;
  const lock = await acquireRuntimeEmbeddingFileLock(lockPath, {
    timeoutMs: options.timeoutMs ?? DEFAULT_RUNTIME_EMBEDDING_LOCK_TIMEOUT_MS,
    retryMs: options.retryMs ?? DEFAULT_RUNTIME_EMBEDDING_LOCK_RETRY_MS
  });
  try {
    return await operation();
  } finally {
    await lock.release();
  }
}

async function acquireRuntimeEmbeddingFileLock(
  lockPath: string,
  options: {
    readonly timeoutMs: number;
    readonly retryMs: number;
  }
): Promise<{ readonly release: () => Promise<void> }> {
  const deadline = Date.now() + Math.max(0, options.timeoutMs);
  const retryMs = Math.max(1, options.retryMs);

  for (;;) {
    try {
      await ensurePrivateDirectory(path.dirname(lockPath));
      const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
      const handle = await open(
        lockPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow,
        0o600
      );
      let closed = false;
      try {
        await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, "utf8");
        await handle.sync();
        await handle.close();
        closed = true;
        await syncDirectory(path.dirname(lockPath));
        return {
          release: async () => {
            await unlink(lockPath).catch((error) => {
              if (!isNodeErrorWithCode(error, "ENOENT")) {
                throw error;
              }
            });
            await syncDirectory(path.dirname(lockPath)).catch(() => undefined);
          }
        };
      } catch (error) {
        if (!closed) {
          await handle.close().catch(() => undefined);
        }
        await unlink(lockPath).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (!isNodeErrorWithCode(error, "EEXIST")) {
        throw error;
      }
      await assertRuntimeEmbeddingFileLockIsRegular(lockPath);
      if (Date.now() >= deadline) {
        throw new CoreError("CONFLICT", "Runtime embedding config write is already in progress");
      }
      await sleep(retryMs);
    }
  }
}

async function assertRuntimeEmbeddingFileLockIsRegular(lockPath: string): Promise<void> {
  try {
    const stats = await lstat(lockPath);
    if (!stats.isFile()) {
      throw new CoreError("CONFLICT", "Runtime embedding config lock is not a regular file");
    }
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
}

async function writeTextAtomicLocked(
  filePath: string,
  content: string,
  mode: number,
  generateTempId: () => string
): Promise<void> {
  await withPathWriteLock(
    filePath,
    async () => await writePrivateTextAtomic(filePath, content, mode, generateTempId)
  );
}

async function withPathWriteLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const previous = pathWriteLocks.get(filePath) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  pathWriteLocks.set(filePath, current);
  try {
    return await current;
  } finally {
    if (pathWriteLocks.get(filePath) === current) {
      pathWriteLocks.delete(filePath);
    }
  }
}

function trimTrailingLineBreaks(value: string): string {
  return value.replace(/[\r\n]+$/u, "");
}

function invalidRuntimeEmbeddingPatch(): CoreError {
  return new CoreError("VALIDATION", "Invalid runtime embedding config patch");
}

function invalidRuntimeGardenComputePatch(): CoreError {
  return new CoreError("VALIDATION", "Invalid runtime garden compute config patch");
}

function parseRuntimeGardenComputeConfigPatchWithSecretControls(
  patch: unknown
): RawRuntimeGardenComputeConfigPatch {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    throw invalidRuntimeGardenComputePatch();
  }

  const record = patch as Record<string, unknown>;
  const protocolPatch: Record<string, unknown> = {};
  const allowedKeys = new Set([
    "provider_kind",
    "provider_url",
    "secret_ref",
    "model_id",
    "enabled",
    "secret_ref_mode",
    "secret_value"
  ]);

  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new CoreError("VALIDATION", `Unknown runtime garden compute config field: ${key}`);
    }
    if (key !== "secret_ref_mode" && key !== "secret_value") {
      protocolPatch[key] = record[key];
    }
  }

  const parsedProtocolPatch = RuntimeGardenComputeConfigPatchSchema.safeParse(protocolPatch);
  if (!parsedProtocolPatch.success) {
    throw new CoreError("VALIDATION", "Invalid runtime garden compute config patch", {
      cause: parsedProtocolPatch.error
    });
  }

  return {
    ...parsedProtocolPatch.data,
    ...("secret_ref_mode" in record
      ? { secret_ref_mode: parseSecretRefMode(record.secret_ref_mode) }
      : {}),
    ...("secret_value" in record
      ? { secret_value: parseNullableRawString(record.secret_value, "secret_value") }
      : {})
  };
}

async function patchRuntimeGardenComputeEnvFile(
  paths: AlayaConfigPaths,
  patch: Partial<RuntimeGardenComputeConfig>,
  generateTempId: () => string
): Promise<void> {
  const existing = parseEnv(await readOptional(paths.envPath));
  const next = new Map(existing);

  if (patch.provider_kind !== undefined) {
    next.set(ALAYA_GARDEN_PROVIDER_KIND_ENV, patch.provider_kind);
  }
  if (patch.enabled !== undefined) {
    next.set("ALAYA_ENABLE_GARDEN_OFFICIAL", patch.enabled ? "true" : "false");
  }
  if (patch.secret_ref !== undefined) {
    if (patch.secret_ref === null) {
      next.delete(ALAYA_OFFICIAL_GARDEN_SECRET_REF_ENV);
    } else {
      next.set(ALAYA_OFFICIAL_GARDEN_SECRET_REF_ENV, patch.secret_ref);
    }
  }
  if (patch.model_id !== undefined) {
    setOrDelete(next, OFFICIAL_API_GARDEN_MODEL_ENV, patch.model_id);
  }
  if (patch.provider_url !== undefined) {
    setOrDelete(next, OFFICIAL_API_GARDEN_PROVIDER_URL_ENV, patch.provider_url);
  }

  await writeTextAtomicLocked(paths.envPath, renderEnv(next), 0o600, generateTempId);
}
