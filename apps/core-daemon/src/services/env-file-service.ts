import path from "node:path";
import { CoreError } from "@do-soul/alaya-core";
import {
  parseSecretRefKeychainTarget,
  type RuntimeEmbeddingConfig,
  type RuntimeGardenComputeConfig
} from "@do-soul/alaya-protocol";
import type { AlayaConfigPaths } from "../cli/config-files.js";
import {
  parseRuntimeEmbeddingConfigPatchWithSecretControls,
  parseRuntimeGardenComputeConfigPatchWithSecretControls,
  type RawRuntimeEmbeddingConfigPatch,
  type RawRuntimeGardenComputeConfigPatch,
  type SecretRefMode
} from "./env-file-patch-parse.js";
import { parseEnv, renderEnv } from "./env-file-format.js";
import {
  readOptional, restoreRuntimeEmbeddingFiles, setOrDelete, trimTrailingLineBreaks,
  withRuntimeEmbeddingConfigLock, withRuntimeEmbeddingFileLock, writeTextAtomicLocked
} from "./env-file-io.js";
import { ensurePrivateDirectory } from "./private-file-service.js";
export { parseEnv, renderEnv } from "./env-file-format.js";

export const ALAYA_OPENAI_SECRET_REF_ENV = "ALAYA_OPENAI_SECRET_REF";
export const ALAYA_OFFICIAL_GARDEN_SECRET_REF_ENV = "ALAYA_OFFICIAL_GARDEN_SECRET_REF";
export const OFFICIAL_API_GARDEN_MODEL_ENV = "OFFICIAL_API_GARDEN_MODEL";
export const OFFICIAL_API_GARDEN_PROVIDER_URL_ENV = "OFFICIAL_API_GARDEN_PROVIDER_URL";
// Garden compute mode is otherwise inferred from secret presence; this env key
// lets an operator (or a fresh install) declare it explicitly, including the
// host_worker mode that the inference path can never produce.
export const ALAYA_GARDEN_PROVIDER_KIND_ENV = "ALAYA_GARDEN_PROVIDER_KIND";

const ENV_SECRET_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

type MutableRuntimeEmbeddingConfigPatch = {
  -readonly [K in keyof RuntimeEmbeddingConfig]?: RuntimeEmbeddingConfig[K];
};

type MutableRuntimeGardenComputeConfigPatch = {
  -readonly [K in keyof RuntimeGardenComputeConfig]?: RuntimeGardenComputeConfig[K];
};

interface SecretControlledPatchFields {
  readonly secret_ref?: string | null;
  readonly secret_ref_mode?: SecretRefMode;
  readonly secret_value?: string | null;
}

type PastedSecret = Readonly<{ readonly path: string; readonly value: string }>;

export type NormalizedRuntimeEmbeddingConfigPatch = Readonly<{
  readonly patch: Partial<RuntimeEmbeddingConfig>;
  readonly pastedSecret: PastedSecret | null;
}>;

export type NormalizedRuntimeGardenComputeConfigPatch = Readonly<{
  readonly patch: Partial<RuntimeGardenComputeConfig>;
  readonly pastedSecret: PastedSecret | null;
}>;

export function normalizeRuntimeEmbeddingConfigPatch(
  patch: unknown,
  paths: AlayaConfigPaths,
  platform: NodeJS.Platform
): NormalizedRuntimeEmbeddingConfigPatch {
  const parsedPatch = parseRuntimeEmbeddingConfigPatchWithSecretControls(patch);
  const normalized = buildRuntimeEmbeddingConfigPatch(parsedPatch);
  return normalizeSecretControlledPatch({
    parsedPatch,
    normalized,
    invalidPatch: invalidRuntimeEmbeddingPatch,
    platform,
    secretPath: path.join(paths.secretsDir, "openai")
  });
}

export function normalizeRuntimeGardenComputeConfigPatch(
  patch: unknown,
  paths: AlayaConfigPaths,
  platform: NodeJS.Platform
): NormalizedRuntimeGardenComputeConfigPatch {
  const parsedPatch = parseRuntimeGardenComputeConfigPatchWithSecretControls(patch);
  const normalized = buildRuntimeGardenComputeConfigPatch(parsedPatch);
  return normalizeSecretControlledPatch({
    parsedPatch,
    normalized,
    invalidPatch: invalidRuntimeGardenComputePatch,
    platform,
    secretPath: path.join(paths.secretsDir, "official-garden")
  });
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

function buildRuntimeEmbeddingConfigPatch(
  parsedPatch: RawRuntimeEmbeddingConfigPatch
): MutableRuntimeEmbeddingConfigPatch {
  const normalized: MutableRuntimeEmbeddingConfigPatch = {};
  if (parsedPatch.provider_url !== undefined) normalized.provider_url = parsedPatch.provider_url;
  if (parsedPatch.model_id !== undefined) normalized.model_id = parsedPatch.model_id;
  if (parsedPatch.embedding_enabled !== undefined) normalized.embedding_enabled = parsedPatch.embedding_enabled;
  return normalized;
}

function buildRuntimeGardenComputeConfigPatch(
  parsedPatch: RawRuntimeGardenComputeConfigPatch
): MutableRuntimeGardenComputeConfigPatch {
  const normalized: MutableRuntimeGardenComputeConfigPatch = {};
  if (parsedPatch.provider_kind !== undefined) normalized.provider_kind = parsedPatch.provider_kind;
  if (parsedPatch.provider_url !== undefined) normalized.provider_url = parsedPatch.provider_url;
  if (parsedPatch.model_id !== undefined) normalized.model_id = parsedPatch.model_id;
  if (parsedPatch.enabled !== undefined) normalized.enabled = parsedPatch.enabled;
  return normalized;
}

function normalizeSecretControlledPatch<TNormalized extends { secret_ref?: string | null }>(input: {
  readonly parsedPatch: SecretControlledPatchFields;
  readonly normalized: TNormalized;
  readonly invalidPatch: () => CoreError;
  readonly platform: NodeJS.Platform;
  readonly secretPath: string;
}): Readonly<{ readonly patch: TNormalized; readonly pastedSecret: PastedSecret | null }> {
  if (input.parsedPatch.secret_ref_mode === undefined) {
    return normalizeDirectSecretRef(input.parsedPatch, input.normalized, input.invalidPatch);
  }
  if (input.parsedPatch.secret_ref === null) {
    input.normalized.secret_ref = null;
    return { patch: input.normalized, pastedSecret: null };
  }
  const secretValue = requireSecretValue(input.parsedPatch.secret_value, input.invalidPatch);
  return normalizeSecretModeValue({
    secretMode: input.parsedPatch.secret_ref_mode,
    secretValue,
    normalized: input.normalized,
    invalidPatch: input.invalidPatch,
    platform: input.platform,
    secretPath: input.secretPath
  });
}

function normalizeDirectSecretRef<TNormalized extends { secret_ref?: string | null }>(
  parsedPatch: SecretControlledPatchFields,
  normalized: TNormalized,
  invalidPatch: () => CoreError
): Readonly<{ readonly patch: TNormalized; readonly pastedSecret: PastedSecret | null }> {
  if (parsedPatch.secret_value !== undefined) {
    throw invalidPatch();
  }
  if (parsedPatch.secret_ref !== undefined) {
    normalized.secret_ref = parsedPatch.secret_ref === null ? null : normalizeSecretRef(parsedPatch.secret_ref);
  }
  return { patch: normalized, pastedSecret: null };
}

function requireSecretValue(secretValue: string | null | undefined, invalidPatch: () => CoreError): string {
  if (typeof secretValue !== "string" || secretValue.trim().length === 0) {
    throw invalidPatch();
  }
  return secretValue;
}

function normalizeSecretModeValue<TNormalized extends { secret_ref?: string | null }>(input: {
  readonly secretMode: SecretRefMode;
  readonly secretValue: string;
  readonly normalized: TNormalized;
  readonly invalidPatch: () => CoreError;
  readonly platform: NodeJS.Platform;
  readonly secretPath: string;
}): Readonly<{ readonly patch: TNormalized; readonly pastedSecret: PastedSecret | null }> {
  if (input.secretMode === "env") {
    input.normalized.secret_ref = normalizeEnvSecretRef(input.secretValue, input.invalidPatch);
    return { patch: input.normalized, pastedSecret: null };
  }
  if (input.secretMode === "file") {
    input.normalized.secret_ref = normalizeFileSecretRef(input.secretValue, input.invalidPatch);
    return { patch: input.normalized, pastedSecret: null };
  }
  return normalizePastedSecretRef(input);
}

function normalizeEnvSecretRef(secretValue: string, invalidPatch: () => CoreError): string {
  const envName = secretValue.trim();
  if (!ENV_SECRET_REF_PATTERN.test(envName)) {
    throw invalidPatch();
  }
  return `env:${envName}`;
}

function normalizeFileSecretRef(secretValue: string, invalidPatch: () => CoreError): string {
  const filePath = secretValue.trim();
  if (!path.isAbsolute(filePath)) {
    throw invalidPatch();
  }
  return `file:${filePath}`;
}

function normalizePastedSecretRef<TNormalized extends { secret_ref?: string | null }>(input: {
  readonly secretValue: string;
  readonly normalized: TNormalized;
  readonly platform: NodeJS.Platform;
  readonly secretPath: string;
}): Readonly<{ readonly patch: TNormalized; readonly pastedSecret: PastedSecret }> {
  if (input.platform === "win32") {
    throw new CoreError("VALIDATION", "paste mode is not supported on win32");
  }
  input.normalized.secret_ref = `file:${input.secretPath}`;
  return {
    patch: input.normalized,
    pastedSecret: {
      path: input.secretPath,
      value: input.secretValue
    }
  };
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
  if (trimmed.startsWith("keychain:") && parseSecretRefKeychainTarget(trimmed) !== null) {
    return trimmed;
  }
  throw invalidRuntimeEmbeddingPatch();
}

function invalidRuntimeEmbeddingPatch(): CoreError {
  return new CoreError("VALIDATION", "Invalid runtime embedding config patch");
}

function invalidRuntimeGardenComputePatch(): CoreError {
  return new CoreError("VALIDATION", "Invalid runtime garden compute config patch");
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
