import { randomUUID } from "node:crypto";
import { CoreError } from "@do-soul/alaya-core";
import {
  DEFAULT_ENVIRONMENT_CONFIG,
  DEFAULT_SOUL_CONFIG,
  DEFAULT_STRATEGY_CONFIG,
  DYNAMICS_CONSTANTS,
  EnvironmentConfigSchema,
  HealthEventKind,
  GardenEventType,
  ManifestationBudgetConfigSchema,
  RuntimeGardenComputeConfigSchema,
  RuntimeGardenProviderKindSchema,
  RuntimeEmbeddingConfigSchema,
  secretRefScheme,
  SoulConfigSchema,
  SoulHealthJournalRecordedPayloadSchema,
  StrategyConfigSchema,
  type EnvironmentConfig,
  type EventLogEntry,
  type ManifestationBudgetConfig,
  type RuntimeGardenComputeConfig,
  type RuntimeEmbeddingConfig,
  type SoulConfig,
  type StrategyConfig
} from "@do-soul/alaya-protocol";
import { OFFICIAL_API_GARDEN_MODEL } from "@do-soul/alaya-soul";
import type { ConfigRepo } from "@do-soul/alaya-storage";
import {
  ALAYA_LEGACY_GARDEN_OPENAI_SECRET_REF_ENV,
  selectGardenCredentialProvenance,
  type GardenCredentialProvenance
} from "../garden-credential.js";
export type { GardenCredentialProvenance } from "../garden-credential.js";
import type { AlayaConfigPaths } from "../cli/config-files.js";
import {
  loadConfigEnv,
  readConfigEnvValue,
  readNonEmptyEnv
} from "../daemon-runtime-support.js";
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

export interface AppConfigService {
  getSoulConfig(workspaceId: string): Promise<SoulConfig>;
  patchSoulConfig(workspaceId: string, patch: unknown): Promise<SoulConfig>;
  getStrategyConfig(workspaceId: string): Promise<StrategyConfig>;
  patchStrategyConfig(workspaceId: string, patch: unknown): Promise<StrategyConfig>;
  getEnvironmentConfig(workspaceId: string): Promise<EnvironmentConfig>;
  patchEnvironmentConfig(workspaceId: string, patch: unknown): Promise<EnvironmentConfig>;
  getManifestationBudgetConfig(workspaceId: string): Promise<ManifestationBudgetConfigRead>;
  patchManifestationBudgetConfig(workspaceId: string, patch: unknown): Promise<ManifestationBudgetConfig>;
  getRuntimeEmbeddingConfig(): Promise<RuntimeEmbeddingConfig>;
  patchRuntimeEmbeddingConfig(patch: unknown): Promise<RuntimeEmbeddingConfig>;
  getGardenCredentialProvenance(): Promise<GardenCredentialProvenance>;
  getRuntimeGardenComputeConfig(): Promise<RuntimeGardenComputeConfig>;
  patchRuntimeGardenComputeConfig(patch: unknown): Promise<RuntimeGardenComputeConfig>;
}

export interface ManifestationBudgetConfigRead {
  readonly config: ManifestationBudgetConfig;
  readonly source: "default" | "stored";
}

interface ConfigEventPublisher {
  appendManyWithMutation<T>(
    eventInputs: readonly Omit<EventLogEntry, "event_id" | "created_at" | "revision">[],
    mutate: (entries: readonly EventLogEntry[]) => T
  ): Promise<T>;
}

const SoulConfigPatchSchema = SoulConfigSchema.unwrap().partial();
const StrategyConfigPatchSchema = StrategyConfigSchema.unwrap().partial();
const EnvironmentConfigPatchSchema = EnvironmentConfigSchema.unwrap().partial();

const RUNTIME_EMBEDDING_CONFIG_KEY = "runtime:embedding-supplement";
const RUNTIME_GARDEN_COMPUTE_CONFIG_KEY = "runtime:garden-compute";
const MANIFESTATION_BUDGET_CONFIG_SECTION = "manifestation_budget";
const RUNTIME_EMBEDDING_ENTITY_TYPE = "runtime_config";
const RUNTIME_EMBEDDING_ENTITY_ID = "runtime:embedding-supplement";
const RUNTIME_GARDEN_COMPUTE_ENTITY_ID = "runtime:garden-compute";
const RUNTIME_CONFIG_WORKSPACE_ID = "runtime";
const WORKSPACE_CONFIG_ENTITY_TYPE = "workspace_config";
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
const MANIFESTATION_BUDGET_CAP_FIELDS = [
  "stance_bias_cap",
  "dialogue_nudge_cap",
  "lens_entry_cap"
] as const;
const MANIFESTATION_ESCALATION_POLICY_FIELDS = [
  "nudge_min_pressure",
  "nudge_min_confidence",
  "lens_min_pressure",
  "lens_min_confidence",
  "lens_requires_task_coupling",
  "lens_requires_governance_ceiling"
] as const;

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
  readonly envProvider?: () => NodeJS.ProcessEnv;
  readonly warn?: (message: string) => void;
}): AppConfigService {
  const {
    configRepo,
    eventPublisher,
    configPathsProvider,
    clock = () => new Date().toISOString(),
    platform = process.platform,
    generateTempId = () => randomUUID(),
    generateAuditId = () => randomUUID(),
    envProvider = () => process.env,
    warn = (message) => {
      process.stderr.write(`${message}\n`);
    }
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
    getManifestationBudgetConfig: async (workspaceId) =>
      await getManifestationBudgetConfig(configRepo, workspaceId, clock),
    patchManifestationBudgetConfig: async (workspaceId, patch) =>
      await patchManifestationBudgetConfig({
        repo: configRepo,
        eventPublisher,
        workspaceId,
        patch,
        clock,
        generateAuditId
      }),
    getRuntimeEmbeddingConfig: async () => await getRuntimeEmbeddingConfig(configRepo),
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
      }),
    getGardenCredentialProvenance: async () =>
      await getGardenCredentialProvenance({
        paths: configPathsProvider(),
        env: envProvider()
      }),
    getRuntimeGardenComputeConfig: async () =>
      await getRuntimeGardenComputeConfig(configRepo, configPathsProvider(), warn),
    patchRuntimeGardenComputeConfig: async (patch) =>
      await patchRuntimeGardenComputeConfig({
        repo: configRepo,
        eventPublisher,
        paths: configPathsProvider(),
        patch,
        clock,
        platform,
        generateTempId,
        generateAuditId,
        warn
      })
  };
}

function keyFor(workspaceId: string, section: "soul" | "strategy" | "environment" | typeof MANIFESTATION_BUDGET_CONFIG_SECTION): string {
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
  return RuntimeEmbeddingConfigSchema.parse(
    (await repo.get<RuntimeEmbeddingConfig>(RUNTIME_EMBEDDING_CONFIG_KEY)) ??
      DEFAULT_RUNTIME_EMBEDDING_CONFIG
  );
}

async function getManifestationBudgetConfig(
  repo: ConfigRepo,
  workspaceId: string,
  clock: () => string
): Promise<ManifestationBudgetConfigRead> {
  const stored = await repo.get<ManifestationBudgetConfig>(
    keyFor(workspaceId, MANIFESTATION_BUDGET_CONFIG_SECTION)
  );
  return {
    config: ManifestationBudgetConfigSchema.parse(
      stored ?? defaultManifestationBudgetConfig(workspaceId, clock)
    ),
    source: stored === null ? "default" : "stored"
  };
}

async function patchManifestationBudgetConfig(input: {
  readonly repo: ConfigRepo;
  readonly eventPublisher: ConfigEventPublisher;
  readonly workspaceId: string;
  readonly patch: unknown;
  readonly clock: () => string;
  readonly generateAuditId: () => string;
}): Promise<ManifestationBudgetConfig> {
  const patch = asRecord(input.patch);
  const current = (
    await getManifestationBudgetConfig(input.repo, input.workspaceId, input.clock)
  ).config;
  const occurredAt = parseIsoTimestamp(input.clock(), "Invalid manifestation budget config patch");
  const next = ManifestationBudgetConfigSchema.parse({
    ...current,
    ...patch,
    workspace_id: input.workspaceId,
    escalation_policy: {
      ...current.escalation_policy,
      ...asRecord(patch.escalation_policy)
    },
    updated_at: occurredAt
  });
  const auditEntryId = input.generateAuditId();
  const configKey = keyFor(input.workspaceId, MANIFESTATION_BUDGET_CONFIG_SECTION);

  return await input.eventPublisher.appendManyWithMutation(
    [
      {
        event_type: GardenEventType.SOUL_HEALTH_JOURNAL_RECORDED,
        entity_type: WORKSPACE_CONFIG_ENTITY_TYPE,
        entity_id: configKey,
        workspace_id: input.workspaceId,
        run_id: null,
        caused_by: "inspector",
        payload_json: SoulHealthJournalRecordedPayloadSchema.parse({
          entry_id: auditEntryId,
          event_kind: HealthEventKind.RECALL_TUNING,
          workspace_id: input.workspaceId,
          occurred_at: occurredAt,
          change_summary: buildManifestationBudgetChangeSummary(patch)
        })
      }
    ],
    () => {
      input.repo.set(configKey, next);
      return next;
    }
  );
}

function defaultManifestationBudgetConfig(
  workspaceId: string,
  clock: () => string
): ManifestationBudgetConfig {
  return ManifestationBudgetConfigSchema.parse({
    workspace_id: workspaceId,
    stance_bias_cap: DYNAMICS_CONSTANTS.manifestation_budget.default_stance_bias_cap,
    dialogue_nudge_cap: DYNAMICS_CONSTANTS.manifestation_budget.default_dialogue_nudge_cap,
    lens_entry_cap: DYNAMICS_CONSTANTS.manifestation_budget.default_lens_entry_cap,
    escalation_policy: {
      nudge_min_pressure: DYNAMICS_CONSTANTS.manifestation_budget.default_nudge_min_pressure,
      nudge_min_confidence: DYNAMICS_CONSTANTS.manifestation_budget.default_nudge_min_confidence,
      lens_min_pressure: DYNAMICS_CONSTANTS.manifestation_budget.default_lens_min_pressure,
      lens_min_confidence: DYNAMICS_CONSTANTS.manifestation_budget.default_lens_min_confidence,
      lens_requires_task_coupling: true,
      lens_requires_governance_ceiling: true
    },
    updated_at: clock()
  });
}

function buildManifestationBudgetChangeSummary(patch: Record<string, unknown>): {
  readonly fields_changed: readonly string[];
} {
  const fieldsChanged = [
    ...MANIFESTATION_BUDGET_CAP_FIELDS.filter((field) => patch[field] !== undefined),
    ...MANIFESTATION_ESCALATION_POLICY_FIELDS
      .filter((field) => asRecord(patch.escalation_policy)[field] !== undefined)
      .map((field) => `escalation_policy.${field}`)
  ];
  return { fields_changed: fieldsChanged };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function getRuntimeGardenComputeConfig(
  repo: ConfigRepo,
  paths: AlayaConfigPaths,
  warn: (message: string) => void
): Promise<RuntimeGardenComputeConfig> {
  const persisted = await repo.get<RuntimeGardenComputeConfig>(RUNTIME_GARDEN_COMPUTE_CONFIG_KEY);
  const raw = persisted ?? (await defaultRuntimeGardenComputeConfig(paths, warn));
  return parseGardenComputeConfigWithLegacyFallback(raw, "garden-compute config", warn);
}

// Keep malformed rows from making runtime config unreadable. Keychain refs
// that are schema-compatible but operationally invalid are handled later by
// resolveSecretRef/doctor so this parser does not narrow the runtime config schema.
function parseGardenComputeConfigWithLegacyFallback(
  input: unknown,
  source: string,
  warn: (message: string) => void
): RuntimeGardenComputeConfig {
  const direct = RuntimeGardenComputeConfigSchema.safeParse(input);
  if (direct.success) {
    return direct.data;
  }
  const issues = direct.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ");
  warn(
    `${source}: rejected by schema (${issues}); dropping secret_ref and falling back to local_heuristics. ` +
      "Re-run `alaya install --keychain` (or fix the offending env/SQL value) to restore Garden compute."
  );
  const fallbackBase = isRecord(input) ? input : {};
  const fallback = {
    ...fallbackBase,
    secret_ref: null,
    enabled: false,
    provider_kind: "local_heuristics"
  };
  return RuntimeGardenComputeConfigSchema.parse(fallback);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

  // invariant: the FS write half of this operation (env file + optional
  // pasted secret) is genuinely async and cannot live inside a SQLite
  // transaction. The structure is:
  //
  //   1. applyRuntimeEmbeddingConfigFiles writes the FS files inside its
  //      cross-process lock and snapshots the previous content.
  //   2. The persist callback runs the atomic publish + sync SQL patch via
  //      EventPublisher.appendManyWithMutation. If publish/SQL throws inside
  //      this callback, applyRuntimeEmbeddingConfigFiles' built-in
  //      restore-on-throw cleans up the FS files atomically with the
  //      EventLog rollback. End-state: behaves as a single transaction
  //      across FS + EventLog + SQL even though FS is not part of the
  //      SQLite transaction itself.
  //
  // This preserves the prior FS/SQL rollback contract while closing BL-022
  // for the runtime-config SQL row.
  return await applyRuntimeEmbeddingConfigFiles({
    paths: input.paths,
    normalized,
    generateTempId: input.generateTempId,
    persist: async () =>
      await input.eventPublisher.appendManyWithMutation(
        [
          {
            event_type: GardenEventType.SOUL_HEALTH_JOURNAL_RECORDED,
            entity_type: RUNTIME_EMBEDDING_ENTITY_TYPE,
            entity_id: RUNTIME_EMBEDDING_ENTITY_ID,
            workspace_id: RUNTIME_CONFIG_WORKSPACE_ID,
            run_id: null,
            caused_by: "inspector",
            payload_json: SoulHealthJournalRecordedPayloadSchema.parse({
              entry_id: auditEntryId,
              event_kind: HealthEventKind.EMBEDDING_SUPPLEMENT,
              workspace_id: RUNTIME_CONFIG_WORKSPACE_ID,
              occurred_at: occurredAt,
              change_summary: buildRuntimeEmbeddingChangeSummary(normalized)
            })
          }
        ],
        () => {
          const next = input.repo.patch(
            RUNTIME_EMBEDDING_CONFIG_KEY,
            normalized.patch,
            DEFAULT_RUNTIME_EMBEDDING_CONFIG
          );
          return RuntimeEmbeddingConfigSchema.parse(next);
        }
      )
  });
}

function buildRuntimeEmbeddingChangeSummary(normalized: NormalizedRuntimeEmbeddingConfigPatch): {
  readonly fields_changed: readonly string[];
  readonly secret_ref_kind?: "env" | "file" | "keychain" | null;
} {
  const fieldsChanged = RUNTIME_EMBEDDING_CONFIG_FIELDS.filter((field) => normalized.patch[field] !== undefined);
  return {
    fields_changed: fieldsChanged,
    ...(normalized.patch.secret_ref !== undefined ? { secret_ref_kind: (normalized.patch.secret_ref === null ? null : secretRefScheme(normalized.patch.secret_ref)) } : {})
  };
}

async function patchRuntimeGardenComputeConfig(input: {
  readonly repo: ConfigRepo;
  readonly eventPublisher: ConfigEventPublisher;
  readonly paths: AlayaConfigPaths;
  readonly patch: unknown;
  readonly clock: () => string;
  readonly platform: NodeJS.Platform;
  readonly generateTempId: () => string;
  readonly generateAuditId: () => string;
  readonly warn: (message: string) => void;
}): Promise<RuntimeGardenComputeConfig> {
  const normalized = normalizeRuntimeGardenComputeConfigPatch(input.patch, input.paths, input.platform);
  const occurredAt = parseIsoTimestamp(input.clock(), "Invalid runtime garden compute config patch");
  const auditEntryId = input.generateAuditId();
  const defaults = await defaultRuntimeGardenComputeConfig(input.paths, input.warn);

  return await applyRuntimeGardenComputeConfigFiles({
    paths: input.paths,
    normalized,
    generateTempId: input.generateTempId,
    persist: async () =>
      await input.eventPublisher.appendManyWithMutation(
        [
          {
            event_type: GardenEventType.SOUL_HEALTH_JOURNAL_RECORDED,
            entity_type: RUNTIME_EMBEDDING_ENTITY_TYPE,
            entity_id: RUNTIME_GARDEN_COMPUTE_ENTITY_ID,
            workspace_id: RUNTIME_CONFIG_WORKSPACE_ID,
            run_id: null,
            caused_by: "inspector",
            payload_json: SoulHealthJournalRecordedPayloadSchema.parse({
              entry_id: auditEntryId,
              event_kind: HealthEventKind.EMBEDDING_SUPPLEMENT,
              workspace_id: RUNTIME_CONFIG_WORKSPACE_ID,
              occurred_at: occurredAt,
              change_summary: buildRuntimeGardenComputeChangeSummary(normalized)
            })
          }
        ],
        () => {
          const next = input.repo.patch(
            RUNTIME_GARDEN_COMPUTE_CONFIG_KEY,
            normalized.patch,
            defaults
          );
          // Route through the same malformed-row fallback the read path uses
          // so an Inspector patch never throws inside the EventLog mutation
          // because of an unreadable runtime config row.
          return parseGardenComputeConfigWithLegacyFallback(next, "garden-compute config patch", input.warn);
        }
      )
  });
}

function buildRuntimeGardenComputeChangeSummary(normalized: NormalizedRuntimeGardenComputeConfigPatch): {
  readonly fields_changed: readonly string[];
  readonly secret_ref_kind?: "env" | "file" | "keychain" | null;
  readonly provider_url?: string | null;
  readonly model_id?: string | null;
} {
  const fieldsChanged = RUNTIME_GARDEN_COMPUTE_CONFIG_FIELDS.filter((field) => normalized.patch[field] !== undefined);
  return {
    fields_changed: fieldsChanged,
    ...(normalized.patch.secret_ref !== undefined ? { secret_ref_kind: (normalized.patch.secret_ref === null ? null : secretRefScheme(normalized.patch.secret_ref)) } : {}),
    ...(normalized.patch.provider_url !== undefined ? { provider_url: normalized.patch.provider_url } : {}),
    ...(normalized.patch.model_id !== undefined ? { model_id: normalized.patch.model_id } : {})
  };
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
  const modelId = readNonEmptyEnv(readConfigEnvValue(configEnv, OFFICIAL_API_GARDEN_MODEL_ENV)) ?? OFFICIAL_API_GARDEN_MODEL;
  // An explicit ALAYA_GARDEN_PROVIDER_KIND wins over secret-presence inference;
  // it is the only way a non-Inspector setup can request host_worker. An
  // unrecognized value falls back to inference rather than crashing boot.
  const declaredProviderKind = RuntimeGardenProviderKindSchema.safeParse(
    readNonEmptyEnv(readConfigEnvValue(configEnv, ALAYA_GARDEN_PROVIDER_KIND_ENV))
  );
  const providerKind = declaredProviderKind.success
    ? declaredProviderKind.data
    : secretRef === null
      ? "local_heuristics"
      : "official_api";

  return parseGardenComputeConfigWithLegacyFallback(
    {
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


async function getGardenCredentialProvenance(input: {
  readonly paths: AlayaConfigPaths;
  readonly env: NodeJS.ProcessEnv;
}): Promise<GardenCredentialProvenance> {
  const configEnv = await loadConfigEnv(input.paths.envPath);
  return selectGardenCredentialProvenance({
    env: input.env,
    configEnv
  });
}

function parseIsoTimestamp(value: string, validationMessage = "Invalid runtime embedding config patch"): string {
  if (Number.isNaN(Date.parse(value))) {
    throw new CoreError("VALIDATION", validationMessage);
  }
  return value;
}
