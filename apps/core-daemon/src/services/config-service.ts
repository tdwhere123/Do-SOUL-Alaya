import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { CoreError } from "@do-soul/alaya-core";
import {
  DEFAULT_ENVIRONMENT_CONFIG,
  DEFAULT_SOUL_CONFIG,
  DEFAULT_STRATEGY_CONFIG,
  EnvironmentConfigSchema,
  HealthEventKind,
  Phase4AEventType,
  SoulConfigSchema,
  SoulHealthJournalRecordedPayloadSchema,
  StrategyConfigSchema,
  type EventLogEntry,
  type EnvironmentConfig,
  type SoulConfig,
  type StrategyConfig
} from "@do-soul/alaya-protocol";
import type { ConfigRepo } from "@do-soul/alaya-storage";
import type { AlayaConfigPaths } from "../cli/config-files.js";

export interface AppConfigService {
  getSoulConfig(workspaceId: string): Promise<SoulConfig>;
  patchSoulConfig(workspaceId: string, patch: unknown): Promise<SoulConfig>;
  getStrategyConfig(workspaceId: string): Promise<StrategyConfig>;
  patchStrategyConfig(workspaceId: string, patch: unknown): Promise<StrategyConfig>;
  getEnvironmentConfig(workspaceId: string): Promise<EnvironmentConfig>;
  patchEnvironmentConfig(workspaceId: string, patch: unknown): Promise<EnvironmentConfig>;
  getRuntimeEmbeddingConfig(): Promise<RuntimeEmbeddingConfig>;
  patchRuntimeEmbeddingConfig(patch: unknown): Promise<RuntimeEmbeddingConfig>;
}

interface ConfigEventPublisher {
  publishWithMutation<T>(
    eventInput: Omit<EventLogEntry, "event_id" | "created_at">,
    mutate: (entry: EventLogEntry) => Promise<T>
  ): Promise<T>;
}

const SoulConfigPatchSchema = SoulConfigSchema.unwrap().partial();
const StrategyConfigPatchSchema = StrategyConfigSchema.unwrap().partial();
const EnvironmentConfigPatchSchema = EnvironmentConfigSchema.unwrap().partial();
const RUNTIME_EMBEDDING_CONFIG_KEY = "runtime:embedding-supplement";
const RUNTIME_EMBEDDING_ENTITY_TYPE = "runtime_config";
const RUNTIME_EMBEDDING_ENTITY_ID = "runtime:embedding-supplement";
const RUNTIME_CONFIG_WORKSPACE_ID = "runtime";
const DEFAULT_REVISION = 0;
const ENV_SECRET_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RUNTIME_EMBEDDING_CONFIG_FIELDS = [
  "provider_url",
  "secret_ref",
  "model_id",
  "embedding_enabled"
] as const;

export type RuntimeEmbeddingConfig = {
  provider_url: string | null;
  secret_ref: string | null;
  model_id: string | null;
  embedding_enabled: boolean;
};

const DEFAULT_RUNTIME_EMBEDDING_CONFIG: RuntimeEmbeddingConfig = {
  provider_url: null,
  secret_ref: null,
  model_id: null,
  embedding_enabled: false
};

export function createConfigService(dependencies: {
  readonly configRepo: ConfigRepo;
  readonly eventPublisher: ConfigEventPublisher;
  readonly configPathsProvider: () => AlayaConfigPaths;
  readonly clock?: () => string;
  readonly platform?: NodeJS.Platform;
  readonly generateTempId?: () => string;
  readonly generateAuditId?: () => string;
}): AppConfigService {
  const {
    configRepo,
    eventPublisher,
    configPathsProvider,
    clock = () => new Date().toISOString(),
    platform = process.platform,
    generateTempId = () => randomUUID(),
    generateAuditId = () => randomUUID()
  } = dependencies;

  return {
    getSoulConfig: async (workspaceId) =>
      await getSectionConfig(configRepo, keyFor(workspaceId, "soul"), SoulConfigSchema, DEFAULT_SOUL_CONFIG),
    patchSoulConfig: async (workspaceId, patch) =>
      await patchSectionConfig(
        configRepo,
        keyFor(workspaceId, "soul"),
        SoulConfigSchema,
        SoulConfigPatchSchema,
        DEFAULT_SOUL_CONFIG,
        patch,
        "Invalid soul config patch"
      ),
    getStrategyConfig: async (workspaceId) =>
      await getSectionConfig(configRepo, keyFor(workspaceId, "strategy"), StrategyConfigSchema, DEFAULT_STRATEGY_CONFIG),
    patchStrategyConfig: async (workspaceId, patch) =>
      await patchSectionConfig(
        configRepo,
        keyFor(workspaceId, "strategy"),
        StrategyConfigSchema,
        StrategyConfigPatchSchema,
        DEFAULT_STRATEGY_CONFIG,
        patch,
        "Invalid strategy config patch"
      ),
    getEnvironmentConfig: async (workspaceId) =>
      await getSectionConfig(
        configRepo,
        keyFor(workspaceId, "environment"),
        EnvironmentConfigSchema,
        DEFAULT_ENVIRONMENT_CONFIG
      ),
    patchEnvironmentConfig: async (workspaceId, patch) =>
      await patchSectionConfig(
        configRepo,
        keyFor(workspaceId, "environment"),
        EnvironmentConfigSchema,
        EnvironmentConfigPatchSchema,
        DEFAULT_ENVIRONMENT_CONFIG,
        patch,
        "Invalid environment config patch"
      ),
    getRuntimeEmbeddingConfig: async () =>
      await getRuntimeEmbeddingConfig(configRepo),
    patchRuntimeEmbeddingConfig: async (patch) =>
      await patchRuntimeEmbeddingConfig({
        repo: configRepo,
        eventPublisher,
        paths: configPathsProvider(),
        patch,
        clock,
        platform,
        generateTempId,
        generateAuditId
      })
  };
}

function keyFor(workspaceId: string, section: "soul" | "strategy" | "environment"): string {
  return `workspace:${workspaceId}:${section}`;
}

async function getSectionConfig<T>(
  repo: ConfigRepo,
  key: string,
  schema: { parse(value: unknown): T },
  defaults: T
): Promise<T> {
  const raw = await repo.get<T>(key);
  return schema.parse(raw ?? defaults);
}

async function patchSectionConfig<T extends Record<string, unknown>>(
  repo: ConfigRepo,
  key: string,
  fullSchema: { parse(value: unknown): T },
  patchSchema: { safeParse(value: unknown): { success: true; data: Partial<T> } | { success: false; error: unknown } },
  defaults: T,
  patch: unknown,
  validationMessage: string
): Promise<T> {
  const parsedPatch = patchSchema.safeParse(patch);

  if (!parsedPatch.success) {
    throw new CoreError("VALIDATION", validationMessage, { cause: parsedPatch.error });
  }

  const next = await repo.patch(key, parsedPatch.data, defaults);
  return fullSchema.parse(next);
}

async function getRuntimeEmbeddingConfig(repo: ConfigRepo): Promise<RuntimeEmbeddingConfig> {
  return parseRuntimeEmbeddingConfig(
    (await repo.get<RuntimeEmbeddingConfig>(RUNTIME_EMBEDDING_CONFIG_KEY)) ??
      DEFAULT_RUNTIME_EMBEDDING_CONFIG
  );
}

async function patchRuntimeEmbeddingConfig(input: {
  readonly repo: ConfigRepo;
  readonly eventPublisher: ConfigEventPublisher;
  readonly paths: AlayaConfigPaths;
  readonly patch: unknown;
  readonly clock: () => string;
  readonly platform: NodeJS.Platform;
  readonly generateTempId: () => string;
  readonly generateAuditId: () => string;
}): Promise<RuntimeEmbeddingConfig> {
  const normalized = normalizeRuntimeEmbeddingConfigPatch(input.patch, input.paths, input.platform);
  const occurredAt = parseIsoTimestamp(input.clock());
  const auditEntryId = input.generateAuditId();

  return await input.eventPublisher.publishWithMutation(
    {
      event_type: Phase4AEventType.SOUL_HEALTH_JOURNAL_RECORDED,
      entity_type: RUNTIME_EMBEDDING_ENTITY_TYPE,
      entity_id: RUNTIME_EMBEDDING_ENTITY_ID,
      workspace_id: RUNTIME_CONFIG_WORKSPACE_ID,
      run_id: null,
      caused_by: "inspector",
      revision: DEFAULT_REVISION,
      payload_json: SoulHealthJournalRecordedPayloadSchema.parse({
        entry_id: auditEntryId,
        event_kind: HealthEventKind.EMBEDDING_SUPPLEMENT,
        workspace_id: RUNTIME_CONFIG_WORKSPACE_ID,
        occurred_at: occurredAt,
        change_summary: buildRuntimeEmbeddingChangeSummary(normalized.patch)
      })
    },
    async () => {
      const previousEnv = await readOptional(input.paths.envPath);
      const previousSecret =
        normalized.pastedSecret === null ? null : await readOptional(normalized.pastedSecret.path);
      if (normalized.pastedSecret !== null) {
        await ensurePrivateDirectory(input.paths.secretsDir);
      }
      try {
        if (normalized.pastedSecret !== null) {
          await writeTextAtomic(
            normalized.pastedSecret.path,
            `${trimTrailingLineBreaks(normalized.pastedSecret.value)}\n`,
            0o600,
            input.generateTempId
          );
        }

        await patchRuntimeEmbeddingEnvFile(input.paths, normalized.patch, input.generateTempId);
        const next = await input.repo.patch(
          RUNTIME_EMBEDDING_CONFIG_KEY,
          normalized.patch,
          DEFAULT_RUNTIME_EMBEDDING_CONFIG
        );
        return parseRuntimeEmbeddingConfig(next);
      } catch (error) {
        await restoreRuntimeEmbeddingFiles(input.paths, previousEnv, normalized.pastedSecret, previousSecret, input.generateTempId);
        throw error;
      }
    }
  );
}

function buildRuntimeEmbeddingChangeSummary(patch: Partial<RuntimeEmbeddingConfig>): {
  readonly fields_changed: readonly string[];
  readonly secret_ref_kind?: "env" | "file" | null;
} {
  const fieldsChanged = RUNTIME_EMBEDDING_CONFIG_FIELDS.filter((field) => patch[field] !== undefined);
  return {
    fields_changed: fieldsChanged,
    ...(patch.secret_ref !== undefined ? { secret_ref_kind: secretRefKind(patch.secret_ref) } : {})
  };
}

function secretRefKind(secretRef: string | null): "env" | "file" | null {
  if (secretRef === null) {
    return null;
  }
  return secretRef.startsWith("env:") ? "env" : "file";
}

function parseRuntimeEmbeddingConfig(value: unknown): RuntimeEmbeddingConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CoreError("VALIDATION", "Invalid runtime embedding config");
  }

  const record = value as Record<string, unknown>;
  return {
    provider_url: parseNullableNonEmptyString(record.provider_url, "provider_url"),
    secret_ref: parseNullableNonEmptyString(record.secret_ref, "secret_ref"),
    model_id: parseNullableNonEmptyString(record.model_id, "model_id"),
    embedding_enabled: parseBoolean(record.embedding_enabled, "embedding_enabled")
  };
}

type SecretRefMode = "env" | "file" | "paste";

type RawRuntimeEmbeddingConfigPatch = Partial<RuntimeEmbeddingConfig> & {
  secret_ref_mode?: SecretRefMode;
  secret_value?: string | null;
};

type NormalizedRuntimeEmbeddingConfigPatch = Readonly<{
  readonly patch: Partial<RuntimeEmbeddingConfig>;
  readonly pastedSecret: Readonly<{ readonly path: string; readonly value: string }> | null;
}>;

function normalizeRuntimeEmbeddingConfigPatch(
  patch: unknown,
  paths: AlayaConfigPaths,
  platform: NodeJS.Platform
): NormalizedRuntimeEmbeddingConfigPatch {
  const parsedPatch = parseRuntimeEmbeddingConfigPatch(patch);
  const normalized: Partial<RuntimeEmbeddingConfig> = {};

  if (parsedPatch.provider_url !== undefined) normalized.provider_url = parsedPatch.provider_url;
  if (parsedPatch.model_id !== undefined) normalized.model_id = parsedPatch.model_id;
  if (parsedPatch.embedding_enabled !== undefined) normalized.embedding_enabled = parsedPatch.embedding_enabled;

  if (parsedPatch.secret_ref_mode === undefined) {
    if (parsedPatch.secret_value !== undefined) {
      throw new CoreError("VALIDATION", "Invalid runtime embedding config patch");
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
    throw new CoreError("VALIDATION", "Invalid runtime embedding config patch");
  }

  if (parsedPatch.secret_ref_mode === "env") {
    const envName = secretValue.trim();
    if (!ENV_SECRET_REF_PATTERN.test(envName)) {
      throw new CoreError("VALIDATION", "Invalid runtime embedding config patch");
    }
    normalized.secret_ref = `env:${envName}`;
    return { patch: normalized, pastedSecret: null };
  }

  if (parsedPatch.secret_ref_mode === "file") {
    const filePath = secretValue.trim();
    if (!path.isAbsolute(filePath)) {
      throw new CoreError("VALIDATION", "Invalid runtime embedding config patch");
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

function parseRuntimeEmbeddingConfigPatch(patch: unknown): RawRuntimeEmbeddingConfigPatch {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    throw new CoreError("VALIDATION", "Invalid runtime embedding config patch");
  }

  const allowedKeys = new Set([
    "provider_url",
    "secret_ref",
    "model_id",
    "embedding_enabled",
    "secret_ref_mode",
    "secret_value"
  ]);
  const record = patch as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new CoreError("VALIDATION", `Unknown runtime embedding config field: ${key}`);
    }
  }

  const parsed: RawRuntimeEmbeddingConfigPatch = {};
  if ("provider_url" in record) {
    parsed.provider_url = parseNullableNonEmptyString(record.provider_url, "provider_url");
  }
  if ("secret_ref" in record) {
    parsed.secret_ref = parseNullableNonEmptyString(record.secret_ref, "secret_ref");
  }
  if ("model_id" in record) {
    parsed.model_id = parseNullableNonEmptyString(record.model_id, "model_id");
  }
  if ("embedding_enabled" in record) {
    parsed.embedding_enabled = parseBoolean(record.embedding_enabled, "embedding_enabled");
  }
  if ("secret_ref_mode" in record) {
    parsed.secret_ref_mode = parseSecretRefMode(record.secret_ref_mode);
  }
  if ("secret_value" in record) {
    parsed.secret_value = parseNullableRawString(record.secret_value, "secret_value");
  }

  return parsed;
}

function parseNullableNonEmptyString(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CoreError("VALIDATION", `${field} must be a non-empty string or null`);
  }
  return value.trim();
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

function parseBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new CoreError("VALIDATION", `${field} must be a boolean`);
  }
  return value;
}

function parseSecretRefMode(value: unknown): SecretRefMode {
  if (value === "env" || value === "file" || value === "paste") {
    return value;
  }
  throw new CoreError("VALIDATION", "Invalid runtime embedding config patch");
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
  throw new CoreError("VALIDATION", "Invalid runtime embedding config patch");
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
      next.delete("OPENAI_API_KEY");
    } else {
      next.set("OPENAI_API_KEY", patch.secret_ref);
    }
  }
  if (patch.model_id !== undefined) {
    setOrDelete(next, "OPENAI_EMBEDDING_MODEL", patch.model_id);
  }
  if (patch.provider_url !== undefined) {
    setOrDelete(next, "OPENAI_EMBEDDING_PROVIDER_URL", patch.provider_url);
  }

  await writeTextAtomic(paths.envPath, renderEnv(next), 0o600, generateTempId);
}

function parseEnv(content: string | null): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of (content ?? "").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    entries.set(trimmed.slice(0, separator), trimmed.slice(separator + 1));
  }
  return entries;
}

function renderEnv(entries: ReadonlyMap<string, string>): string {
  return `${Array.from(entries.entries()).map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
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

  await writeTextAtomic(filePath, previousContent, mode, generateTempId);
}

async function ensurePrivateDirectory(directoryPath: string): Promise<void> {
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  await chmod(directoryPath, 0o700);
}

function setOrDelete(map: Map<string, string>, key: string, value: string | null): void {
  if (value === null) {
    map.delete(key);
  } else {
    map.set(key, value);
  }
}

const pathWriteLocks = new Map<string, Promise<unknown>>();

async function writeTextAtomic(
  filePath: string,
  content: string,
  mode: number,
  generateTempId: () => string
): Promise<void> {
  await withPathWriteLock(filePath, async () => {
    await ensurePrivateDirectory(path.dirname(filePath));
    const tempPath = `${filePath}.${generateTempId()}.tmp`;
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    const handle = await open(
      tempPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow,
      mode
    );
    let closed = false;
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      closed = true;
      await rename(tempPath, filePath);
      await chmod(filePath, mode);
      await syncDirectory(path.dirname(filePath));
    } catch (error) {
      if (!closed) {
        await handle.close().catch(() => undefined);
      }
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  });
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

async function syncDirectory(directoryPath: string): Promise<void> {
  try {
    const handle = await open(directoryPath, fsConstants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Some filesystems do not support fsync on directories; the file write
    // remains exclusive and atomic even when the directory sync is unavailable.
  }
}

function trimTrailingLineBreaks(value: string): string {
  return value.replace(/[\r\n]+$/u, "");
}

function parseIsoTimestamp(value: string): string {
  if (Number.isNaN(Date.parse(value))) {
    throw new CoreError("VALIDATION", "Invalid runtime embedding config patch");
  }
  return value;
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
