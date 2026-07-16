import {
  CoreError,
  resolveProductGardenProviderKind
} from "@do-soul/alaya-core";
import {
  DEFAULT_SOUL_CONFIG,
  GardenEventType,
  HealthEventKind,
  RuntimeGardenComputeConfigSchema,
  RuntimeEmbeddingConfigSchema,
  secretRefScheme,
  SoulHealthJournalRecordedPayloadSchema,
  type EventLogEntry,
  type RuntimeGardenComputeConfig,
  type RuntimeEmbeddingConfig
} from "@do-soul/alaya-protocol";
import { OFFICIAL_API_GARDEN_MODEL } from "@do-soul/alaya-soul";
import type { ConfigRepo } from "@do-soul/alaya-storage";
import {
  ALAYA_LEGACY_GARDEN_OPENAI_SECRET_REF_ENV,
  selectGardenCredentialProvenance,
  type GardenCredentialProvenance
} from "../garden/index.js";
import type { AlayaConfigPaths } from "../cli/config-files.js";
import {
  loadConfigEnv,
  readConfigEnvValue,
  readNonEmptyEnv
} from "../runtime/index.js";
import {
  ALAYA_GARDEN_PROVIDER_KIND_ENV,
  ALAYA_OFFICIAL_GARDEN_SECRET_REF_ENV,
  ALAYA_OPENAI_SECRET_REF_ENV,
  applyRuntimeGardenComputeConfigFiles,
  applyRuntimeEmbeddingConfigFiles,
  normalizeRuntimeEmbeddingConfigPatch,
  normalizeRuntimeGardenComputeConfigPatch,
  OFFICIAL_API_GARDEN_MODEL_ENV,
  OFFICIAL_API_GARDEN_PROVIDER_URL_ENV,
  type NormalizedRuntimeGardenComputeConfigPatch,
  type NormalizedRuntimeEmbeddingConfigPatch
} from "./env-file-service.js";

interface ConfigEventPublisher {
  appendManyWithMutation<T>(
    eventInputs: readonly Omit<EventLogEntry, "event_id" | "created_at" | "revision">[],
    mutate: (entries: readonly EventLogEntry[]) => T
  ): Promise<T>;
}

const RUNTIME_EMBEDDING_CONFIG_KEY = "runtime:embedding-supplement";
const RUNTIME_GARDEN_COMPUTE_CONFIG_KEY = "runtime:garden-compute";
const RUNTIME_EMBEDDING_ENTITY_TYPE = "runtime_config";
const RUNTIME_EMBEDDING_ENTITY_ID = "runtime:embedding-supplement";
const RUNTIME_GARDEN_COMPUTE_ENTITY_ID = "runtime:garden-compute";
const RUNTIME_CONFIG_WORKSPACE_ID = "runtime";
const RUNTIME_EMBEDDING_CONFIG_FIELDS = [
  "provider_url",
  "secret_ref",
  "model_id",
  "embedding_enabled"
] as const;
const RUNTIME_GARDEN_COMPUTE_CONFIG_FIELDS = [
  "provider_kind",
  "provider_url",
  "secret_ref",
  "model_id",
  "enabled"
] as const;
const CURRENT_CONFIG_VERSION = DEFAULT_SOUL_CONFIG.config_version ?? 1;

const DEFAULT_RUNTIME_EMBEDDING_CONFIG: RuntimeEmbeddingConfig = {
  config_version: CURRENT_CONFIG_VERSION,
  provider_url: null,
  secret_ref: null,
  model_id: null,
  embedding_enabled: true
};

type VersionedRuntimeConfig = Record<string, unknown> & {
  readonly config_version?: number;
};

export async function getRuntimeEmbeddingConfig(repo: ConfigRepo): Promise<RuntimeEmbeddingConfig> {
  const version = readConfigVersion(DEFAULT_RUNTIME_EMBEDDING_CONFIG);
  return repo.getParsed(RUNTIME_EMBEDDING_CONFIG_KEY, {
    parse: (value) => RuntimeEmbeddingConfigSchema.parse(normalizeLegacyConfigVersion(value, version))
  }) ?? DEFAULT_RUNTIME_EMBEDDING_CONFIG;
}

export async function getRuntimeGardenComputeConfig(
  repo: ConfigRepo,
  paths: AlayaConfigPaths,
  warn: (message: string) => void
): Promise<RuntimeGardenComputeConfig> {
  const persisted = repo.getParsed(RUNTIME_GARDEN_COMPUTE_CONFIG_KEY, {
    parse: (value) => parseGardenComputeConfigWithLegacyFallback(value, "garden-compute config", warn)
  });
  const raw = persisted ?? (await defaultRuntimeGardenComputeConfig(paths, warn));
  return parseGardenComputeConfigWithLegacyFallback(raw, "garden-compute config", warn);
}

export async function patchRuntimeEmbeddingConfig(input: Readonly<{
  readonly repo: ConfigRepo;
  readonly eventPublisher: ConfigEventPublisher;
  readonly paths: AlayaConfigPaths;
  readonly patch: unknown;
  readonly clock: () => string;
  readonly platform: NodeJS.Platform;
  readonly generateTempId: () => string;
  readonly generateAuditId: () => string;
}>): Promise<RuntimeEmbeddingConfig> {
  const normalized = normalizeRuntimeEmbeddingConfigPatch(input.patch, input.paths, input.platform);
  const audit = createRuntimeConfigAudit(input.clock, input.generateAuditId, "Invalid runtime embedding config patch");
  return await applyRuntimeEmbeddingConfigFiles({
    paths: input.paths,
    normalized,
    generateTempId: input.generateTempId,
    persist: async () =>
      await appendRuntimeEmbeddingConfigMutation(input.repo, input.eventPublisher, normalized, audit)
  });
}

export async function patchRuntimeGardenComputeConfig(input: Readonly<{
  readonly repo: ConfigRepo;
  readonly eventPublisher: ConfigEventPublisher;
  readonly paths: AlayaConfigPaths;
  readonly patch: unknown;
  readonly clock: () => string;
  readonly platform: NodeJS.Platform;
  readonly generateTempId: () => string;
  readonly generateAuditId: () => string;
  readonly warn: (message: string) => void;
}>): Promise<RuntimeGardenComputeConfig> {
  const normalized = normalizeRuntimeGardenComputeConfigPatch(input.patch, input.paths, input.platform);
  const audit = createRuntimeConfigAudit(
    input.clock,
    input.generateAuditId,
    "Invalid runtime garden compute config patch"
  );
  const defaults = await defaultRuntimeGardenComputeConfig(input.paths, input.warn);

  return await applyRuntimeGardenComputeConfigFiles({
    paths: input.paths,
    normalized,
    generateTempId: input.generateTempId,
    persist: async () =>
      await appendRuntimeGardenComputeConfigMutation(
        input.repo,
        input.eventPublisher,
        normalized,
        audit,
        defaults,
        input.warn
      )
  });
}

export async function getGardenCredentialProvenance(input: Readonly<{
  readonly paths: AlayaConfigPaths;
  readonly env: NodeJS.ProcessEnv;
}>): Promise<GardenCredentialProvenance> {
  const configEnv = await loadConfigEnv(input.paths.envPath);
  return selectGardenCredentialProvenance({
    env: input.env,
    configEnv
  });
}

function buildRuntimeEmbeddingChangeSummary(normalized: NormalizedRuntimeEmbeddingConfigPatch) {
  const fieldsChanged = RUNTIME_EMBEDDING_CONFIG_FIELDS.filter(
    (field) => normalized.patch[field] !== undefined
  );
  return {
    fields_changed: fieldsChanged,
    ...(normalized.patch.secret_ref !== undefined
      ? {
          secret_ref_kind:
            normalized.patch.secret_ref === null
              ? null
              : secretRefScheme(normalized.patch.secret_ref)
        }
      : {})
  };
}

function buildRuntimeGardenComputeChangeSummary(normalized: NormalizedRuntimeGardenComputeConfigPatch) {
  const fieldsChanged = RUNTIME_GARDEN_COMPUTE_CONFIG_FIELDS.filter(
    (field) => normalized.patch[field] !== undefined
  );
  return {
    fields_changed: fieldsChanged,
    ...(normalized.patch.secret_ref !== undefined
      ? {
          secret_ref_kind:
            normalized.patch.secret_ref === null
              ? null
              : secretRefScheme(normalized.patch.secret_ref)
        }
      : {}),
    ...(normalized.patch.provider_url !== undefined
      ? { provider_url: normalized.patch.provider_url }
      : {}),
    ...(normalized.patch.model_id !== undefined ? { model_id: normalized.patch.model_id } : {})
  };
}

function createRuntimeConfigAudit(
  clock: () => string,
  generateAuditId: () => string,
  validationMessage: string
): Readonly<{ occurredAt: string; auditEntryId: string }> {
  return {
    occurredAt: parseIsoTimestamp(clock(), validationMessage),
    auditEntryId: generateAuditId()
  };
}

async function appendRuntimeEmbeddingConfigMutation(
  repo: ConfigRepo,
  eventPublisher: ConfigEventPublisher,
  normalized: NormalizedRuntimeEmbeddingConfigPatch,
  audit: Readonly<{ occurredAt: string; auditEntryId: string }>
): Promise<RuntimeEmbeddingConfig> {
  return await eventPublisher.appendManyWithMutation(
    [buildRuntimeEmbeddingConfigAuditEvent(normalized, audit)],
    () => patchStoredRuntimeEmbeddingConfig(repo, normalized)
  );
}

function buildRuntimeEmbeddingConfigAuditEvent(
  normalized: NormalizedRuntimeEmbeddingConfigPatch,
  audit: Readonly<{ occurredAt: string; auditEntryId: string }>
): Omit<EventLogEntry, "event_id" | "created_at" | "revision"> {
  return {
    event_type: GardenEventType.SOUL_HEALTH_JOURNAL_RECORDED,
    entity_type: RUNTIME_EMBEDDING_ENTITY_TYPE,
    entity_id: RUNTIME_EMBEDDING_ENTITY_ID,
    workspace_id: RUNTIME_CONFIG_WORKSPACE_ID,
    run_id: null,
    caused_by: "inspector",
    payload_json: SoulHealthJournalRecordedPayloadSchema.parse({
      entry_id: audit.auditEntryId,
      event_kind: HealthEventKind.EMBEDDING_SUPPLEMENT,
      workspace_id: RUNTIME_CONFIG_WORKSPACE_ID,
      occurred_at: audit.occurredAt,
      change_summary: buildRuntimeEmbeddingChangeSummary(normalized)
    })
  };
}

function patchStoredRuntimeEmbeddingConfig(
  repo: ConfigRepo,
  normalized: NormalizedRuntimeEmbeddingConfigPatch
): RuntimeEmbeddingConfig {
  return repo.patchParsed(
    RUNTIME_EMBEDDING_CONFIG_KEY,
    withConfigVersion(normalized.patch, readConfigVersion(DEFAULT_RUNTIME_EMBEDDING_CONFIG)),
    DEFAULT_RUNTIME_EMBEDDING_CONFIG,
    {
      parse: (value) =>
        RuntimeEmbeddingConfigSchema.parse(
          normalizeLegacyConfigVersion(value, readConfigVersion(DEFAULT_RUNTIME_EMBEDDING_CONFIG))
        )
    }
  );
}

async function appendRuntimeGardenComputeConfigMutation(
  repo: ConfigRepo,
  eventPublisher: ConfigEventPublisher,
  normalized: NormalizedRuntimeGardenComputeConfigPatch,
  audit: Readonly<{ occurredAt: string; auditEntryId: string }>,
  defaults: RuntimeGardenComputeConfig,
  warn: (message: string) => void
): Promise<RuntimeGardenComputeConfig> {
  return await eventPublisher.appendManyWithMutation(
    [buildRuntimeGardenComputeConfigAuditEvent(normalized, audit)],
    () => patchStoredRuntimeGardenComputeConfig(repo, normalized, defaults, warn)
  );
}

function buildRuntimeGardenComputeConfigAuditEvent(
  normalized: NormalizedRuntimeGardenComputeConfigPatch,
  audit: Readonly<{ occurredAt: string; auditEntryId: string }>
): Omit<EventLogEntry, "event_id" | "created_at" | "revision"> {
  return {
    event_type: GardenEventType.SOUL_HEALTH_JOURNAL_RECORDED,
    entity_type: RUNTIME_EMBEDDING_ENTITY_TYPE,
    entity_id: RUNTIME_GARDEN_COMPUTE_ENTITY_ID,
    workspace_id: RUNTIME_CONFIG_WORKSPACE_ID,
    run_id: null,
    caused_by: "inspector",
    payload_json: SoulHealthJournalRecordedPayloadSchema.parse({
      entry_id: audit.auditEntryId,
      event_kind: HealthEventKind.EMBEDDING_SUPPLEMENT,
      workspace_id: RUNTIME_CONFIG_WORKSPACE_ID,
      occurred_at: audit.occurredAt,
      change_summary: buildRuntimeGardenComputeChangeSummary(normalized)
    })
  };
}

function patchStoredRuntimeGardenComputeConfig(
  repo: ConfigRepo,
  normalized: NormalizedRuntimeGardenComputeConfigPatch,
  defaults: RuntimeGardenComputeConfig,
  warn: (message: string) => void
): RuntimeGardenComputeConfig {
  return repo.patchParsed(
    RUNTIME_GARDEN_COMPUTE_CONFIG_KEY,
    withConfigVersion(normalized.patch, readConfigVersion(defaults)),
    defaults,
    {
      parse: (value) =>
        parseGardenComputeConfigWithLegacyFallback(value, "garden-compute config patch", warn)
    }
  );
}

function parseGardenComputeConfigWithLegacyFallback(
  input: unknown,
  source: string,
  warn: (message: string) => void
): RuntimeGardenComputeConfig {
  const normalizedInput = normalizeLegacyConfigVersion(input, CURRENT_CONFIG_VERSION);
  const direct = RuntimeGardenComputeConfigSchema.safeParse(normalizedInput);
  if (direct.success) {
    return direct.data;
  }
  const issues = direct.error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
  warn(
    `${source}: rejected by schema (${issues}); dropping secret_ref and falling back to local_heuristics. ` +
      "Re-run `alaya install --keychain` (or fix the offending env/SQL value) to restore Garden compute."
  );
  const fallbackBase = isRecord(normalizedInput) ? normalizedInput : {};
  return RuntimeGardenComputeConfigSchema.parse({
    ...fallbackBase,
    config_version: CURRENT_CONFIG_VERSION,
    secret_ref: null,
    enabled: false,
    provider_kind: "local_heuristics"
  });
}

async function defaultRuntimeGardenComputeConfig(
  paths: AlayaConfigPaths,
  warn: (message: string) => void
): Promise<RuntimeGardenComputeConfig> {
  const configEnv = await loadConfigEnv(paths.envPath);
  const gardenSecretRef =
    readRawSecretRef(configEnv, ALAYA_OFFICIAL_GARDEN_SECRET_REF_ENV) ??
    readRawSecretRef(configEnv, ALAYA_LEGACY_GARDEN_OPENAI_SECRET_REF_ENV);
  const embeddingFallbackSecretRef = readRawSecretRef(configEnv, ALAYA_OPENAI_SECRET_REF_ENV);
  const secretRef = gardenSecretRef ?? embeddingFallbackSecretRef;
  const modelId =
    readNonEmptyEnv(readConfigEnvValue(configEnv, OFFICIAL_API_GARDEN_MODEL_ENV)) ??
    OFFICIAL_API_GARDEN_MODEL;
  const providerKind = resolveProductGardenProviderKind(
    readNonEmptyEnv(readConfigEnvValue(configEnv, ALAYA_GARDEN_PROVIDER_KIND_ENV)),
    secretRef !== null
  );

  return parseGardenComputeConfigWithLegacyFallback(
    {
      config_version: CURRENT_CONFIG_VERSION,
      provider_kind: providerKind,
      model_id: modelId,
      provider_url: readNonEmptyEnv(readConfigEnvValue(configEnv, OFFICIAL_API_GARDEN_PROVIDER_URL_ENV)),
      secret_ref: secretRef,
      enabled: providerKind === "official_api" && secretRef !== null
    },
    "garden-compute env defaults",
    warn
  );
}

function readRawSecretRef(configEnv: ReadonlyMap<string, string>, key: string): string | null {
  return readNonEmptyEnv(readConfigEnvValue(configEnv, key));
}

function parseIsoTimestamp(
  value: string,
  validationMessage = "Invalid runtime embedding config patch"
): string {
  if (Number.isNaN(Date.parse(value))) {
    throw new CoreError("VALIDATION", validationMessage);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readConfigVersion(defaults: VersionedRuntimeConfig): number {
  return defaults.config_version ?? CURRENT_CONFIG_VERSION;
}

function normalizeLegacyConfigVersion(value: unknown, configVersion: number): unknown {
  if (!isRecord(value) || value.config_version !== undefined) {
    return value;
  }
  return {
    ...value,
    config_version: configVersion
  };
}

function withConfigVersion<T extends VersionedRuntimeConfig>(
  patch: Partial<T>,
  configVersion: number
): Partial<T> {
  return {
    ...patch,
    config_version: configVersion
  };
}
