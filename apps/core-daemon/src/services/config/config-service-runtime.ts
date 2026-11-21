import {
  CoreError,
  resolveProductGardenProviderKind
} from "@do-soul/alaya-core";
import {
  DEFAULT_SOUL_CONFIG,
  GardenEventType,
  HealthEventKind,
  RuntimeGardenComputeConfigSchema,
  RuntimeGardenProviderKindSchema,
  RuntimeEmbeddingConfigSchema,
  secretRefScheme,
  SoulHealthJournalRecordedPayloadSchema,
  type EventLogEntry,
  type RuntimeGardenComputeConfig,
  type RuntimeEmbeddingConfig
} from "@do-soul/alaya-protocol";
import { OFFICIAL_API_GARDEN_MODEL } from "@do-soul/alaya-soul";
import type { ConfigRepo } from "@do-soul/alaya-storage";
import { selectGardenSecretRef } from "../../garden/support/credential.js";
import type { GardenCredentialProvenance } from "../../garden/support/credential.js";
import type { AlayaConfigPaths } from "../../cli/support/config-files.js";
import { resolveEffectiveEmbeddingPosture } from "../../ai/daemon-embedding-runtime-config.js";
import { DAEMON_ONLY_CONFIG_ENV_KEYS, processEnvLookup } from "../../runtime/config/daemon-config-environment.js";
import { normalizeLegacyConfigVersion, withConfigVersion } from "./config-version.js";
import { loadConfigEnv, readNonEmptyEnv } from "../../runtime/daemon/lifecycle/daemon-runtime-support.js";
import {
  ALAYA_GARDEN_PROVIDER_KIND_ENV,
  ALAYA_OFFICIAL_GARDEN_SECRET_REF_ENV,
  applyRuntimeGardenComputeConfigFiles,
  applyRuntimeEmbeddingConfigFiles,
  normalizeRuntimeEmbeddingConfigPatch,
  normalizeRuntimeGardenComputeConfigPatch,
  OFFICIAL_API_GARDEN_MODEL_ENV,
  OFFICIAL_API_GARDEN_PROVIDER_URL_ENV,
  type NormalizedRuntimeGardenComputeConfigPatch,
  type NormalizedRuntimeEmbeddingConfigPatch
} from "../env-file/env-file-service.js";

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

export async function getRuntimeEmbeddingConfig(
  repo: ConfigRepo,
  paths: AlayaConfigPaths,
  env: NodeJS.ProcessEnv = processEnvLookup()
): Promise<RuntimeEmbeddingConfig> {
  const version = readConfigVersion(DEFAULT_RUNTIME_EMBEDDING_CONFIG);
  const persisted = repo.getParsed(RUNTIME_EMBEDDING_CONFIG_KEY, {
    parse: (value) => RuntimeEmbeddingConfigSchema.parse(normalizeLegacyConfigVersion(value, version))
  });
  const configEnv = await loadConfigEnv(paths.envPath);
  const keys = DAEMON_ONLY_CONFIG_ENV_KEYS.embedding;
  const read = (key: string) => env[key] ?? configEnv.get(key);
  const posture = resolveEffectiveEmbeddingPosture(read);
  return RuntimeEmbeddingConfigSchema.parse({
    config_version: persisted?.config_version ?? version,
    provider_url: readNonEmptyEnv(read(keys.openaiProviderUrl)),
    secret_ref: readNonEmptyEnv(read(keys.openaiSecretRef)),
    model_id: readNonEmptyEnv(read(keys.openaiModel)),
    embedding_enabled: posture.embeddingSupplementEnabled
  });
}

export async function getRuntimeGardenComputeConfig(
  repo: ConfigRepo,
  paths: AlayaConfigPaths,
  warn: (message: string) => void,
  env: NodeJS.ProcessEnv = processEnvLookup()
): Promise<RuntimeGardenComputeConfigView> {
  const rawPersisted = repo.getParsed(RUNTIME_GARDEN_COMPUTE_CONFIG_KEY, {
    parse: (value) => value
  });
  const configEnv = await loadConfigEnv(paths.envPath);
  const candidate = mergeGardenComputeRawWithEnv(rawPersisted, env, configEnv);
  return parseGardenComputeConfigWithLegacyFallback(candidate, "garden-compute config", warn);
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
  readonly repo?: ConfigRepo;
}>): Promise<GardenCredentialProvenance> {
  const persisted = input.repo?.getParsed(RUNTIME_GARDEN_COMPUTE_CONFIG_KEY, {
    parse: (value) => parseGardenComputeConfigWithLegacyFallback(value, "garden-compute config", () => undefined)
  });
  const configEnv = await loadConfigEnv(input.paths.envPath);
  const selected = selectEffectiveGardenSecretRef(input.env, configEnv, persisted?.secret_ref);
  if (selected === null) {
    return { kind: "none" };
  }
  return {
    kind: selected.embeddingFallback ? "embedding-fallback" : secretRefScheme(selected.ref) ?? "file"
  };
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
      event_kind: HealthEventKind.GARDEN_COMPUTE,
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

export type RuntimeGardenComputeConfigView = RuntimeGardenComputeConfig & {
  readonly degraded_reason?: string | null;
};

function parseGardenComputeConfigWithLegacyFallback(
  input: unknown,
  source: string,
  warn: (message: string) => void
): RuntimeGardenComputeConfigView {
  const normalizedInput = normalizeLegacyConfigVersion(input, CURRENT_CONFIG_VERSION);
  const direct = RuntimeGardenComputeConfigSchema.safeParse(normalizedInput);
  if (direct.success) {
    return direct.data;
  }
  const issues = direct.error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
  warn(
    `${source}: rejected by schema (${issues}); Garden compute is degraded until the config is repaired.`
  );
  // Do not rewrite to local_heuristics — that would look like an intentional
  // healthy provider choice. Keep official_api disabled with an explicit reason.
  return Object.freeze({
    ...RuntimeGardenComputeConfigSchema.parse({
      config_version: CURRENT_CONFIG_VERSION,
      secret_ref: null,
      enabled: false,
      provider_kind: "official_api",
      model_id: null,
      provider_url: null
    }),
    degraded_reason: "schema_invalid"
  });
}

function selectEffectiveGardenSecretRef(
  env: NodeJS.ProcessEnv,
  configEnv: ReadonlyMap<string, string>,
  persistedSecretRef?: string | null
) {
  return selectGardenSecretRef((key) => {
    const fromEnvOrFile = env[key] ?? configEnv.get(key);
    if (key === ALAYA_OFFICIAL_GARDEN_SECRET_REF_ENV) {
      return readNonEmptyEnv(fromEnvOrFile) ?? persistedSecretRef ?? undefined;
    }
    return fromEnvOrFile;
  });
}

function readGardenComputeEnvOverrides(
  env: NodeJS.ProcessEnv,
  configEnv: ReadonlyMap<string, string>,
  persistedSecretRef?: string | null
) {
  const readEnv = (key: string) => env[key] ?? configEnv.get(key);
  const declaredProviderKind = readNonEmptyEnv(readEnv(ALAYA_GARDEN_PROVIDER_KIND_ENV));
  const parsedProviderKind =
    declaredProviderKind === null ? null : RuntimeGardenProviderKindSchema.safeParse(declaredProviderKind);
  return {
    secretSelection: selectEffectiveGardenSecretRef(env, configEnv, persistedSecretRef),
    modelId: readNonEmptyEnv(readEnv(OFFICIAL_API_GARDEN_MODEL_ENV)),
    providerUrl: readNonEmptyEnv(readEnv(OFFICIAL_API_GARDEN_PROVIDER_URL_ENV)),
    declaredProviderKind,
    providerKind: parsedProviderKind?.success ? parsedProviderKind.data : null
  };
}

function mergeGardenComputeRawWithEnv(
  rawPersisted: unknown,
  env: NodeJS.ProcessEnv,
  configEnv: ReadonlyMap<string, string>
): unknown {
  if (rawPersisted === null) {
    return buildDefaultGardenComputeCandidate(env, configEnv);
  }
  if (typeof rawPersisted !== "object" || Array.isArray(rawPersisted)) {
    return rawPersisted;
  }
  const persisted = rawPersisted as Record<string, unknown>;
  const persistedSecretRef = typeof persisted.secret_ref === "string" ? persisted.secret_ref : undefined;
  const overrides = readGardenComputeEnvOverrides(env, configEnv, persistedSecretRef);
  return {
    ...persisted,
    ...(overrides.providerKind !== null ? { provider_kind: overrides.providerKind } : {}),
    ...(overrides.modelId !== null ? { model_id: overrides.modelId } : {}),
    ...(overrides.providerUrl !== null ? { provider_url: overrides.providerUrl } : {}),
    ...(overrides.secretSelection !== null ? { secret_ref: overrides.secretSelection.ref } : {})
  };
}

function buildDefaultGardenComputeCandidate(
  env: NodeJS.ProcessEnv,
  configEnv: ReadonlyMap<string, string>
) {
  const overrides = readGardenComputeEnvOverrides(env, configEnv);
  const secretRef = overrides.secretSelection?.ref ?? null;
  const providerKind =
    overrides.providerKind ??
    resolveProductGardenProviderKind(overrides.declaredProviderKind, secretRef !== null);
  return {
    config_version: CURRENT_CONFIG_VERSION,
    provider_kind: providerKind,
    model_id: overrides.modelId ?? OFFICIAL_API_GARDEN_MODEL,
    provider_url: overrides.providerUrl,
    secret_ref: secretRef,
    enabled: providerKind === "official_api" && secretRef !== null
  };
}

async function defaultRuntimeGardenComputeConfig(
  paths: AlayaConfigPaths,
  warn: (message: string) => void,
  env: NodeJS.ProcessEnv = processEnvLookup()
): Promise<RuntimeGardenComputeConfig> {
  const configEnv = await loadConfigEnv(paths.envPath);
  return parseGardenComputeConfigWithLegacyFallback(
    buildDefaultGardenComputeCandidate(env, configEnv),
    "garden-compute env defaults",
    warn
  );
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

function readConfigVersion(defaults: VersionedRuntimeConfig): number {
  return defaults.config_version ?? CURRENT_CONFIG_VERSION;
}
