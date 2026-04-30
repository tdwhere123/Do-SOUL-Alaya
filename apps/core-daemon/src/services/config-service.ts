import { CoreError } from "@do-soul/alaya-core";
import {
  DEFAULT_ENVIRONMENT_CONFIG,
  DEFAULT_SOUL_CONFIG,
  DEFAULT_STRATEGY_CONFIG,
  EnvironmentConfigSchema,
  SoulConfigSchema,
  StrategyConfigSchema,
  type EnvironmentConfig,
  type SoulConfig,
  type StrategyConfig
} from "@do-soul/alaya-protocol";
import type { ConfigRepo } from "@do-soul/alaya-storage";

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

const SoulConfigPatchSchema = SoulConfigSchema.unwrap().partial();
const StrategyConfigPatchSchema = StrategyConfigSchema.unwrap().partial();
const EnvironmentConfigPatchSchema = EnvironmentConfigSchema.unwrap().partial();

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
}): AppConfigService {
  const { configRepo } = dependencies;

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
      await patchRuntimeEmbeddingConfig(configRepo, patch)
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
    (await repo.get<RuntimeEmbeddingConfig>("runtime:embedding-supplement")) ??
      DEFAULT_RUNTIME_EMBEDDING_CONFIG
  );
}

async function patchRuntimeEmbeddingConfig(
  repo: ConfigRepo,
  patch: unknown
): Promise<RuntimeEmbeddingConfig> {
  const parsedPatch = parseRuntimeEmbeddingConfigPatch(patch);
  const next = await repo.patch(
    "runtime:embedding-supplement",
    parsedPatch,
    DEFAULT_RUNTIME_EMBEDDING_CONFIG
  );
  return parseRuntimeEmbeddingConfig(next);
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

function parseRuntimeEmbeddingConfigPatch(patch: unknown): Partial<RuntimeEmbeddingConfig> {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    throw new CoreError("VALIDATION", "Invalid runtime embedding config patch");
  }

  const allowedKeys = new Set(["provider_url", "secret_ref", "model_id", "embedding_enabled"]);
  const record = patch as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new CoreError("VALIDATION", `Unknown runtime embedding config field: ${key}`);
    }
  }

  const parsed: Partial<RuntimeEmbeddingConfig> = {};
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

function parseBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new CoreError("VALIDATION", `${field} must be a boolean`);
  }
  return value;
}
