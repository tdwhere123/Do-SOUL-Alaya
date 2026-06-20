import { randomUUID } from "node:crypto";
import { CoreError } from "@do-soul/alaya-core";
import {
  DEFAULT_ENVIRONMENT_CONFIG,
  DEFAULT_SOUL_CONFIG,
  DEFAULT_STRATEGY_CONFIG,
  EnvironmentConfigSchema,
  GardenEventType,
  HealthEventKind,
  ManifestationBudgetConfigSchema,
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
import type { ConfigRepo } from "@do-soul/alaya-storage";
import type { AlayaConfigPaths } from "../cli/config-files.js";
import type { GardenCredentialProvenance } from "../garden/index.js";
export type { GardenCredentialProvenance } from "../garden/index.js";
import {
  getGardenCredentialProvenance,
  getRuntimeEmbeddingConfig,
  getRuntimeGardenComputeConfig,
  patchRuntimeEmbeddingConfig,
  patchRuntimeGardenComputeConfig
} from "./config-service-runtime.js";
import {
  buildManifestationBudgetChangeSummary,
  defaultManifestationBudgetConfig
} from "./config-service-manifestation-support.js";

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

const MANIFESTATION_BUDGET_CONFIG_SECTION = "manifestation_budget";
const WORKSPACE_CONFIG_ENTITY_TYPE = "workspace_config";
const CURRENT_CONFIG_VERSION = DEFAULT_SOUL_CONFIG.config_version ?? 1;

type ConfigPatchObject = Record<string, unknown>;
type VersionedConfigObject = ConfigPatchObject & { readonly config_version?: number };

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
    ...createWorkspaceSectionConfigMethods(configRepo),
    ...createManifestationBudgetMethods(configRepo, eventPublisher, clock, generateAuditId),
    ...createRuntimeConfigMethods({
      configRepo,
      eventPublisher,
      configPathsProvider,
      clock,
      platform,
      generateTempId,
      generateAuditId,
      envProvider,
      warn
    })
  };
}

function createWorkspaceSectionConfigMethods(configRepo: ConfigRepo): Pick<
  AppConfigService,
  | "getSoulConfig"
  | "patchSoulConfig"
  | "getStrategyConfig"
  | "patchStrategyConfig"
  | "getEnvironmentConfig"
  | "patchEnvironmentConfig"
> {
  return {
    ...createSoulConfigMethods(configRepo),
    ...createStrategyConfigMethods(configRepo),
    ...createEnvironmentConfigMethods(configRepo)
  };
}

function createManifestationBudgetMethods(
  configRepo: ConfigRepo,
  eventPublisher: ConfigEventPublisher,
  clock: () => string,
  generateAuditId: () => string
): Pick<AppConfigService, "getManifestationBudgetConfig" | "patchManifestationBudgetConfig"> {
  return {
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
      })
  };
}

function createRuntimeConfigMethods(input: {
  readonly configRepo: ConfigRepo;
  readonly eventPublisher: ConfigEventPublisher;
  readonly configPathsProvider: () => AlayaConfigPaths;
  readonly clock: () => string;
  readonly platform: NodeJS.Platform;
  readonly generateTempId: () => string;
  readonly generateAuditId: () => string;
  readonly envProvider: () => NodeJS.ProcessEnv;
  readonly warn: (message: string) => void;
}): Pick<
  AppConfigService,
  | "getRuntimeEmbeddingConfig"
  | "patchRuntimeEmbeddingConfig"
  | "getGardenCredentialProvenance"
  | "getRuntimeGardenComputeConfig"
  | "patchRuntimeGardenComputeConfig"
> {
  return {
    ...createRuntimeConfigReadMethods(input),
    ...createRuntimeConfigPatchMethods(input)
  };
}

function keyFor(
  workspaceId: string,
  section: "soul" | "strategy" | "environment" | typeof MANIFESTATION_BUDGET_CONFIG_SECTION
): string {
  return `workspace:${workspaceId}:${section}`;
}

async function getSectionConfig<T extends VersionedConfigObject>(
  repo: ConfigRepo,
  key: string,
  schema: { parse(value: unknown): T },
  defaults: T
): Promise<T> {
  const version = readConfigVersion(defaults);
  return (
    repo.getParsed(key, {
      parse: (value) => schema.parse(normalizeLegacyConfigVersion(value, version))
    }) ?? schema.parse(defaults)
  );
}

async function patchSectionConfig<T extends VersionedConfigObject>(
  repo: ConfigRepo,
  key: string,
  fullSchema: {
    parse(value: unknown): T;
  },
  patchSchema: {
    safeParse(value: unknown):
      | { success: true; data: Partial<T> }
      | { success: false; error: unknown };
  },
  defaults: T,
  patch: unknown,
  validationMessage: string
): Promise<T> {
  const parsedPatch = patchSchema.safeParse(patch);
  if (!parsedPatch.success) {
    throw new CoreError("VALIDATION", validationMessage, { cause: parsedPatch.error });
  }

  return repo.patchParsed(
    key,
    withConfigVersion(parsedPatch.data, readConfigVersion(defaults)),
    defaults,
    {
      parse: (value) =>
        fullSchema.parse(normalizeLegacyConfigVersion(value, readConfigVersion(defaults)))
    }
  );
}

async function getManifestationBudgetConfig(
  repo: ConfigRepo,
  workspaceId: string,
  clock: () => string
): Promise<ManifestationBudgetConfigRead> {
  const stored = repo.getParsed(
    keyFor(workspaceId, MANIFESTATION_BUDGET_CONFIG_SECTION),
    ManifestationBudgetConfigSchema
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
  const patch = parseConfigPatchObject(input.patch, "Invalid manifestation budget config patch");
  const escalationPolicyPatch = parseOptionalConfigPatchObject(
    patch.escalation_policy,
    "Invalid manifestation budget config patch"
  );
  const occurredAt = parseIsoTimestamp(input.clock(), "Invalid manifestation budget config patch");
  const next = await buildNextManifestationBudgetConfig(input.repo, input.workspaceId, input.clock, patch, escalationPolicyPatch, occurredAt);
  const auditEntryId = input.generateAuditId();
  const configKey = keyFor(input.workspaceId, MANIFESTATION_BUDGET_CONFIG_SECTION);

  return await input.eventPublisher.appendManyWithMutation(
    [buildManifestationBudgetAuditEvent(input.workspaceId, configKey, patch, escalationPolicyPatch, occurredAt, auditEntryId)],
    () => {
      input.repo.setParsed(configKey, next, ManifestationBudgetConfigSchema);
      return next;
    }
  );
}

function createSoulConfigMethods(configRepo: ConfigRepo): Pick<AppConfigService, "getSoulConfig" | "patchSoulConfig"> {
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
      )
  };
}

function createStrategyConfigMethods(configRepo: ConfigRepo): Pick<AppConfigService, "getStrategyConfig" | "patchStrategyConfig"> {
  return {
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
      )
  };
}

function createEnvironmentConfigMethods(
  configRepo: ConfigRepo
): Pick<AppConfigService, "getEnvironmentConfig" | "patchEnvironmentConfig"> {
  return {
    getEnvironmentConfig: async (workspaceId) =>
      await getSectionConfig(configRepo, keyFor(workspaceId, "environment"), EnvironmentConfigSchema, DEFAULT_ENVIRONMENT_CONFIG),
    patchEnvironmentConfig: async (workspaceId, patch) =>
      await patchSectionConfig(
        configRepo,
        keyFor(workspaceId, "environment"),
        EnvironmentConfigSchema,
        EnvironmentConfigPatchSchema,
        DEFAULT_ENVIRONMENT_CONFIG,
        patch,
        "Invalid environment config patch"
      )
  };
}

function createRuntimeConfigReadMethods(input: {
  readonly configRepo: ConfigRepo;
  readonly configPathsProvider: () => AlayaConfigPaths;
  readonly envProvider: () => NodeJS.ProcessEnv;
  readonly warn: (message: string) => void;
}): Pick<
  AppConfigService,
  "getRuntimeEmbeddingConfig" | "getGardenCredentialProvenance" | "getRuntimeGardenComputeConfig"
> {
  return {
    getRuntimeEmbeddingConfig: async () => await getRuntimeEmbeddingConfig(input.configRepo),
    getGardenCredentialProvenance: async () =>
      await getGardenCredentialProvenance({
        paths: input.configPathsProvider(),
        env: input.envProvider()
      }),
    getRuntimeGardenComputeConfig: async () =>
      await getRuntimeGardenComputeConfig(input.configRepo, input.configPathsProvider(), input.warn)
  };
}

function createRuntimeConfigPatchMethods(input: {
  readonly configRepo: ConfigRepo;
  readonly eventPublisher: ConfigEventPublisher;
  readonly configPathsProvider: () => AlayaConfigPaths;
  readonly clock: () => string;
  readonly platform: NodeJS.Platform;
  readonly generateTempId: () => string;
  readonly generateAuditId: () => string;
  readonly warn: (message: string) => void;
}): Pick<AppConfigService, "patchRuntimeEmbeddingConfig" | "patchRuntimeGardenComputeConfig"> {
  return {
    patchRuntimeEmbeddingConfig: async (patch) =>
      await patchRuntimeEmbeddingConfig({
        repo: input.configRepo,
        eventPublisher: input.eventPublisher,
        paths: input.configPathsProvider(),
        patch,
        clock: input.clock,
        platform: input.platform,
        generateTempId: input.generateTempId,
        generateAuditId: input.generateAuditId
      }),
    patchRuntimeGardenComputeConfig: async (patch) =>
      await patchRuntimeGardenComputeConfig({
        repo: input.configRepo,
        eventPublisher: input.eventPublisher,
        paths: input.configPathsProvider(),
        patch,
        clock: input.clock,
        platform: input.platform,
        generateTempId: input.generateTempId,
        generateAuditId: input.generateAuditId,
        warn: input.warn
      })
  };
}

async function buildNextManifestationBudgetConfig(
  repo: ConfigRepo,
  workspaceId: string,
  clock: () => string,
  patch: ConfigPatchObject,
  escalationPolicyPatch: ConfigPatchObject,
  occurredAt: string
): Promise<ManifestationBudgetConfig> {
  const current = (await getManifestationBudgetConfig(repo, workspaceId, clock)).config;
  return ManifestationBudgetConfigSchema.parse({
    ...current,
    ...patch,
    workspace_id: workspaceId,
    escalation_policy: {
      ...current.escalation_policy,
      ...escalationPolicyPatch
    },
    updated_at: occurredAt
  });
}

function buildManifestationBudgetAuditEvent(
  workspaceId: string,
  configKey: string,
  patch: ConfigPatchObject,
  escalationPolicyPatch: ConfigPatchObject,
  occurredAt: string,
  auditEntryId: string
): Omit<EventLogEntry, "event_id" | "created_at" | "revision"> {
  return {
    event_type: GardenEventType.SOUL_HEALTH_JOURNAL_RECORDED,
    entity_type: WORKSPACE_CONFIG_ENTITY_TYPE,
    entity_id: configKey,
    workspace_id: workspaceId,
    run_id: null,
    caused_by: "inspector",
    payload_json: SoulHealthJournalRecordedPayloadSchema.parse({
      entry_id: auditEntryId,
      event_kind: HealthEventKind.RECALL_TUNING,
      workspace_id: workspaceId,
      occurred_at: occurredAt,
      change_summary: buildManifestationBudgetChangeSummary(patch, escalationPolicyPatch)
    })
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseConfigPatchObject(value: unknown, validationMessage: string): ConfigPatchObject {
  if (!isRecord(value)) {
    throw new CoreError("VALIDATION", validationMessage);
  }
  return value;
}

function parseOptionalConfigPatchObject(
  value: unknown,
  validationMessage: string
): ConfigPatchObject {
  return value === undefined ? {} : parseConfigPatchObject(value, validationMessage);
}

function readConfigVersion(defaults: VersionedConfigObject): number {
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

function withConfigVersion<T extends VersionedConfigObject>(
  patch: Partial<T>,
  configVersion: number
): Partial<T> {
  return {
    ...patch,
    config_version: configVersion
  };
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
